"""Configuration from environment variables only (docs/contracts.md §10). Invalid config fails at startup."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

SERVICE_NAME = "deep-scan-service"
DEFAULT_MODEL_NAME = "fraudguard-deep-scan"

Probability = Annotated[float, Field(gt=0, lt=1)]


class _Env(BaseModel):
    model_config = ConfigDict(extra="ignore")

    PORT: Annotated[int, Field(ge=1, le=65535)] = 8002
    LOG_LEVEL: str = "INFO"
    MLFLOW_TRACKING_URI: str | None = None
    MODEL_URI: str = f"models:/{DEFAULT_MODEL_NAME}@production"
    ALLOW_LOCAL_MODEL_FALLBACK: bool = False
    LOCAL_MODEL_PATH: str | None = None
    # Risk tier thresholds on the fraud probability (docs/contracts.md §6.1).
    TIER_MEDIUM_MIN: Probability = 0.30
    TIER_HIGH_MIN: Probability = 0.70
    TIER_CRITICAL_MIN: Probability = 0.90

    @field_validator("LOG_LEVEL")
    @classmethod
    def _level(cls, v: str) -> str:
        v = v.upper()
        if v not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}:
            raise ValueError("must be one of CRITICAL, ERROR, WARNING, INFO, DEBUG")
        return v

    @field_validator("MODEL_URI")
    @classmethod
    def _model_uri(cls, v: str) -> str:
        if not v.startswith("models:/"):
            raise ValueError("must be a registry URI like models:/<name>@<alias> or models:/<name>/<version>")
        return v

    @field_validator("MLFLOW_TRACKING_URI", "LOCAL_MODEL_PATH", mode="before")
    @classmethod
    def _empty_is_none(cls, v):
        return None if v == "" else v


@dataclass(frozen=True)
class TierThresholds:
    medium: float
    high: float
    critical: float

    def tier_for(self, probability: float) -> str:
        """Lower bounds are inclusive: p == 0.30 is MEDIUM."""
        if probability >= self.critical:
            return "CRITICAL"
        if probability >= self.high:
            return "HIGH"
        if probability >= self.medium:
            return "MEDIUM"
        return "LOW"

    def as_dict(self) -> dict[str, float]:
        return {"medium": self.medium, "high": self.high, "critical": self.critical}


@dataclass(frozen=True)
class Settings:
    port: int
    log_level: str
    tracking_uri: str | None
    model_uri: str
    allow_local_fallback: bool
    local_model_path: str | None
    tiers: TierThresholds
    service_name: str = SERVICE_NAME


def load_settings(env: dict[str, str] | None = None) -> Settings:
    source = dict(os.environ if env is None else env)
    try:
        e = _Env.model_validate(source)
    except ValidationError as exc:
        problems = "\n".join(f"  - {'.'.join(map(str, err['loc']))}: {err['msg']}" for err in exc.errors())
        raise RuntimeError(f"Invalid configuration:\n{problems}") from None
    problems = []
    if e.ALLOW_LOCAL_MODEL_FALLBACK and not e.LOCAL_MODEL_PATH:
        problems.append("LOCAL_MODEL_PATH is required when ALLOW_LOCAL_MODEL_FALLBACK=true")
    if not e.TIER_MEDIUM_MIN < e.TIER_HIGH_MIN < e.TIER_CRITICAL_MIN:
        problems.append(
            "tier thresholds must satisfy TIER_MEDIUM_MIN < TIER_HIGH_MIN < TIER_CRITICAL_MIN, got "
            f"{e.TIER_MEDIUM_MIN} / {e.TIER_HIGH_MIN} / {e.TIER_CRITICAL_MIN}"
        )
    if problems:
        raise RuntimeError("Invalid configuration:\n" + "\n".join(f"  - {p}" for p in problems))
    return Settings(
        port=e.PORT,
        log_level=e.LOG_LEVEL,
        tracking_uri=e.MLFLOW_TRACKING_URI,
        model_uri=e.MODEL_URI,
        allow_local_fallback=e.ALLOW_LOCAL_MODEL_FALLBACK,
        local_model_path=e.LOCAL_MODEL_PATH,
        tiers=TierThresholds(e.TIER_MEDIUM_MIN, e.TIER_HIGH_MIN, e.TIER_CRITICAL_MIN),
    )
