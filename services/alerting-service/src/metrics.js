'use strict';

const client = require('@prometheus-io/client');

/** Per-app registry (keeps tests isolated). Metric names follow docs/contracts.md §7. */
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
    alertsCreated: new client.Counter({
      name: 'alerts_created_total',
      help: 'Alerts created, by tier and action',
      labelNames: ['tier', 'action'],
      registers: r,
    }),
    otpVerifications: new client.Counter({
      name: 'otp_verifications_total',
      help: 'OTP verification attempts by result',
      labelNames: ['result'],
      registers: r,
    }),
    reviewCasesOpen: new client.Gauge({
      name: 'review_cases_open',
      help: 'Manual review cases awaiting an admin decision',
      registers: r,
    }),
    queueConsumed: new client.Counter({
      name: 'queue_messages_consumed_total',
      help: 'transactions.scored deliveries by outcome',
      labelNames: ['result'],
      registers: r,
    }),
    queueLatency: new client.Histogram({
      name: 'queue_processing_latency_seconds',
      help: "Time from the scored event's occurredAt to its ack",
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers: r,
    }),
    tierActionsReloads: new client.Counter({
      name: 'tier_actions_config_reloads_total',
      help: 'Tier-action policy reloads by result',
      labelNames: ['result'],
      registers: r,
    }),
    tierActionsVersion: new client.Gauge({
      name: 'tier_actions_config_info',
      help: 'Active tier-action policy (value is always 1)',
      labelNames: ['sha256'],
      registers: r,
    }),
  };

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

/** First handler on every route: records the route template for metrics (see transaction-service). */
function captureRoute(req, res, next) {
  res.locals.metricsRoute = `${req.baseUrl}${req.route.path}`;
  next();
}

module.exports = { createMetrics, captureRoute };
