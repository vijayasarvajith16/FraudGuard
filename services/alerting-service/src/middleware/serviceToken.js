'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { AppError } = require('../errors');

const digest = (value) => createHash('sha256').update(String(value)).digest();

/**
 * Protects /internal/* routes with the shared X-Service-Token.
 * Both sides are hashed first so the constant-time comparison works on equal-length buffers.
 */
function requireServiceToken(expectedToken) {
  const expected = digest(expectedToken);
  return (req, _res, next) => {
    const provided = req.get('x-service-token');
    if (!provided || !timingSafeEqual(digest(provided), expected)) {
      return next(AppError.unauthorized('Invalid service token'));
    }
    return next();
  };
}

module.exports = { requireServiceToken };
