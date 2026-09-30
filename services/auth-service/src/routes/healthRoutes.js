'use strict';

const express = require('express');
const { captureRoute } = require('../metrics');

function createHealthRouter({ db, config, metrics }) {
  const router = express.Router();
  const startedAt = Date.now();

  router.get('/health/live', captureRoute, (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: the service is only useful while MongoDB answers.
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
      checks: { mongo },
    });
  });

  router.get('/metrics', captureRoute, async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  return router;
}

module.exports = { createHealthRouter };
