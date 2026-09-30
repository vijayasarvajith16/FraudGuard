'use strict';

const client = require('@prometheus-io/client');

/** Per-app registry (keeps tests isolated). Metric names follow docs/contracts.md §2.3. */
function createMetrics({ serviceName }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register: registry });
  const r = [registry];

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled',
    labelNames: ['method', 'route', 'status'],
    registers: r,
  });
  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: r,
  });

  const metrics = {
    registry,
    transactionsCreated: new client.Counter({
      name: 'transactions_created_total',
      help: 'Transfers created, by status after the quick-scan decision',
      labelNames: ['status'],
      registers: r,
    }),
    quickScanCalls: new client.Counter({
      name: 'quick_scan_calls_total',
      help: 'Quick-scan calls by result',
      labelNames: ['result'],
      registers: r,
    }),
    quickScanDuration: new client.Histogram({
      name: 'quick_scan_call_duration_seconds',
      help: 'Quick-scan call duration including network',
      buckets: [0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1],
      registers: r,
    }),
    queuePublish: new client.Counter({
      name: 'queue_publish_total',
      help: 'Event publishes to RabbitMQ by result',
      labelNames: ['result'],
      registers: r,
    }),
    outboxPending: new client.Gauge({
      name: 'outbox_pending',
      help: 'Events written to the outbox but not yet confirmed by RabbitMQ',
      registers: r,
    }),
    underReview: new client.Gauge({
      name: 'transactions_under_review',
      help: 'Transactions currently UNDER_REVIEW',
      registers: r,
    }),
    statusTransitions: new client.Counter({
      name: 'transaction_status_transitions_total',
      help: 'Applied status transitions',
      labelNames: ['from', 'to'],
      registers: r,
    }),
    recoveredPending: new client.Counter({
      name: 'transactions_recovered_total',
      help: 'Interrupted PENDING transfers moved to UNDER_REVIEW by the relay',
      registers: r,
    }),
  };

  /** Records count and latency per route template (captured by captureRoute, see below). */
  metrics.httpMetricsMiddleware = (req, res, next) => {
    const stopTimer = httpRequestDuration.startTimer();
    res.on('finish', () => {
      const route = res.locals.metricsRoute || 'unmatched';
      httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
      stopTimer({ method: req.method, route });
    });
    next();
  };

  return metrics;
}

/**
 * First handler on every route: records the route template for metrics. Express clears
 * req.route once a route passes an error on, which would label every failure "unmatched".
 */
function captureRoute(req, res, next) {
  res.locals.metricsRoute = `${req.baseUrl}${req.route.path}`;
  next();
}

module.exports = { createMetrics, captureRoute };
