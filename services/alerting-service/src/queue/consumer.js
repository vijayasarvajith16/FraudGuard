'use strict';

// transactions.scored consumer (docs/contracts.md §3.5, §7). Same rules as deep-scan's consumer:
// poison -> dead-letter; success -> ack; transient failure -> republish to the retry exchange with
// x-retry-count + 1 and ack (dead-letter once MAX_RETRIES is reached); if even that fails -> nack
// with requeue (the quorum delivery limit is the backstop). Permanent failures dead-letter at once.

const amqplib = require('amqplib');
const { assertTopology, EXCHANGES, SCORED } = require('./topology');
const { scoredEventSchema } = require('../validation/schemas');
const { PermanentProcessingError } = require('../services/alertingService');

function waitForConfirm(channel, exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => {
    channel.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve()));
  });
}

/** Transport-independent handling of one delivery; returns the outcome label. */
async function handleDelivery({ channel, msg, service, metrics, logger, maxRetries }) {
  const headers = msg.properties.headers || {};
  const requestId = headers['x-request-id'] ?? undefined;

  let event;
  try {
    event = scoredEventSchema.parse(JSON.parse(msg.content.toString('utf8')));
  } catch (err) {
    logger.error({ messageId: msg.properties.messageId, err: err.message }, 'poison message dead-lettered');
    channel.nack(msg, false, false);
    return count(metrics, 'dead_lettered');
  }

  try {
    const outcome = await service.processScoredEvent(event, { requestId });
    channel.ack(msg);
    metrics.queueLatency.observe(Math.max(0, (Date.now() - Date.parse(event.occurredAt)) / 1000));
    return count(metrics, outcome === 'duplicate' ? 'duplicate' : 'ok');
  } catch (err) {
    const transactionId = event.payload.transactionId;
    if (err instanceof PermanentProcessingError) {
      logger.error({ transactionId, err: err.message }, 'permanent failure; dead-lettering');
      channel.nack(msg, false, false);
      return count(metrics, 'dead_lettered');
    }
    const retries = Number(headers['x-retry-count'] || 0);
    if (retries >= maxRetries) {
      logger.error({ transactionId, retries, err: err.message }, 'retries exhausted; dead-lettering');
      channel.nack(msg, false, false);
      return count(metrics, 'dead_lettered');
    }
    try {
      await waitForConfirm(channel, EXCHANGES.retry, SCORED.routingKey, msg.content, {
        ...msg.properties,
        persistent: true,
        headers: { ...headers, 'x-retry-count': retries + 1 },
      });
      channel.ack(msg);
      logger.warn({ transactionId, attempt: retries + 1, err: err.message }, 'processing failed; retry scheduled');
      return count(metrics, 'retry');
    } catch (retryErr) {
      logger.error({ transactionId, err: retryErr.message }, 'retry publish failed; requeueing');
      channel.nack(msg, false, true);
      return count(metrics, 'requeued');
    }
  }
}

function count(metrics, outcome) {
  metrics.queueConsumed.inc({ result: outcome });
  return outcome;
}

class ScoredConsumer {
  constructor({ url, prefetch, maxRetries, service, metrics, logger, connect = amqplib.connect }) {
    Object.assign(this, { url, prefetch, maxRetries, service, metrics, logger, connectFn: connect });
    this.connection = null;
    this.channel = null;
  }

  async start() {
    this.connection = await this.connectFn(this.url, {
      recovery: {
        initialDelay: 250,
        maxDelay: 10_000,
        maxRetries: Infinity,
        waitForConnect: false,
        // Runs after every (re)connect: fresh channel, topology, consumer.
        setup: async (model) => {
          const channel = await model.createConfirmChannel();
          await assertTopology(channel, [SCORED]);
          await channel.prefetch(this.prefetch);
          channel.on('error', (err) => this.logger.warn({ err: err.message }, 'rabbitmq channel error'));
          await channel.consume(SCORED.queues[0].name, (msg) => {
            if (msg === null) return; // consumer cancelled by the broker
            handleDelivery({
              channel,
              msg,
              service: this.service,
              metrics: this.metrics,
              logger: this.logger,
              maxRetries: this.maxRetries,
            }).catch((err) => this.logger.error({ err: err.message }, 'unexpected consumer error'));
          });
          this.channel = channel;
          this.logger.info({ queue: SCORED.queues[0].name, prefetch: this.prefetch }, 'consuming');
        },
      },
    });
    this.connection.on('disconnect', (err) => {
      this.channel = null;
      this.logger.warn({ err: err?.message }, 'rabbitmq disconnected');
    });
  }

  isConnected() {
    return this.channel !== null;
  }

  async close() {
    try {
      await this.connection?.close();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'error closing rabbitmq connection');
    }
  }
}

module.exports = { ScoredConsumer, handleDelivery };
