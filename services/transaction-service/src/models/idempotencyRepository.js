'use strict';

// Idempotency keys for POST /transactions (docs/contracts.md §2.3, §9.1): scoped per user,
// kept 24 h by a TTL index. The record is inserted in the same database transaction as the
// transfer, so a key either maps to a committed transfer or does not exist at all.

const { createHash } = require('node:crypto');

const TTL_SECONDS = 24 * 60 * 60;
const DUPLICATE_KEY = 11000;

/** Stable hash of the request body: key order does not matter, values do. */
function requestHash(body) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, canonical(value[k])]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex');
}

class IdempotencyRepository {
  constructor(db) {
    this.collection = db.collection('idempotency_keys');
  }

  async ensureIndexes() {
    await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS, name: 'ttl_24h' });
  }

  async insert({ userId, key, hash, transactionId }, { session } = {}) {
    await this.collection.insertOne(
      { _id: `${userId}:${key}`, userId, key, requestHash: hash, transactionId, createdAt: new Date() },
      { session },
    );
  }

  async find(userId, key) {
    return this.collection.findOne({ _id: `${userId}:${key}` });
  }
}

const isDuplicateKey = (err) => err?.code === DUPLICATE_KEY;

module.exports = { IdempotencyRepository, requestHash, isDuplicateKey, TTL_SECONDS };
