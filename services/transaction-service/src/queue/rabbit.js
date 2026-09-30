'use strict';

// RabbitMQ publisher with confirms and mandatory routing (docs/contracts.md §3.3).
// Uses amqplib's built-in recovery: after every (re)connect, `setup` redeclares the topology
// and recreates the confirm channel. While disconnected, publish() fails fast and the
// transactional outbox (src/queue/outboxRelay.js) retries later.

const amqplib = require('amqplib');
const { assertTopology } = require('./topology');

class PublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishError';
  }
}

class RabbitPublisher {
  constructor({ url, logger, confirmTimeoutMs = 5000, connect = amqplib.connect }) {
    this.url = url;
    this.logger = logger;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.connectFn = connect;
    this.connection = null;
    this.channel = null;
    this.returned = new Set(); // messageIds bounced as unroutable
  }

  /** Start connecting in the background; never throws (the outbox covers broker outages). */
  async start() {
    this.connection = await this.connectFn(this.url, {
      recovery: {
        initialDelay: 250,
        maxDelay: 10_000,
        maxRetries: Infinity,
        waitForConnect: false,
        setup: async (model) => {
          const channel = await model.createConfirmChannel();
          await assertTopology(channel);
          channel.on('return', (msg) => this.returned.add(msg.properties.messageId));
          channel.on('error', (err) => this.logger.warn({ err }, 'rabbitmq channel error'));
          this.channel = channel;
        },
      },
    });
    this.connection.on('connect', () => this.logger.info('rabbitmq connected'));
    this.connection.on('disconnect', (err) => {
      this.channel = null;
      this.logger.warn({ err: err?.message }, 'rabbitmq disconnected');
    });
    this.connection.on('connect-failed', (err) => this.logger.warn({ err: err?.message }, 'rabbitmq connect failed'));
  }

  isConnected() {
    return this.channel !== null;
  }

  /**
   * Publish an event envelope and resolve only after the broker confirms it.
   * Rejects if disconnected, unroutable (mandatory), nacked, or not confirmed in time.
   */
  async publish(exchange, routingKey, envelope, { requestId, correlationId } = {}) {
    const channel = this.channel;
    if (!channel) throw new PublishError('rabbitmq not connected');

    const messageId = envelope.eventId;
    const content = Buffer.from(JSON.stringify(envelope));
    const options = {
      persistent: true,
      mandatory: true,
      contentType: 'application/json',
      messageId,
      correlationId,
      timestamp: Math.floor(Date.now() / 1000),
      type: envelope.eventType,
      headers: { 'x-request-id': requestId ?? null, 'x-retry-count': 0 },
    };

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new PublishError('publish confirm timed out')), this.confirmTimeoutMs);
      channel.publish(exchange, routingKey, content, options, (err) => {
        clearTimeout(timer);
        if (err) reject(new PublishError(`broker nacked publish: ${err.message ?? err}`));
        else resolve();
      });
    });

    // AMQP delivers basic.return before the confirm for an unroutable mandatory message.
    if (this.returned.delete(messageId)) {
      throw new PublishError(`message ${messageId} was unroutable (${exchange} / ${routingKey})`);
    }
  }

  async close() {
    try {
      await this.connection?.close();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'error closing rabbitmq connection');
    }
  }
}

module.exports = { RabbitPublisher, PublishError };
