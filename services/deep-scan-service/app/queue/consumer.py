"""transactions.flagged consumer (docs/contracts.md §3.5).

Per message:
  1. Validate the envelope. Malformed -> reject without requeue -> dead-letter queue (no retries).
  2. Score with XGBoost, map to a tier.
  3. Publish transaction.scored (persistent, mandatory, publisher-confirmed).
  4. Ack only after the publish is confirmed.
On a processing failure: republish a copy to the retry exchange with x-retry-count + 1 and ack,
or dead-letter once MAX_RETRIES is reached. If even the retry publish fails, nack with requeue
(the quorum queue's delivery limit is the backstop).
Deep-scan keeps no state: scored eventIds are deterministic, and downstream deduplicates.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

import aio_pika
from pydantic import ValidationError

from .events import FlaggedEvent, scored_event
from .topology import EVENTS_EXCHANGE, FLAGGED, RETRY_EXCHANGE, SCORED, declare_topology

log = logging.getLogger("deep_scan.consumer")

# publish(exchange_name, routing_key, body, message_id, correlation_id, headers) -> awaits broker confirm
PublishFn = Callable[[str, str, bytes, str, str | None, dict], Awaitable[None]]


class FlaggedMessageHandler:
    """Transport-independent message handling, so the retry and ack rules are unit-testable."""

    def __init__(self, scorer, metrics, publish: PublishFn, max_retries: int) -> None:
        self.scorer = scorer
        self.metrics = metrics
        self.publish = publish
        self.max_retries = max_retries

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage) -> str:
        """Process one delivery; returns the outcome label (ok | retry | dead_lettered | requeued)."""
        headers = dict(message.headers or {})
        request_id = headers.get("x-request-id")
        try:
            event = FlaggedEvent.model_validate_json(message.body)
        except ValidationError as exc:
            log.error(
                "poison message dead-lettered",
                extra={"messageId": message.message_id, "errors": exc.error_count(), "requestId": request_id},
            )
            await message.reject(requeue=False)
            return self._count("dead_lettered")

        tx_id = str(event.payload.transactionId)
        try:
            with self.metrics.scan_latency.time():
                result = self.scorer.score(event.payload.feature_vector())
            self.metrics.scan_requests.labels("clean" if result.risk_tier == "LOW" else "flagged").inc()
            self.metrics.risk_tiers.labels(result.risk_tier).inc()
            self.metrics.scan_score.observe(result.probability)
            out = scored_event(
                event,
                probability=result.probability,
                tier=result.risk_tier,
                thresholds=self.scorer.tiers.as_dict(),
                model_version=self.scorer.artifact.version,
            )
            await self.publish(
                EVENTS_EXCHANGE,
                SCORED.routing_key,
                json.dumps(out).encode(),
                out["eventId"],
                tx_id,
                {"x-request-id": request_id, "x-retry-count": 0},
            )
            await message.ack()
        except Exception as exc:
            return await self._retry_or_dead_letter(message, headers, tx_id, exc)

        self.metrics.queue_latency.observe(max(0.0, (datetime.now(UTC) - event.occurredAt).total_seconds()))
        log.info(
            "transaction scored",
            extra={
                "transactionId": tx_id,
                "riskTier": result.risk_tier,
                "probability": round(result.probability, 6),
                "requestId": request_id,
            },
        )
        return self._count("ok")

    async def _retry_or_dead_letter(self, message, headers: dict, tx_id: str, exc: Exception) -> str:
        retries = int(headers.get("x-retry-count") or 0)
        if retries >= self.max_retries:
            log.error(
                "processing failed; retries exhausted, dead-lettering",
                extra={"transactionId": tx_id, "retries": retries, "error": str(exc)},
            )
            await message.reject(requeue=False)
            return self._count("dead_lettered")
        try:
            await self.publish(
                RETRY_EXCHANGE,
                FLAGGED.routing_key,
                message.body,
                message.message_id,
                tx_id,
                {**headers, "x-retry-count": retries + 1},
            )
            await message.ack()
            log.warning(
                "processing failed; scheduled retry",
                extra={"transactionId": tx_id, "attempt": retries + 1, "error": str(exc)},
            )
            return self._count("retry")
        except Exception as retry_exc:
            log.error(
                "retry publish failed; requeueing",
                extra={"transactionId": tx_id, "error": str(retry_exc)},
            )
            await message.nack(requeue=True)
            return self._count("requeued")

    def _count(self, outcome: str) -> str:
        self.metrics.queue_consumed.labels(outcome).inc()
        return outcome


class FlaggedConsumer:
    """Owns the robust AMQP connection; aio-pika restores the channel and consumer after reconnects."""

    def __init__(self, url: str, scorer, metrics, *, prefetch: int, max_retries: int) -> None:
        self.url = url
        self.prefetch = prefetch
        self.connection: aio_pika.abc.AbstractRobustConnection | None = None
        self.channel: aio_pika.abc.AbstractChannel | None = None
        self.exchanges: dict[str, aio_pika.abc.AbstractExchange] = {}
        self.handler = FlaggedMessageHandler(scorer, metrics, self._publish, max_retries)

    async def start(self) -> None:
        self.connection = await aio_pika.connect_robust(
            self.url, client_properties={"connection_name": "deep-scan-service"}
        )
        # Confirms: publish() returns only after the broker accepted the message.
        # on_return_raises: an unroutable mandatory message raises instead of vanishing.
        self.channel = await self.connection.channel(publisher_confirms=True, on_return_raises=True)
        await self.channel.set_qos(prefetch_count=self.prefetch)
        queues = await declare_topology(self.channel)
        for name in (EVENTS_EXCHANGE, RETRY_EXCHANGE):
            self.exchanges[name] = await self.channel.get_exchange(name)
        await queues[FLAGGED.main.name].consume(self.handler.handle)
        log.info("consuming", extra={"queue": FLAGGED.main.name, "prefetch": self.prefetch})

    def is_connected(self) -> bool:
        return self.connection is not None and not self.connection.is_closed and self.channel is not None

    async def _publish(self, exchange: str, routing_key: str, body: bytes, message_id, correlation_id, headers):
        message = aio_pika.Message(
            body,
            content_type="application/json",
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            message_id=message_id,
            correlation_id=correlation_id,
            headers=headers,
            timestamp=time.time(),
        )
        await self.exchanges[exchange].publish(message, routing_key=routing_key, mandatory=True, timeout=5)

    async def stop(self) -> None:
        if self.connection is not None:
            await self.connection.close()
