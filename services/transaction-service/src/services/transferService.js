'use strict';

// Transfer lifecycle (docs/contracts.md §2.3). Every money movement commits in one MongoDB
// transaction together with the status change that causes it (§2.1), and every status change
// goes through applyTransition(), which enforces the state machine.

const { randomUUID } = require('node:crypto');
const { AppError } = require('../errors');
const { toCents, fromCents } = require('../money');
const { TERMINAL, effectsFor } = require('../domain/stateMachine');
const { WalletError } = require('../models/walletRepository');
const { requestHash, isDuplicateKey } = require('../models/idempotencyRepository');
const { EXCHANGES, FLAGGED } = require('../queue/topology');

const TXN_OPTIONS = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };

/** Neutral vector for transfers without features (contract §0.8): PCA mean, time of day. */
function neutralFeatures(now, amount) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const features = { Time: Math.floor((now.getTime() - midnight) / 1000) };
  for (let i = 1; i <= 28; i += 1) features[`V${i}`] = 0;
  features.Amount = amount;
  return features;
}

/** The stored quickScan record. An unavailable scan counts as flagged (fail toward review, §9). */
function toQuickScanRecord(scan, scoredAt) {
  if (!scan.available) {
    return {
      score: null,
      threshold: null,
      flagged: true,
      reason: 'QUICK_SCAN_UNAVAILABLE',
      modelVersion: null,
      scoredAt,
    };
  }
  return {
    score: scan.score,
    threshold: scan.threshold,
    flagged: scan.flagged,
    reason: scan.flagged ? 'ANOMALY' : 'NORMAL',
    modelVersion: scan.modelVersion,
    scoredAt,
  };
}

function flaggedEnvelope(tx, quickScan, at) {
  return {
    eventId: randomUUID(),
    eventType: 'transaction.flagged',
    version: 1,
    idempotencyKey: `${tx._id}:flagged`,
    occurredAt: at.toISOString(),
    producer: 'transaction-service',
    payload: {
      transactionId: tx._id,
      userId: tx.userId,
      recipientId: tx.recipientId,
      amount: fromCents(tx.amountCents),
      currency: tx.currency,
      features: tx.features,
      quickScan: {
        score: quickScan.score,
        threshold: quickScan.threshold,
        flagged: quickScan.flagged,
        reason: quickScan.reason,
        modelVersion: quickScan.modelVersion,
      },
      createdAt: tx.createdAt.toISOString(),
    },
  };
}

class TransferService {
  constructor({ mongoClient, wallets, transactions, idempotency, lookupUser, quickScan, publisher, metrics, logger }) {
    Object.assign(this, { mongoClient, wallets, transactions, idempotency, lookupUser, quickScan, publisher });
    Object.assign(this, { metrics, logger });
  }

