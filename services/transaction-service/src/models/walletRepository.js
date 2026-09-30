'use strict';

// Wallet data access (docs/contracts.md §2.1). Every mutation is one guarded single-document
// update; callers pass a session so money movement commits atomically with the status change.

const { fromCents } = require('../money');

const DUPLICATE_KEY = 11000;

class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code; // WALLET_FROZEN | INSUFFICIENT_FUNDS | INVARIANT_VIOLATION
  }
}

function newWalletFields(now) {
  return { heldCents: 0, currency: 'USD', frozen: false, frozenReason: null, createdAt: now };
}

function toPublicWallet(doc, userId) {
  const w = doc || { _id: userId, balanceCents: 0, heldCents: 0, currency: 'USD', frozen: false, updatedAt: null };
  return {
    userId: w._id,
    balance: fromCents(w.balanceCents),
    held: fromCents(w.heldCents),
    currency: w.currency,
    frozen: w.frozen,
    updatedAt: w.updatedAt ? w.updatedAt.toISOString() : null,
  };
}

class WalletRepository {
  constructor(db) {
    this.collection = db.collection('wallets');
  }

  async findById(userId, { session } = {}) {
    return this.collection.findOne({ _id: userId }, { session });
  }

  /** Add funds. Fails with WALLET_FROZEN for a frozen wallet; creates the wallet if needed. */
  async deposit(userId, cents, { session } = {}) {
    const now = new Date();
    try {
      return await this.collection.findOneAndUpdate(
        { _id: userId, frozen: { $ne: true } },
        {
          $inc: { balanceCents: cents },
          $set: { updatedAt: now },
          $setOnInsert: newWalletFields(now),
        },
        { upsert: true, returnDocument: 'after', session },
      );
    } catch (err) {
      // The filter excluded a frozen wallet, so the upsert collided with its _id.
      if (err.code === DUPLICATE_KEY) throw new WalletError('WALLET_FROZEN', 'Wallet is frozen');
      throw err;
    }
  }

  /** Move cents from balance to held (a transfer under way). */
  async hold(userId, cents, { session } = {}) {
    const res = await this.collection.updateOne(
      { _id: userId, frozen: { $ne: true }, balanceCents: { $gte: cents } },
      { $inc: { balanceCents: -cents, heldCents: cents }, $set: { updatedAt: new Date() } },
      { session },
    );
    if (res.modifiedCount === 1) return;
    const wallet = await this.findById(userId, { session });
    if (wallet?.frozen) throw new WalletError('WALLET_FROZEN', 'Wallet is frozen');
    throw new WalletError('INSUFFICIENT_FUNDS', 'Insufficient funds');
  }

  /** Settle: remove held cents from the sender and credit the recipient. */
  async settle(senderId, recipientId, cents, { session } = {}) {
    const now = new Date();
    await this.#consumeHeld(senderId, cents, { $inc: { heldCents: -cents } }, session);
    await this.collection.updateOne(
      { _id: recipientId },
      { $inc: { balanceCents: cents }, $set: { updatedAt: now }, $setOnInsert: newWalletFields(now) },
      { upsert: true, session },
    );
  }

  /** Release: return held cents to the sender's available balance. */
  async release(senderId, cents, { session } = {}) {
    await this.#consumeHeld(senderId, cents, { $inc: { heldCents: -cents, balanceCents: cents } }, session);
  }

  async setFrozen(userId, frozen, reason, { session } = {}) {
    return this.collection.findOneAndUpdate(
      { _id: userId },
      { $set: { frozen, frozenReason: frozen ? reason : null, updatedAt: new Date() } },
      { returnDocument: 'after', session },
    );
  }

  async #consumeHeld(userId, cents, update, session) {
    const res = await this.collection.updateOne(
      { _id: userId, heldCents: { $gte: cents } },
      { ...update, $set: { updatedAt: new Date() } },
      { session },
    );
    // Holds are only created with their transaction, so a shortfall means corrupted state:
    // abort the whole database transaction rather than let money appear or vanish.
    if (res.modifiedCount !== 1) {
      throw new WalletError('INVARIANT_VIOLATION', `wallet ${userId} holds less than ${cents} cents`);
    }
  }
}

module.exports = { WalletRepository, WalletError, toPublicWallet };
