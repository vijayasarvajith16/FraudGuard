'use strict';

// Data access for fraudguard_alerts (docs/contracts.md §7). Every write triggered by a queue
// message is create-if-absent with an id derived from the transaction, so reprocessing a
// message (redelivery, retry) never duplicates an alert, OTP challenge or review case.

const { randomUUID } = require('node:crypto');

const PROCESSED_EVENTS_TTL_SECONDS = 7 * 24 * 60 * 60;
const iso = (d) => (d ? d.toISOString() : null);

function encodeCursor(doc) {
  return Buffer.from(`${doc.createdAt.getTime()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  const [ms, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(Number(ms));
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

class AlertRepository {
  constructor(db) {
    this.collection = db.collection('alerts');
  }

  async ensureIndexes() {
    await this.collection.createIndex({ userId: 1, visible: 1, createdAt: -1, _id: -1 }, { name: 'user_feed' });
  }

  /** One alert per (transaction, kind). Returns true if it was newly created. */
  async createOnce({ transactionId, kind, userId, riskTier, action, message, simulatedOtp = null, visible }) {
    const now = new Date();
    const res = await this.collection.updateOne(
      { _id: `${transactionId}:${kind}` },
      {
        $setOnInsert: {
          userId,
          transactionId,
          kind,
          riskTier,
          action,
          channel: visible ? 'SIMULATED' : 'LOG',
          message,
          simulatedOtp,
          visible,
          read: false,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    return res.upsertedCount === 1;
  }

  async listVisible(userId, { limit, cursor }) {
    const filter = { userId, visible: true };
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
}

function toPublicAlert(doc) {
  const alert = {
    id: doc._id,
    userId: doc.userId,
    transactionId: doc.transactionId,
    riskTier: doc.riskTier,
    action: doc.action,
    channel: doc.channel,
    message: doc.message,
    read: doc.read,
    createdAt: iso(doc.createdAt),
  };
  if (doc.simulatedOtp) alert.simulatedOtp = doc.simulatedOtp;
  return alert;
}

class OtpRepository {
  constructor(db) {
    this.collection = db.collection('otp_challenges');
  }

  async ensureIndexes() {
    await this.collection.createIndex({ status: 1, expiresAt: 1 }, { name: 'open_by_expiry' });
  }

  /** Create the challenge for a transaction if none exists. Returns the stored challenge. */
  async createOnce({ transactionId, userId, amount, riskTier, codeHash, expiresAt, maxAttempts }) {
    await this.collection.updateOne(
      { _id: transactionId },
      {
        $setOnInsert: {
          userId,
          amount,
          riskTier,
          codeHash,
          expiresAt,
          attemptsRemaining: maxAttempts,
          status: 'OPEN',
          createdAt: new Date(),
          resolvedAt: null,
        },
      },
      { upsert: true },
    );
    return this.collection.findOne({ _id: transactionId });
  }

  async findForUser(transactionId, userId) {
    return this.collection.findOne({ _id: transactionId, userId });
  }

  /** Atomically consume one attempt of an open, unexpired challenge. Null if none left. */
  async consumeAttempt(transactionId) {
    return this.collection.findOneAndUpdate(
      { _id: transactionId, status: 'OPEN', attemptsRemaining: { $gt: 0 }, expiresAt: { $gt: new Date() } },
      { $inc: { attemptsRemaining: -1 } },
      { returnDocument: 'after' },
    );
  }

  async resolve(transactionId, status) {
    return this.collection.findOneAndUpdate(
      { _id: transactionId, status: 'OPEN' },
      { $set: { status, resolvedAt: new Date() } },
      { returnDocument: 'after' },
    );
  }

  /** Open challenges that can no longer succeed: expired or out of attempts. */
  async findStale(limit = 100) {
    return this.collection
      .find({ status: 'OPEN', $or: [{ expiresAt: { $lte: new Date() } }, { attemptsRemaining: { $lte: 0 } }] })
      .limit(limit)
      .toArray();
  }
}

class ReviewRepository {
  constructor(db) {
    this.collection = db.collection('review_cases');
  }

  async ensureIndexes() {
    await this.collection.createIndexes([
      { key: { transactionId: 1 }, name: 'uniq_transaction', unique: true },
      { key: { status: 1, createdAt: 1 }, name: 'queue' },
    ]);
  }

  async createOnce({ transactionId, userId, riskScore, riskTier, amount }) {
    await this.collection.updateOne(
      { transactionId },
      {
        $setOnInsert: {
          _id: randomUUID(),
          userId,
          riskScore,
          riskTier,
          amount,
          status: 'OPEN',
          decision: null,
          decidedBy: null,
          note: null,
          createdAt: new Date(),
          resolvedAt: null,
        },
      },
      { upsert: true },
    );
  }

  async findById(id) {
    return this.collection.findOne({ _id: id });
  }

  async list(status, limit = 100) {
    return this.collection
      .find(status ? { status } : {})
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async resolve(id, { decision, decidedBy, note }) {
    return this.collection.findOneAndUpdate(
      { _id: id, status: 'OPEN' },
      { $set: { status: 'RESOLVED', decision, decidedBy, note: note ?? null, resolvedAt: new Date() } },
      { returnDocument: 'after' },
    );
  }

  async countOpen() {
    return this.collection.countDocuments({ status: 'OPEN' });
  }
}

function toPublicReview(doc) {
  return {
    id: doc._id,
    transactionId: doc.transactionId,
    userId: doc.userId,
    riskScore: doc.riskScore,
    riskTier: doc.riskTier,
    amount: doc.amount,
    status: doc.status,
    decision: doc.decision,
    decidedBy: doc.decidedBy,
    note: doc.note,
    createdAt: iso(doc.createdAt),
    resolvedAt: iso(doc.resolvedAt),
  };
}

class ProcessedEventRepository {
  constructor(db) {
    this.collection = db.collection('processed_events');
  }

  async ensureIndexes() {
    await this.collection.createIndex(
      { processedAt: 1 },
      { expireAfterSeconds: PROCESSED_EVENTS_TTL_SECONDS, name: 'ttl_7d' },
    );
  }

  async has(idempotencyKey) {
    return (await this.collection.countDocuments({ _id: idempotencyKey }, { limit: 1 })) > 0;
  }

  async record(idempotencyKey, transactionId, outcome) {
    await this.collection.updateOne(
      { _id: idempotencyKey },
      { $setOnInsert: { transactionId, outcome, processedAt: new Date() } },
      { upsert: true },
    );
  }
}

module.exports = {
  AlertRepository,
  OtpRepository,
  ReviewRepository,
  ProcessedEventRepository,
  toPublicAlert,
  toPublicReview,
};
