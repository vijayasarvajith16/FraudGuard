"""RabbitMQ topology exactly as docs/contracts.md §3.1-3.2 defines it.

Mirrors services/transaction-service/src/queue/topology.js: declarations are idempotent but
argument-sensitive, so both must stay identical. Every service declares the full queue set of
each event it touches (publisher or consumer), so nothing is ever unroutable.
"""

from __future__ import annotations

from dataclasses import dataclass

import aio_pika

EVENTS_EXCHANGE = "fraudguard.events"
RETRY_EXCHANGE = "fraudguard.retry"
DLX_EXCHANGE = "fraudguard.dlx"
RETRY_DELAY_MS = 5000
DELIVERY_LIMIT = 10


@dataclass(frozen=True)
class QueueSpec:
    name: str
    exchange: str
    arguments: dict


@dataclass(frozen=True)
class EventQueues:
    routing_key: str
    main: QueueSpec
    retry: QueueSpec
    dlq: QueueSpec

    @property
    def all(self) -> tuple[QueueSpec, ...]:
        return (self.main, self.retry, self.dlq)


def event_queues(name: str) -> EventQueues:
    routing_key = f"transaction.{name}"
    main = f"transactions.{name}"
    return EventQueues(
        routing_key=routing_key,
        main=QueueSpec(
            main,
            EVENTS_EXCHANGE,
            {
                "x-queue-type": "quorum",
                "x-dead-letter-exchange": DLX_EXCHANGE,
                "x-dead-letter-routing-key": routing_key,
                "x-delivery-limit": DELIVERY_LIMIT,
            },
        ),
        retry=QueueSpec(
            f"{main}.retry",
            RETRY_EXCHANGE,
            {
                "x-message-ttl": RETRY_DELAY_MS,
                "x-dead-letter-exchange": EVENTS_EXCHANGE,
                "x-dead-letter-routing-key": routing_key,
            },
        ),
        dlq=QueueSpec(f"{main}.dlq", DLX_EXCHANGE, {"x-queue-type": "quorum"}),
    )


FLAGGED = event_queues("flagged")
SCORED = event_queues("scored")


async def declare_topology(channel: aio_pika.abc.AbstractChannel) -> dict[str, aio_pika.abc.AbstractQueue]:
    """Declare exchanges plus the flagged (consumed) and scored (published) queue sets."""
    exchanges = {
        name: await channel.declare_exchange(name, aio_pika.ExchangeType.TOPIC, durable=True)
        for name in (EVENTS_EXCHANGE, RETRY_EXCHANGE, DLX_EXCHANGE)
    }
    queues = {}
    for events in (FLAGGED, SCORED):
        for spec in events.all:
            queue = await channel.declare_queue(spec.name, durable=True, arguments=spec.arguments)
            await queue.bind(exchanges[spec.exchange], routing_key=events.routing_key)
            queues[spec.name] = queue
    return queues
