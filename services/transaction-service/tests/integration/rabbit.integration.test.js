'use strict';

// Runs against a real RabbitMQ (the compose broker) in a throwaway vhost:
//   RABBITMQ_TEST_URL=amqp://user:pass@127.0.0.1:5673  RABBITMQ_TEST_MGMT_URL=http://127.0.0.1:15673

const { randomUUID } = require('node:crypto');
const amqplib = require('amqplib');
const { RabbitPublisher, PublishError } = require('../../src/queue/rabbit');
const { EXCHANGES, FLAGGED } = require('../../src/queue/topology');
const { createLogger } = require('../../src/logger');

const BASE_URL = process.env.RABBITMQ_TEST_URL;
const MGMT_URL = process.env.RABBITMQ_TEST_MGMT_URL;
// Run by `npm run test:integration` (make test-integration) only; `npm test` excludes this folder.
if (!BASE_URL || !MGMT_URL) {
  throw new Error('Set RABBITMQ_TEST_URL and RABBITMQ_TEST_MGMT_URL (make test-integration does this from .env)');
}

describe('RabbitPublisher against a real broker', () => {
  const vhost = `fraudguard-test-${randomUUID().slice(0, 8)}`;
  const { username, password } = new URL(BASE_URL);
  const mgmtAuth = {
    Authorization: `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64')}`,
  };
  const vhostUrl = `${BASE_URL.replace(/\/$/, '')}/${vhost}`;
  const mgmt = (path, init = {}) =>
    fetch(`${MGMT_URL}/api${path}`, { ...init, headers: { ...mgmtAuth, 'Content-Type': 'application/json' } });

  let publisher;
  let consumerConn;

  beforeAll(async () => {
    const created = await mgmt(`/vhosts/${vhost}`, { method: 'PUT', body: '{}' });
    if (!created.ok) throw new Error(`could not create test vhost: HTTP ${created.status}`);
    const perms = { configure: '.*', write: '.*', read: '.*' };
    await mgmt(`/permissions/${vhost}/${decodeURIComponent(username)}`, { method: 'PUT', body: JSON.stringify(perms) });

    publisher = new RabbitPublisher({
      url: vhostUrl,
      logger: createLogger({ level: 'silent' }),
      confirmTimeoutMs: 5000,
    });
    await publisher.start();
    await publisher.connection.waitForConnect();
    for (let i = 0; i < 50 && !publisher.isConnected(); i += 1) await new Promise((r) => setTimeout(r, 100));
    consumerConn = await amqplib.connect(vhostUrl);
  });

  afterAll(async () => {
    await consumerConn?.close();
    await publisher?.close();
    await mgmt(`/vhosts/${vhost}`, { method: 'DELETE' });
  });

  it('declares the contract topology on connect', async () => {
    const queues = await (await mgmt(`/queues/${vhost}`)).json();
    const byName = Object.fromEntries(queues.map((q) => [q.name, q]));

    expect(byName['transactions.flagged'].arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': 'fraudguard.dlx',
      'x-dead-letter-routing-key': 'transaction.flagged',
      'x-delivery-limit': 10,
    });
    expect(byName['transactions.flagged.retry'].arguments['x-message-ttl']).toBe(5000);
    expect(byName['transactions.flagged.dlq'].arguments['x-queue-type']).toBe('quorum');
  });

  it('publishes a confirmed, persistent message that lands on transactions.flagged', async () => {
    const envelope = { eventId: randomUUID(), eventType: 'transaction.flagged', version: 1, payload: { n: 1 } };
    await publisher.publish(EXCHANGES.events, FLAGGED.routingKey, envelope, {
      requestId: 'req-1',
      correlationId: 'tx-1',
    });

    const ch = await consumerConn.createChannel();
    let msg = false;
    for (let i = 0; i < 20 && !msg; i += 1) {
      msg = await ch.get('transactions.flagged', { noAck: true });
      if (!msg) await new Promise((r) => setTimeout(r, 100));
    }
    expect(JSON.parse(msg.content.toString())).toEqual(envelope);
    expect(msg.properties).toMatchObject({
      messageId: envelope.eventId,
      correlationId: 'tx-1',
      deliveryMode: 2,
      contentType: 'application/json',
      headers: { 'x-request-id': 'req-1', 'x-retry-count': 0 },
    });
    await ch.close();
  });

  it('rejects an unroutable message instead of losing it silently', async () => {
    const envelope = { eventId: randomUUID(), eventType: 'transaction.unknown' };
    await expect(publisher.publish(EXCHANGES.events, 'transaction.nobody-listens', envelope)).rejects.toThrow(
      PublishError,
    );
    await expect(publisher.publish(EXCHANGES.events, 'transaction.nobody-listens', envelope)).rejects.toThrow(
      /unroutable/,
    );
  });
});
