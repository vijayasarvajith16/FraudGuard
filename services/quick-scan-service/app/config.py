"""Configuration from environment variables only (docs/contracts.md §10). Invalid config fails at startup."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

SERVICE_NAME = "quick-scan-service"
DEFAULT_MODEL_NAME = "fraudguard-quick-scan"


class _Env(BaseModel):
    model_config = ConfigDict(extra="ignore")

    PORT: Annotated[int, Field(ge=1, le=65535)] = 8001
    LOG_LEVEL: str = "INFO"
    MLFLOW_TRACKING_URI: str | None = None
    MODEL_URI: str = f"models:/{DEFAULT_MODEL_NAME}@production"
    ALLOW_LOCAL_MODEL_FALLBACK: bool = False
    LOCAL_MODEL_PATH: str | None = None
    QUICK_SCAN_THRESHOLD: float | None = None

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

    @field_validator("MLFLOW_TRACKING_URI", "LOCAL_MODEL_PATH", "QUICK_SCAN_THRESHOLD", mode="before")
    @classmethod
    def _empty_is_none(cls, v):
        return None if v == "" else v


@dataclass(frozen=True)
class Settings:
    port: int
    log_level: str
    tracking_uri: str | None
    model_uri: str
    allow_local_fallback: bool
    local_model_path: str | None
    threshold_override: float | None
    service_name: str = SERVICE_NAME


def load_settings(env: dict[str, str] | None = None) -> Settings:
    source = dict(os.environ if env is None else env)
    try:
        e = _Env.model_validate(source)
    except ValidationError as exc:
        problems = "\n".join(f"  - {'.'.join(map(str, err['loc']))}: {err['msg']}" for err in exc.errors())
        raise RuntimeError(f"Invalid configuration:\n{problems}") from None
    if e.ALLOW_LOCAL_MODEL_FALLBACK and not e.LOCAL_MODEL_PATH:
        raise RuntimeError(
            "Invalid configuration:\n  - LOCAL_MODEL_PATH is required when ALLOW_LOCAL_MODEL_FALLBACK=true"
        )
    return Settings(
        port=e.PORT,
        log_level=e.LOG_LEVEL,
        tracking_uri=e.MLFLOW_TRACKING_URI,
        model_uri=e.MODEL_URI,
        allow_local_fallback=e.ALLOW_LOCAL_MODEL_FALLBACK,
        local_model_path=e.LOCAL_MODEL_PATH,
        threshold_override=e.QUICK_SCAN_THRESHOLD,
    )
