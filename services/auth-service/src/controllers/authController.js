'use strict';

const bcrypt = require('bcrypt');
const { AppError } = require('../errors');
const { EmailTakenError, toPublicUser } = require('../models/userRepository');
const { signAccessToken } = require('../middleware/jwtAuth');

function createAuthController({ users, config, metrics }) {
  // Compared against when the email is unknown, so an unknown email and a wrong
  // password take the same time (no user enumeration through response timing).
  const dummyHashPromise = bcrypt.hash('fraudguard-timing-equalizer', config.bcryptRounds);

  async function register(req, res) {
    const { email, password, name } = req.body;
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    try {
      const user = await users.create({ email, name, passwordHash, role: 'user' });
      metrics.registrationsTotal.inc();
      req.log.info({ userId: user._id }, 'user registered');
      res.status(201).json({ user: toPublicUser(user) });
    } catch (err) {
      if (err instanceof EmailTakenError) throw AppError.conflict('EMAIL_TAKEN', 'Email is already registered');
      throw err;
    }
  }

  async function login(req, res) {
    const { email, password } = req.body;
    const user = await users.findByEmail(email);
    const hash = user ? user.passwordHash : await dummyHashPromise;
    const passwordMatches = await bcrypt.compare(password, hash);

    if (!user || !passwordMatches) {
      metrics.loginsTotal.inc({ result: 'failure' });
      throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    const publicUser = toPublicUser(user);
    const accessToken = signAccessToken(publicUser, config.jwt);
    metrics.loginsTotal.inc({ result: 'success' });
    req.log.info({ userId: user._id }, 'user logged in');
    res.json({
      accessToken,
      tokenType: 'Bearer',
      expiresIn: config.jwt.expiresInSeconds,
      user: publicUser,
    });
  }

  async function me(req, res) {
    const user = await users.findById(req.user.id);
    // A valid token for a user that no longer exists is treated as unauthenticated.
    if (!user) throw AppError.unauthorized('User no longer exists');
    res.json({ user: toPublicUser(user) });
  }

  async function lookupByEmail(req, res) {
    const user = await users.findByEmail(req.validatedQuery.email);
    if (!user) throw AppError.notFound('User not found');
    const { id, email, name, role } = toPublicUser(user);
    res.json({ user: { id, email, name, role } });
  }

  return { register, login, me, lookupByEmail };
}

module.exports = { createAuthController };
