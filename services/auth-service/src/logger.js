'use strict';

const pino = require('pino');

/** Structured JSON logger. Secrets are redacted wherever they could appear. */
function createLogger({ level = 'info', serviceName = 'auth-service' } = {}) {
  return pino({
    level,
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-service-token"]',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.accessToken',
      ],
      censor: '[REDACTED]',
    },
  });
}

module.exports = { createLogger };
