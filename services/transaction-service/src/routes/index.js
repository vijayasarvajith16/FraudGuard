'use strict';

const express = require('express');
const { captureRoute } = require('../metrics');
const { validate } = require('../middleware/validate');
const { requireServiceToken } = require('../middleware/serviceToken');
const {
  depositSchema,
  transferSchema,
  listQuerySchema,
  uuidParamSchema,
  userIdParamSchema,
  statusUpdateSchema,
} = require('../validation/schemas');

function createWalletRouter({ controllers, requireAuth }) {
  const router = express.Router();
  router.get('/', captureRoute, requireAuth, controllers.getWallet);
  router.post('/deposit', captureRoute, requireAuth, validate(depositSchema), controllers.deposit);
  return router;
}

function createTransactionRouter({ controllers, requireAuth }) {
  const router = express.Router();
  router.post('/', captureRoute, requireAuth, validate(transferSchema), controllers.createTransaction);
  router.get('/', captureRoute, requireAuth, validate(listQuerySchema, 'query'), controllers.listTransactions);
  router.get('/:id', captureRoute, requireAuth, validate(uuidParamSchema, 'params'), controllers.getTransaction);
  return router;
}

/** Service-to-service routes. Never exposed through the gateway (docs/contracts.md §8). */
function createInternalRouter({ controllers, internalServiceToken }) {
  const router = express.Router();
  const requireToken = requireServiceToken(internalServiceToken);
  router.patch(
    '/transactions/:id/status',
    captureRoute,
    requireToken,
    validate(uuidParamSchema, 'params'),
    validate(statusUpdateSchema),
    controllers.updateStatus,
  );
  router.post(
    '/accounts/:userId/unfreeze',
    captureRoute,
    requireToken,
    validate(userIdParamSchema, 'params'),
    controllers.unfreeze,
  );
  return router;
}

function createHealthRouter({ db, publisher, config, metrics }) {
  const router = express.Router();
  const startedAt = Date.now();

  router.get('/health/live', captureRoute, (_req, res) => res.json({ status: 'ok' }));

  // Readiness requires MongoDB only. RabbitMQ is reported but does not fail readiness:
  // the outbox keeps accepting transfers through a broker outage (contract §2.3, §9).
  router.get('/health', captureRoute, async (req, res) => {
    let mongo = 'ok';
    try {
      await db.command({ ping: 1 });
    } catch (err) {
      mongo = 'fail';
      req.log.warn({ err }, 'readiness check failed: mongo');
    }
    const healthy = mongo === 'ok';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: config.serviceName,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: { mongo, rabbitmq: publisher.isConnected() ? 'ok' : 'fail' },
    });
  });

  router.get('/metrics', captureRoute, async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });
  return router;
}

module.exports = { createWalletRouter, createTransactionRouter, createInternalRouter, createHealthRouter };
