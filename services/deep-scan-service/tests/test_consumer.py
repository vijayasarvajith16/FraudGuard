"""Consumer rules (docs/contracts.md §3.5), tested without a broker."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import fraud_features, normal_features

from app.config import TierThresholds
from app.metrics import Metrics
from app.model_loader import ModelArtifact
from app.queue.consumer import FlaggedMessageHandler
from app.queue.events import SCORED_EVENT_NAMESPACE
from app.scorer import DeepScanScorer


class FakeMessage:
    def __init__(self, body, headers=None, message_id="m-1"):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers = headers or {}
        self.message_id = message_id
        self.outcome = None

    async def ack(self):
        self.outcome = "ack"

    async def reject(self, requeue=False):
        self.outcome = f"reject(requeue={requeue})"

    async def nack(self, requeue=True):
        self.outcome = f"nack(requeue={requeue})"


class FakePublisher:
    def __init__(self, fail_on=()):
        self.calls = []
        self.fail_on = set(fail_on)  # exchange names whose publish fails

    async def __call__(self, exchange, routing_key, body, message_id, correlation_id, headers):
        if exchange in self.fail_on:
            raise ConnectionError(f"cannot publish to {exchange}")
        self.calls.append(
            {
                "exchange": exchange,
                "routing_key": routing_key,
                "body": json.loads(body),
                "message_id": message_id,
                "correlation_id": correlation_id,
                "headers": headers,
            }
        )


def flagged(features, tx_id=None, occurred_at=None):
    tx_id = tx_id or str(uuid.uuid4())
    return {
        "eventId": str(uuid.uuid4()),
        "eventType": "transaction.flagged",
        "version": 1,
        "idempotencyKey": f"{tx_id}:flagged",
        "occurredAt": (occurred_at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
        "producer": "transaction-service",
        "payload": {
            "transactionId": tx_id,
            "userId": str(uuid.uuid4()),
            "recipientId": str(uuid.uuid4()),
            "amount": 42.5,
            "currency": "USD",
            "features": features,
            "quickScan": {"score": 0.45, "threshold": 0.39, "flagged": True, "reason": "ANOMALY", "modelVersion": "2"},
            "createdAt": "2026-09-30T10:00:00.000Z",
        },
    }


@pytest.fixture
def handler_factory(model_dir, booster):
    def make(publisher, max_retries=3):
        metadata = {"best_iteration": booster.best_iteration}
        artifact = ModelArtifact(Path(model_dir), "fraudguard-deep-scan", "5", "production", "local", metadata)
        scorer = DeepScanScorer(artifact, TierThresholds(0.30, 0.70, 0.90))
        metrics = Metrics("deep-scan-service")
        return FlaggedMessageHandler(scorer, metrics, publisher, max_retries), metrics

    return make


def run(coro):
    return asyncio.run(coro)


def test_scores_publishes_and_acks(handler_factory):
    publisher = FakePublisher()
    handler, metrics = handler_factory(publisher)
    event = flagged(fraud_features())
    msg = FakeMessage(event, headers={"x-request-id": "req-7", "x-retry-count": 0})

    assert run(handler.handle(msg)) == "ok"
    assert msg.outcome == "ack"
    (call,) = publisher.calls
    assert (call["exchange"], call["routing_key"]) == ("fraudguard.events", "transaction.scored")
    assert call["correlation_id"] == event["payload"]["transactionId"]
    assert call["headers"] == {"x-request-id": "req-7", "x-retry-count": 0}

    scored = call["body"]
    tx_id = event["payload"]["transactionId"]
    assert scored["eventType"] == "transaction.scored"
    assert scored["idempotencyKey"] == f"{tx_id}:scored"
    assert scored["eventId"] == str(uuid.uuid5(SCORED_EVENT_NAMESPACE, f"{tx_id}:scored"))
    assert call["message_id"] == scored["eventId"]
    assert scored["payload"]["riskTier"] == "CRITICAL"
    assert scored["payload"]["thresholds"] == {"medium": 0.30, "high": 0.70, "critical": 0.90}
    assert scored["payload"]["quickScan"] == event["payload"]["quickScan"]
    assert scored["payload"]["modelVersion"] == "5"
    text = metrics.render().decode()
    assert 'queue_messages_consumed_total{result="ok"} 1.0' in text
    assert 'risk_tier_total{tier="CRITICAL"} 1.0' in text
    assert 'scan_score_bucket{le="0.9"} 0.0' in text  # a CRITICAL probability is above 0.9
    assert "scan_score_count 1.0" in text


def test_redelivery_produces_the_same_event_id(handler_factory):
    publisher = FakePublisher()
    handler, _ = handler_factory(publisher)
    event = flagged(normal_features())
    run(handler.handle(FakeMessage(event)))
    run(handler.handle(FakeMessage(event)))

    first, second = (c["body"] for c in publisher.calls)
    assert first["eventId"] == second["eventId"]
    assert first["payload"]["probability"] == second["payload"]["probability"]
    assert first["payload"]["riskTier"] == "LOW"


def test_queue_latency_is_measured_from_occurred_at(handler_factory):
    handler, metrics = handler_factory(FakePublisher())
    run(handler.handle(FakeMessage(flagged(normal_features(), occurred_at=datetime.now(UTC) - timedelta(seconds=3)))))
    text = metrics.render().decode()
    assert 'queue_processing_latency_seconds_bucket{le="2.5"} 0.0' in text
    assert 'queue_processing_latency_seconds_bucket{le="5.0"} 1.0' in text


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        {"eventType": "transaction.flagged"},
        {**flagged(normal_features()), "eventType": "transaction.scored"},
        {**flagged(normal_features()), "version": 2},
        flagged({**normal_features(), "V29": 1.0}),
        flagged({k: v for k, v in normal_features().items() if k != "V3"}),
    ],
)
def test_poison_messages_are_dead_lettered_without_retry(handler_factory, body):
    publisher = FakePublisher()
    handler, metrics = handler_factory(publisher)
    msg = FakeMessage(body)

    assert run(handler.handle(msg)) == "dead_lettered"
    assert msg.outcome == "reject(requeue=False)"
    assert publisher.calls == []
    assert 'queue_messages_consumed_total{result="dead_lettered"} 1.0' in metrics.render().decode()


def test_publish_failure_schedules_a_retry_and_acks(handler_factory):
    publisher = FakePublisher(fail_on={"fraudguard.events"})
    handler, _ = handler_factory(publisher)
    msg = FakeMessage(flagged(normal_features()), headers={"x-request-id": "req-1", "x-retry-count": 1})

    assert run(handler.handle(msg)) == "retry"
    assert msg.outcome == "ack"
    (call,) = publisher.calls
    assert (call["exchange"], call["routing_key"]) == ("fraudguard.retry", "transaction.flagged")
    assert call["headers"] == {"x-request-id": "req-1", "x-retry-count": 2}
    assert call["message_id"] == "m-1"


def test_retries_exhausted_dead_letters(handler_factory):
    publisher = FakePublisher(fail_on={"fraudguard.events"})
    handler, _ = handler_factory(publisher, max_retries=3)
    msg = FakeMessage(flagged(normal_features()), headers={"x-retry-count": 3})

    assert run(handler.handle(msg)) == "dead_lettered"
    assert msg.outcome == "reject(requeue=False)"
    assert publisher.calls == []


def test_retry_publish_failure_requeues(handler_factory):
    publisher = FakePublisher(fail_on={"fraudguard.events", "fraudguard.retry"})
    handler, _ = handler_factory(publisher)
    msg = FakeMessage(flagged(normal_features()))

    assert run(handler.handle(msg)) == "requeued"
    assert msg.outcome == "nack(requeue=True)"
