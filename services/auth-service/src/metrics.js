'use strict';

const client = require('@prometheus-io/client');

/**
 * Build a per-app metrics registry. A fresh registry per app instance keeps
 * tests isolated and avoids "metric already registered" errors.
 */
function createMetrics({ serviceName }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const registrationsTotal = new client.Counter({
    name: 'auth_registrations_total',
    help: 'Successful user registrations',
    registers: [registry],
  });

  const loginsTotal = new client.Counter({
    name: 'auth_logins_total',
    help: 'Login attempts by result',
    labelNames: ['result'],
    registers: [registry],
  });

  /** Express middleware recording count and latency per route template (not raw URL, to bound cardinality). */
  function httpMetricsMiddleware(req, res, next) {
    const stopTimer = httpRequestDuration.startTimer();
    res.on('finish', () => {
      const route = res.locals.metricsRoute || 'unmatched';
      httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
      stopTimer({ method: req.method, route });
    });
    next();
  }

  return { registry, registrationsTotal, loginsTotal, httpMetricsMiddleware };
}

/**
 * First handler on every route: records the route template for metrics.
 * Needed because Express clears req.route once a route passes an error on
 * (e.g. a 401 from requireAuth), which would label every failure "unmatched".
 */
function captureRoute(req, res, next) {
  res.locals.metricsRoute = `${req.baseUrl}${req.route.path}`;
  next();
}

module.exports = { createMetrics, captureRoute };
