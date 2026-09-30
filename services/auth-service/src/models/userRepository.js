'use strict';

const { randomUUID } = require('node:crypto');
const { z } = require('zod');

const ROLES = Object.freeze(['user', 'admin']);
const DUPLICATE_KEY = 11000;

/**
 * Shape of a stored user document. Validated before every write so that the
 * collection only ever contains well-formed documents, whatever the caller does.
 */
const userDocumentSchema = z.strictObject({
  _id: z.uuid(),
  email: z.email().max(254),
  name: z.string().min(1).max(80),
  role: z.enum(ROLES),
  passwordHash: z.string().regex(/^\$2[aby]\$\d{2}\$.{53}$/, 'must be a bcrypt hash'),
  createdAt: z.date(),
  updatedAt: z.date(),
});

class EmailTakenError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailTakenError';
  }
}

/** Public projection: never exposes the password hash or Mongo internals. */
function toPublicUser(doc) {
  return {
    id: doc._id,
    email: doc.email,
    name: doc.name,
    role: doc.role,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Data-access layer for the `users` collection (native MongoDB driver, no ODM). */
class UserRepository {
  constructor(db) {
    this.collection = db.collection('users');
  }

  async ensureIndexes() {
    await this.collection.createIndex({ email: 1 }, { unique: true, name: 'uniq_email' });
  }

  /**
   * Insert a new user. Relies on the unique index (not a read-then-write check)
   * so concurrent registrations for the same email cannot both succeed.
   */
  async create({ email, name, passwordHash, role = 'user' }) {
    const now = new Date();
    const doc = userDocumentSchema.parse({
      _id: randomUUID(),
      email: normalizeEmail(email),
      name: name.trim(),
      role,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.collection.insertOne(doc);
    } catch (err) {
      if (err && err.code === DUPLICATE_KEY) throw new EmailTakenError();
      throw err;
    }
    return doc;
  }

  async findByEmail(email) {
    return this.collection.findOne({ email: normalizeEmail(email) });
  }

  async findById(id) {
    if (typeof id !== 'string') return null;
    return this.collection.findOne({ _id: id });
  }
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

module.exports = { UserRepository, EmailTakenError, toPublicUser, normalizeEmail, ROLES };
