'use strict';

// RabbitMQ topology, exactly as docs/contracts.md §3.1-3.2 defines it. Declarations are
// idempotent but argument-sensitive: a mismatch with another service fails the declaration.

const EXCHANGES = Object.freeze({
  events: 'fraudguard.events',
  retry: 'fraudguard.retry',
  dlx: 'fraudguard.dlx',
});

const RETRY_DELAY_MS = 5000;
const DELIVERY_LIMIT = 10;

/** Main, retry and dead-letter queues for one event type (e.g. "flagged" -> transaction.flagged). */
function eventQueues(name) {
  const routingKey = `transaction.${name}`;
  const main = `transactions.${name}`;
  return {
    routingKey,
    queues: [
      {
        name: main,
        exchange: EXCHANGES.events,
        options: {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': EXCHANGES.dlx,
            'x-dead-letter-routing-key': routingKey,
            'x-delivery-limit': DELIVERY_LIMIT,
          },
        },
      },
      {
        name: `${main}.retry`,
        exchange: EXCHANGES.retry,
        options: {
          durable: true,
          arguments: {
            'x-message-ttl': RETRY_DELAY_MS,
            'x-dead-letter-exchange': EXCHANGES.events,
            'x-dead-letter-routing-key': routingKey,
          },
        },
      },
      {
        name: `${main}.dlq`,
        exchange: EXCHANGES.dlx,
        options: { durable: true, arguments: { 'x-queue-type': 'quorum' } },
      },
    ],
  };
}

const FLAGGED = eventQueues('flagged');

/**
 * Declare exchanges and the full queue set for each event this service touches
 * (contract §3.2: publishers declare destination queues too, so nothing is unroutable).
 */
async function assertTopology(channel, events = [FLAGGED]) {
  for (const exchange of Object.values(EXCHANGES)) {
    await channel.assertExchange(exchange, 'topic', { durable: true });
  }
  for (const { routingKey, queues } of events) {
    for (const q of queues) {
      await channel.assertQueue(q.name, q.options);
      await channel.bindQueue(q.name, q.exchange, routingKey);
    }
  }
}

module.exports = { EXCHANGES, FLAGGED, eventQueues, assertTopology, RETRY_DELAY_MS, DELIVERY_LIMIT };
