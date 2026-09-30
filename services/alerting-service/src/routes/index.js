'use strict';

const express = require('express');
const { AppError } = require('../errors');
const { captureRoute } = require('../metrics');
const { validate } = require('../middleware/validate');
const { toPublicAlert, toPublicReview } = require('../models/repositories');
const {
  otpVerifySchema,
  reviewDecisionSchema,
  reviewListQuerySchema,
  alertListQuerySchema,
  idParamSchema,
  userIdParamSchema,
} = require('../validation/schemas');

/** Public API under /alerts (routed by the gateway as /api/alerts/*). */
function createAlertsRouter({ service, alerts, reviews, policy, requireAuth, requireRole }) {
  const router = express.Router();
  const admin = [requireAuth, requireRole('admin')];

  router.get('/', captureRoute, requireAuth, validate(alertListQuerySchema, 'query'), async (req, res) => {
    const page = await alerts.listVisible(req.user.id, req.validatedQuery);
    if (!page) throw AppError.badRequest('Invalid cursor', [{ field: 'cursor', issue: 'is malformed' }]);
    res.json({ items: page.items.map(toPublicAlert), nextCursor: page.nextCursor });
  });

  router.post('/otp/verify', captureRoute, requireAuth, validate(otpVerifySchema), async (req, res) => {
    res.json(await service.verifyOtp(req.user, req.body, { requestId: req.id }));
  });

  router.get('/admin/reviews', captureRoute, ...admin, validate(reviewListQuerySchema, 'query'), async (req, res) => {
    const items = await reviews.list(req.validatedQuery.status);
    res.json({ items: items.map(toPublicReview) });
  });

  router.post(
    '/admin/reviews/:id/decision',
    captureRoute,
    ...admin,
    validate(idParamSchema, 'params'),
    validate(reviewDecisionSchema),
    async (req, res) => {
      const { review, transaction } = await service.decideReview(req.user, req.params.id, req.body, {
        requestId: req.id,
      });
      res.json({ review: toPublicReview(review), transaction });
    },
  );

  router.post(
    '/admin/accounts/:userId/unfreeze',
    captureRoute,
    ...admin,
    validate(userIdParamSchema, 'params'),
    async (req, res) => {
      res.json({ wallet: await service.unfreeze(req.params.userId, { requestId: req.id }) });
    },
  );

  router.get('/admin/config/tier-actions', captureRoute, ...admin, (_req, res) => {
    res.json(policy.describe());
  });

  router.post('/admin/config/reload', captureRoute, ...admin, async (req, res) => {
    const outcome = await policy.reload();
    if (outcome.result === 'invalid') {
      throw new AppError(422, 'INVALID_POLICY', 'Policy file rejected; the previous policy is still active', [
        { issue: outcome.error },
      ]);
    }
    req.log.info({ result: outcome.result, admin: req.user.id }, 'policy reload requested');
    res.json({ result: outcome.result, ...policy.describe() });
  });

  return router;
}

function createHealthRouter({ db, consumer, policy, config, metrics }) {
  const router = express.Router();
  const startedAt = Date.now();

  router.get('/health/live', captureRoute, (_req, res) => res.json({ status: 'ok' }));

  // Readiness: MongoDB, the loaded policy and (when consuming) RabbitMQ (contract §7).
  router.get('/health', captureRoute, async (req, res) => {
    const checks = { mongo: 'ok', policy: policy.policy ? 'ok' : 'fail' };
    try {
      await db.command({ ping: 1 });
    } catch (err) {
      checks.mongo = 'fail';
      req.log.warn({ err }, 'readiness check failed: mongo');
    }
    if (config.rabbitmq.consumerEnabled) checks.rabbitmq = consumer?.isConnected() ? 'ok' : 'fail';
    const healthy = Object.values(checks).every((v) => v === 'ok');
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: config.serviceName,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    });
  });

  router.get('/metrics', captureRoute, async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });
  return router;
}

module.exports = { createAlertsRouter, createHealthRouter };