  async #inTransaction(fn) {
    const session = this.mongoClient.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn(session);
      }, TXN_OPTIONS);
      return result;
    } finally {
      await session.endSession();
    }
  }

  async deposit(userId, amount) {
    try {
      return await this.wallets.deposit(userId, toCents(amount));
    } catch (err) {
      if (err instanceof WalletError && err.code === 'WALLET_FROZEN') {
        throw new AppError(423, 'ACCOUNT_FROZEN', 'Account is frozen');
      }
      throw err;
    }
  }

  /**
   * POST /transactions. Returns { status: 201|200, replayed, transaction }.
   * Steps: idempotency + hold + insert (one DB transaction) -> quick-scan -> approve or flag.
   */
  async createTransfer({ user, idempotencyKey, body, requestId }) {
    const hash = requestHash(body);
    const existing = await this.idempotency.find(user.id, idempotencyKey);
    if (existing) return this.#replay(existing, hash);

    const recipient = await this.lookupUser(body.recipientEmail, { requestId });
    if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'No user with that email');
    if (recipient.id === user.id) {
      throw AppError.badRequest('Cannot transfer to yourself', [{ field: 'recipientEmail', issue: 'is the sender' }]);
    }

    const now = new Date();
    const cents = toCents(body.amount);
    const doc = {
      _id: randomUUID(),
      userId: user.id,
      recipientId: recipient.id,
      amountCents: cents,
      currency: 'USD',
      description: body.description ?? null,
      // Amount is always the transfer amount, whatever the client sent (contract §0.8).
      features: body.features ? { ...body.features, Amount: body.amount } : neutralFeatures(now, body.amount),
      status: 'PENDING',
      riskScore: null,
      riskTier: null,
      quickScan: null,
      deepScan: null,
      action: null,
      statusHistory: [{ status: 'PENDING', at: now, source: 'transaction-service', reason: null }],
      idempotencyKey,
      outbox: null,
      createdAt: now,
      updatedAt: now,
      finalizedAt: null,
    };

    try {
      await this.#inTransaction(async (session) => {
        await this.idempotency.insert(
          { userId: user.id, key: idempotencyKey, hash, transactionId: doc._id },
          { session },
        );
        await this.wallets.hold(user.id, cents, { session });
        await this.transactions.insert(doc, { session });
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        // A concurrent request with the same key committed first.
        return this.#replay(await this.idempotency.find(user.id, idempotencyKey), hash);
      }
      if (err instanceof WalletError && err.code === 'WALLET_FROZEN') {
        throw new AppError(423, 'ACCOUNT_FROZEN', 'Account is frozen');
      }
      if (err instanceof WalletError && err.code === 'INSUFFICIENT_FUNDS') {
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
      }
      throw err;
    }

    const scan = await this.quickScan({ transactionId: doc._id, features: doc.features, requestId });
    const quickScan = toQuickScanRecord(scan, new Date());
    let final;
    if (quickScan.reason === 'NORMAL') {
      final = await this.applyTransition(doc._id, 'APPROVED', {
        set: { quickScan, riskTier: 'LOW', riskScore: null, action: 'NONE' },
        source: 'transaction-service',
        reason: 'quick-scan: normal',
      });
    } else {
      if (!scan.available) this.logger.warn({ transactionId: doc._id, error: scan.error }, 'quick-scan unavailable');
      final = await this.flagForReview(doc._id, quickScan, {
        reason: scan.available ? 'quick-scan: anomaly' : `quick-scan unavailable (${scan.error})`,
        requestId,
      });
    }
    this.metrics.transactionsCreated.inc({ status: final.status });
    return { status: 201, replayed: false, transaction: final };
  }

  async #replay(record, hash) {
    if (record.requestHash !== hash) {
      throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
    const transaction = await this.transactions.findById(record.transactionId);
    return { status: 200, replayed: true, transaction };
  }

  /** PENDING -> UNDER_REVIEW with a transactional outbox entry, then publish (contract §3.3). */
  async flagForReview(id, quickScan, { reason, requestId }) {
    const tx = await this.applyTransition(id, 'UNDER_REVIEW', {
      set: { quickScan },
      source: 'transaction-service',
      reason,
      outbox: (current, at) => ({
        eventId: null, // replaced below with the envelope's id
        envelope: flaggedEnvelope(current, quickScan, at),
        requestId: requestId ?? null,
        createdAt: at,
        publishedAt: null,
        attempts: 0,
      }),
    });
    if (tx.outbox?.publishedAt === null) await this.publishOutbox(tx);
    return tx;
  }

  /** Publish a transaction's outbox event; on failure leave it for the relay. Never throws. */
  async publishOutbox(tx) {
    const { envelope, requestId } = tx.outbox;
    try {
      await this.publisher.publish(EXCHANGES.events, FLAGGED.routingKey, envelope, {
        requestId,
        correlationId: tx._id,
      });
      await this.transactions.markPublished(tx._id, envelope.eventId);
      this.metrics.queuePublish.inc({ result: 'ok' });
      return true;
    } catch (err) {
      this.metrics.queuePublish.inc({ result: 'failed' });
      this.logger.warn({ transactionId: tx._id, err: err.message }, 'publish failed; outbox relay will retry');
      await this.transactions.recordPublishFailure(tx._id, envelope.eventId, err.message).catch(() => {});
      return false;
    }
  }

  /**
   * The only way a status changes. Idempotent: moving to the current status is a no-op.
   * Money effects and the status update commit together or not at all.
   */
  async applyTransition(id, to, { set = {}, source, reason = null, outbox = null }) {
    let outcome;
    try {
      outcome = await this.#inTransaction(async (session) => {
        const tx = await this.transactions.findById(id, { session });
        if (!tx) throw AppError.notFound('Transaction not found');
        if (tx.status === to) return { tx, changed: false };

        const effects = effectsFor(tx.status, to);
        if (!effects) {
          throw AppError.conflict('INVALID_TRANSITION', `Cannot change status from ${tx.status} to ${to}`);
        }
        for (const effect of effects) {
          if (effect === 'settle') await this.wallets.settle(tx.userId, tx.recipientId, tx.amountCents, { session });
          if (effect === 'release') await this.wallets.release(tx.userId, tx.amountCents, { session });
          if (effect === 'freeze') {
            await this.wallets.setFrozen(tx.userId, true, `transaction ${id} escalated to manual review`, { session });
          }
          if (effect === 'unfreeze') await this.wallets.setFrozen(tx.userId, false, null, { session });
        }

        const at = new Date();
        const fields = { ...stripUndefined(set), status: to };
        if (TERMINAL.has(to)) fields.finalizedAt = at;
        if (outbox) {
          const entry = outbox({ ...tx, ...fields }, at);
          fields.outbox = { ...entry, eventId: entry.envelope.eventId };
        }
        const updated = await this.transactions.updateStatus(
          id,
          tx.status,
          { set: fields, historyEntry: { status: to, at, source, reason } },
          { session },
        );
        // Inside a snapshot transaction a concurrent writer causes a WriteConflict (retried by
        // withTransaction), so a miss here means the document changed in an unexpected way.
        if (!updated) throw AppError.conflict('CONCURRENT_UPDATE', 'Transaction changed concurrently');
        return { tx: updated, changed: true, from: tx.status };
      });
    } catch (err) {
      if (err instanceof WalletError) {
        this.logger.error({ transactionId: id, to, err: err.message }, 'wallet invariant violated; transition aborted');
        throw new Error(`wallet invariant violated for transaction ${id}`, { cause: err });
      }
      throw err;
    }
    if (outcome.changed) this.metrics.statusTransitions.inc({ from: outcome.from, to });
    return outcome.tx;
  }

  async unfreeze(userId) {
    const wallet = await this.wallets.setFrozen(userId, false, null);
    if (!wallet) throw AppError.notFound('Wallet not found');
    return wallet;
  }
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? stripUndefined(v) : v;
  }
  return out;
}

module.exports = { TransferService, neutralFeatures, flaggedEnvelope, toQuickScanRecord };
