"""Event envelopes (docs/contracts.md §3.4)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from ..schemas import FEATURE_COLUMNS, Features

# Contract §3.4: scored eventIds are UUIDv5 over this namespace (uuid.NAMESPACE_URL), so a
# redelivered flagged message yields a scored event with the same eventId.
SCORED_EVENT_NAMESPACE = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")


class FlaggedPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transactionId: UUID
    userId: UUID
    recipientId: UUID
    amount: float = Field(gt=0)
    currency: Literal["USD"]
    features: Features  # type: ignore[valid-type]
    quickScan: dict
    createdAt: str

    def feature_vector(self) -> list[float]:
        return [getattr(self.features, name) for name in FEATURE_COLUMNS]


class FlaggedEvent(BaseModel):
    """transaction.flagged, version 1. Anything else is a poison message."""

    model_config = ConfigDict(extra="forbid")

    eventId: UUID
    eventType: Literal["transaction.flagged"]
    version: Literal[1]
    idempotencyKey: str
    occurredAt: datetime
    producer: str
    payload: FlaggedPayload


def iso_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def scored_event(flagged: FlaggedEvent, *, probability: float, tier: str, thresholds: dict, model_version: str) -> dict:
    p = flagged.payload
    idempotency_key = f"{p.transactionId}:scored"
    scored_at = iso_now()
    return {
        "eventId": str(uuid.uuid5(SCORED_EVENT_NAMESPACE, idempotency_key)),
        "eventType": "transaction.scored",
        "version": 1,
        "idempotencyKey": idempotency_key,
        "occurredAt": scored_at,
        "producer": "deep-scan-service",
        "payload": {
            "transactionId": str(p.transactionId),
            "userId": str(p.userId),
            "recipientId": str(p.recipientId),
            "amount": p.amount,
            "currency": p.currency,
            "probability": probability,
            "riskTier": tier,
            "thresholds": thresholds,
            "modelVersion": model_version,
            "quickScan": p.quickScan,
            "scoredAt": scored_at,
        },
    }
