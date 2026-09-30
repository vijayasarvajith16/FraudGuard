'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { validate } = require('../middleware/validate');
const { captureRoute } = require('../metrics');
const { registerSchema, loginSchema } = require('../validation/authSchemas');

function createAuthRouter({ controller, requireAuth, loginRateLimit }) {
  const router = express.Router();

  // Counts failed attempts per IP + email; a successful login does not use up the budget.
  const loginLimiter = rateLimit({
    windowMs: loginRateLimit.windowMs,
    limit: loginRateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      return `${ipKeyGenerator(req.ip)}|${email}`;
    },
    handler: (req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many login attempts, try again later',
          requestId: req.id,
        },
      });
    },
  });

  router.post('/register', captureRoute, validate(registerSchema), controller.register);
  router.post('/login', captureRoute, loginLimiter, validate(loginSchema), controller.login);
  router.get('/me', captureRoute, requireAuth, controller.me);

  return router;
}

module.exports = { createAuthRouter };
