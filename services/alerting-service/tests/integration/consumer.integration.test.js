'use strict';

// Real RabbitMQ in a throwaway vhost. Needs RABBITMQ_TEST_URL and RABBITMQ_TEST_MGMT_URL; skipped otherwise.

const { randomUUID } = require('node:crypto');
const amqplib = require('amqplib');
const { ScoredConsumer } = require('../../src/queue/consumer');
const { createMetrics } = require('../../src/metrics');
const { createLogger } = require('../../src/logger');
const { scoredEvent } = require('../helpers');

const BASE_URL = process.env.RABBITMQ_TEST_URL;
const MGMT_URL = process.env.RABBITMQ_TEST_MGMT_URL;
// Run by `npm run test:integration` (make test-integration) only; `npm test` excludes this folder.
if (!BASE_URL || !MGMT_URL) {
  throw new Error('Set RABBITMQ_TEST_URL and RABBITMQ_TEST_MGMT_URL (make test-integration does this from .env)');
}

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

describe('ScoredConsumer against a real broker', () => {
  const vhost = `fraudguard-test-${randomUUID().slice(0, 8)}`;
  const { username, password } = new URL(BASE_URL);
  const user = decodeURIComponent(username);
  const auth = { Authorization: `Basic ${Buffer.from(`${user}:${decodeURIComponent(password)}`).toString('base64')}` };
  const mgmt = (path, init = {}) =>
    fetch(`${MGMT_URL}/api${path}`, { ...init, headers: { ...auth, 'Content-Type': 'application/json' } });
  const vhostUrl = `${BASE_URL.replace(/\/$/, '')}/${vhost}`;

  const handled = [];
  let failNext = 0;
  const service = {
    async processScoredEvent(event, { requestId }) {
      if (failNext > 0) {
        failNext -= 1;
        const err = new Error('transaction-service down');
        err.kind = 'transient';
        throw err;
      }
      handled.push({ event, requestId });
      return 'applied';
    },
  };
  let consumer;
  let publisherConn;
  let publishChannel;

  beforeAll(async () => {
    const created = await mgmt(`/vhosts/${vhost}`, { method: 'PUT', body: '{}' });
    if (!created.ok) throw new Error(`could not create vhost: HTTP ${created.status}`);
    await mgmt(`/permissions/${vhost}/${user}`, {
      method: 'PUT',
      body: JSON.stringify({ configure: '.*', write: '.*', read: '.*' }),
    });
    consumer = new ScoredConsumer({
      url: vhostUrl,
      prefetch: 5,
      maxRetries: 3,
      service,
      metrics: createMetrics({ serviceName: 'alerting-service' }),
      logger: createLogger({ level: 'silent' }),
    });
    await consumer.start();
    await consumer.connection.waitForConnect();
    await waitFor(() => consumer.isConnected());
    publisherConn = await amqplib.connect(vhostUrl);
    publishChannel = await publisherConn.createConfirmChannel();
  });

  afterAll(async () => {
    await publisherConn?.close();
    await consumer?.close();
    await mgmt(`/vhosts/${vhost}`, { method: 'DELETE' });
  });

  const publish = (body, headers = {}) =>
    new Promise((resolve, reject) => {
      publishChannel.publish(
        'fraudguard.events',
        'transaction.scored',
        Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
        { persistent: true, messageId: randomUUID(), headers: { 'x-retry-count': 0, ...headers } },
        (err) => (err ? reject(err) : resolve()),
      );
    });

  it('consumes transaction.scored and hands the validated event to the service', async () => {
    const event = scoredEvent({ tier: 'CRITICAL' });
    await publish(event, { 'x-request-id': 'it-req' });

    const got = await waitFor(() => handled.find((h) => h.event.eventId === event.eventId));
    expect(got).toBeTruthy();
    expect(got.requestId).toBe('it-req');
    expect(got.event.payload.riskTier).toBe('CRITICAL');
  });

  it('retries a transient failure through the retry queue, then succeeds', async () => {
    failNext = 1;
    const event = scoredEvent({ tier: 'LOW' });
    await publish(event);
    // The retry queue holds it for 5 s (x-message-ttl), then dead-letters it back to the main queue.
    const got = await waitFor(() => handled.find((h) => h.event.eventId === event.eventId), 15_000);
    expect(got).toBeTruthy();
  }, 20_000);

  it('dead-letters a poison message', async () => {
    await publish('{"not": "a scored event"}');
    const ch = await publisherConn.createChannel();
    const msg = await waitFor(() => ch.get('transactions.scored.dlq', { noAck: true }));
    expect(JSON.parse(msg.content.toString())).toEqual({ not: 'a scored event' });
    await ch.close();
  });
});
