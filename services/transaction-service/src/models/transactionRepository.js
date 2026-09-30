'use strict';

// Transaction data access (docs/contracts.md §2.2). Documents are validated before insert,
// and status changes are conditional on the expected current status.

const { z } = require('zod');
const { fromCents } = require('../money');
const { STATUSES } = require('../domain/stateMachine');
const { featuresSchema } = require('../validation/schemas');

const quickScanSchema = z.strictObject({
  score: z.number().nullable(),
  threshold: z.number().nullable(),
  flagged: z.boolean(),
  reason: z.enum(['NORMAL', 'ANOMALY', 'QUICK_SCAN_UNAVAILABLE']),
  modelVersion: z.string().nullable(),
  scoredAt: z.date(),
});

const historyEntrySchema = z.strictObject({
  status: z.enum(STATUSES),
  at: z.date(),
  source: z.enum(['transaction-service', 'alerting-service', 'admin', 'otp']),
  reason: z.string().nullable(),
});

const newTransactionSchema = z.strictObject({
  _id: z.uuid(),
  userId: z.uuid(),
  recipientId: z.uuid(),
  amountCents: z.number().int().positive(),
  currency: z.literal('USD'),
  description: z.string().max(140).nullable(),
  features: featuresSchema,
  status: z.literal('PENDING'),
  riskScore: z.null(),
  riskTier: z.null(),
  quickScan: z.null(),
  deepScan: z.null(),
  action: z.null(),
  statusHistory: z.array(historyEntrySchema).length(1),
  idempotencyKey: z.string(),
  outbox: z.null(),
  createdAt: z.date(),
  updatedAt: z.date(),
  finalizedAt: z.null(),
});

const iso = (d) => (d ? d.toISOString() : null);

/** API representation (contract §2.2): major units, ISO timestamps, no storage-only fields. */
function toPublicTransaction(doc) {
  return {
    id: doc._id,
    userId: doc.userId,
    recipientId: doc.recipientId,
    amount: fromCents(doc.amountCents),
    currency: doc.currency,
    description: doc.description,
    features: doc.features,
    status: doc.status,
    riskScore: doc.riskScore,
    riskTier: doc.riskTier,
    quickScan: doc.quickScan ? { ...doc.quickScan, scoredAt: iso(doc.quickScan.scoredAt) } : null,
    deepScan: doc.deepScan,
    action: doc.action,
    statusHistory: doc.statusHistory.map((h) => ({ ...h, at: iso(h.at) })),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    finalizedAt: iso(doc.finalizedAt),
  };
}

function encodeCursor(doc) {
  return Buffer.from(`${doc.createdAt.getTime()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(Number(ms));
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

class TransactionRepository {
  constructor(db) {
    this.collection = db.collection('transactions');
  }

  async ensureIndexes() {
    await this.collection.createIndexes([
      { key: { userId: 1, createdAt: -1, _id: -1 }, name: 'user_recent' },
      { key: { status: 1, createdAt: 1 }, name: 'status_age' },
      {
        key: { 'outbox.publishedAt': 1, 'outbox.createdAt': 1 },
        name: 'outbox_unpublished',
        partialFilterExpression: { 'outbox.publishedAt': null, 'outbox.eventId': { $exists: true } },
      },
    ]);
  }

  async insert(doc, { session } = {}) {
    const valid = newTransactionSchema.parse(doc);
    await this.collection.insertOne(valid, { session });
    return valid;
  }

  async findById(id, { session } = {}) {
    return this.collection.findOne({ _id: id }, { session });
  }

  /**
   * Apply a status change only if the document is still in `fromStatus`.
   * Returns the updated document, or null if someone else changed it first.
   */
  async updateStatus(id, fromStatus, { set, historyEntry }, { session } = {}) {
    historyEntrySchema.parse(historyEntry);
    if (set.quickScan) quickScanSchema.parse(set.quickScan);
    return this.collection.findOneAndUpdate(
      { _id: id, status: fromStatus },
      { $set: { ...set, updatedAt: historyEntry.at }, $push: { statusHistory: historyEntry } },
      { returnDocument: 'after', session },
    );
  }

  async listForUser(userId, { limit, cursor, status }) {
    const filter = { userId };
    if (status) filter.status = status;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (!c) return null;
      filter.$or = [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c.id } }];
    }
    const docs = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = docs.slice(0, limit);
    return { items: page, nextCursor: docs.length > limit ? encodeCursor(page[page.length - 1]) : null };
  }

  async markPublished(id, eventId) {
    await this.collection.updateOne(
      { _id: id, 'outbox.eventId': eventId },
      { $set: { 'outbox.publishedAt': new Date() }, $inc: { 'outbox.attempts': 1 } },
    );
  }

  async recordPublishFailure(id, eventId, error) {
    await this.collection.updateOne(
      { _id: id, 'outbox.eventId': eventId },
      { $inc: { 'outbox.attempts': 1 }, $set: { 'outbox.lastError': String(error).slice(0, 300) } },
    );
  }

  /** Unpublished outbox events older than `olderThan` (younger ones are still being published inline). */
  async findUnpublished(olderThan, limit = 100) {
    return this.collection
      .find({ 'outbox.publishedAt': null, 'outbox.eventId': { $exists: true }, 'outbox.createdAt': { $lt: olderThan } })
      .sort({ 'outbox.createdAt': 1 })
      .limit(limit)
      .toArray();
  }

  async findStalePending(olderThan, limit = 100) {
    return this.collection
      .find({ status: 'PENDING', createdAt: { $lt: olderThan } })
      .limit(limit)
      .toArray();
  }

  async countOutboxPending() {
    return this.collection.countDocuments({ 'outbox.publishedAt': null, 'outbox.eventId': { $exists: true } });
  }

  async countByStatus(status) {
    return this.collection.countDocuments({ status });
  }
}

module.exports = { TransactionRepository, toPublicTransaction };
