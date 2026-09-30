'use strict';

/**
 * Reusable JWT verification middleware for FraudGuard Node services.
 *
 * Self-contained on purpose: its only dependency is `jsonwebtoken`, and it
 * reports errors through `next(err)` with an object carrying
 * `{ status, code, message }` (the contract's error envelope, docs/contracts.md §0.5).
 * Other services copy this file verbatim into their src/middleware/ folder.
 *
 * Usage:
 *   const { createJwtAuth } = require('./middleware/jwtAuth');
 *   const { requireAuth, requireRole } = createJwtAuth({ secret: process.env.JWT_SECRET });
 *   router.get('/me', requireAuth, handler);            // req.user = { id, email, role }
 *   router.get('/admin', requireAuth, requireRole('admin'), handler);
 */

const jwt = require('jsonwebtoken');

const DEFAULT_ISSUER = 'fraudguard-auth';
const DEFAULT_AUDIENCE = 'fraudguard';
const CLOCK_TOLERANCE_SECONDS = 30;

function authError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function createJwtAuth({ secret, issuer = DEFAULT_ISSUER, audience = DEFAULT_AUDIENCE }) {
  if (!secret || secret.length < 32) {
    throw new Error('createJwtAuth: secret must be at least 32 characters');
  }

  const verifyOptions = {
    algorithms: ['HS256'],
    issuer,
    audience,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  };

  function requireAuth(req, _res, next) {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(authError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header'));
    }
    try {
      const claims = jwt.verify(token, secret, verifyOptions);
      if (typeof claims.sub !== 'string' || !claims.role) {
        return next(authError(401, 'UNAUTHORIZED', 'Token is missing required claims'));
      }
      req.user = { id: claims.sub, email: claims.email, role: claims.role };
      return next();
    } catch (err) {
      const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
      return next(authError(401, 'UNAUTHORIZED', message));
    }
  }

  function requireRole(...roles) {
    return (req, _res, next) => {
      if (!req.user) return next(authError(401, 'UNAUTHORIZED', 'Authentication required'));
      if (!roles.includes(req.user.role)) return next(authError(403, 'FORBIDDEN', 'Insufficient permissions'));
      return next();
    };
  }

  return { requireAuth, requireRole };
}

/** Sign an access token with the contract's claims. Only auth-service issues tokens. */
function signAccessToken(user, { secret, expiresIn, issuer = DEFAULT_ISSUER, audience = DEFAULT_AUDIENCE }) {
  return jwt.sign({ email: user.email, role: user.role }, secret, {
    algorithm: 'HS256',
    subject: user.id,
    issuer,
    audience,
    expiresIn,
  });
}

module.exports = { createJwtAuth, signAccessToken };
