"""Request/response models. The feature vector is exactly docs/contracts.md §0.8."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, create_model

FEATURE_COLUMNS: list[str] = ["Time", *[f"V{i}" for i in range(1, 29)], "Amount"]

# Strict: JSON numbers only (ints accepted), no strings/booleans, no NaN or infinity.
FeatureValue = Annotated[float, Field(strict=True, allow_inf_nan=False)]
NonNegativeFeatureValue = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0)]

Features = create_model(
    "Features",
    __config__=ConfigDict(extra="forbid"),
    **{
        name: (NonNegativeFeatureValue if name in ("Time", "Amount") else FeatureValue, ...) for name in FEATURE_COLUMNS
    },
)


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transactionId: UUID | None = None
    features: Features  # type: ignore[valid-type]

    def feature_vector(self) -> list[float]:
        """Values in the model's column order."""
        return [getattr(self.features, name) for name in FEATURE_COLUMNS]


class TierThresholdsModel(BaseModel):
    medium: float
    high: float
    critical: float


class DeepScoreResponse(BaseModel):
    transactionId: UUID | None
    probability: float = Field(ge=0, le=1)
    riskTier: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    thresholds: TierThresholdsModel
    modelName: str
    modelVersion: str


class ErrorBody(BaseModel):
    code: str
    message: str
    requestId: str | None = None
    details: list[dict] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
