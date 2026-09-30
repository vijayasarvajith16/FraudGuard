"""quick-scan-service HTTP API (docs/contracts.md §4)."""

from __future__ import annotations

import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import DEFAULT_MODEL_NAME, Settings, load_settings
from .metrics import Metrics
from .model_loader import ModelLoadError, fetch_model
from .schemas import ErrorResponse, QuickScoreResponse, ScoreRequest
from .scorer import QuickScanScorer

log = logging.getLogger("quick_scan")

_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_QUIET_PATHS = ("/health", "/metrics")


def error_response(status: int, code: str, message: str, request: Request, details: list | None = None):
    body = {"code": code, "message": message, "requestId": getattr(request.state, "request_id", None)}
    if details:
        body["details"] = details
    return JSONResponse({"error": body}, status_code=status)


def create_app(settings: Settings | None = None, scorer: QuickScanScorer | None = None) -> FastAPI:
    """Build the app. Without an injected scorer, the model is loaded at startup; failure aborts startup."""
    settings = settings or load_settings()
    metrics = Metrics(settings.service_name)
    started_at = time.monotonic()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        active = scorer
        if active is None:
            try:
                artifact = fetch_model(settings, DEFAULT_MODEL_NAME)
                active = QuickScanScorer(artifact, settings.threshold_override)
            except ModelLoadError as exc:
                # Fail loudly (docs/contracts.md §4.1): never serve without the intended model.
                log.critical("model load failed; refusing to start", extra={"error": str(exc)})
                raise
        app.state.scorer = active
        metrics.set_model(active.artifact.describe())
        log.info(
            "model loaded",
            extra={"model": active.artifact.describe(), "threshold": active.threshold},
        )
        yield

    app = FastAPI(
        title="FraudGuard quick-scan",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
        responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        incoming = request.headers.get("x-request-id")
        request.state.request_id = incoming if incoming and _VALID_REQUEST_ID.match(incoming) else str(uuid.uuid4())
        start = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - start

        route = request.scope.get("route")
        route_path = route.path if route is not None else "unmatched"
        metrics.http_requests.labels(request.method, route_path, response.status_code).inc()
        metrics.http_duration.labels(request.method, route_path).observe(elapsed)
        response.headers["X-Request-Id"] = request.state.request_id
        if not request.url.path.startswith(_QUIET_PATHS):
            log.info(
                "request completed",
                extra={
                    "requestId": request.state.request_id,
                    "method": request.method,
                    "route": route_path,
                    "status": response.status_code,
                    "durationMs": round(elapsed * 1000, 2),
                },
            )
        return response

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(str(p) for p in err["loc"] if p != "body") or "(body)", "issue": err["msg"]}
            for err in exc.errors()
        ]
        return error_response(400, "VALIDATION_ERROR", "Request validation failed", request, details)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(request: Request, exc: StarletteHTTPException):
        codes = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "PAYLOAD_TOO_LARGE"}
        return error_response(exc.status_code, codes.get(exc.status_code, "HTTP_ERROR"), str(exc.detail), request)

    @app.exception_handler(Exception)
    async def on_unhandled(request: Request, exc: Exception):
        log.exception("unhandled error", extra={"requestId": getattr(request.state, "request_id", None)})
        return error_response(500, "INTERNAL_ERROR", "Internal server error", request)

    @app.post("/score", response_model=QuickScoreResponse)
    async def score(body: ScoreRequest, request: Request):
        # Scoring runs inline on the event loop on purpose: it takes ~1 ms of pure CPU. In the
        # threadpool, concurrent requests contend for the GIL and each one's latency grows with
        # the number in flight; inline, requests are served FIFO with no contention.
        active: QuickScanScorer | None = getattr(request.app.state, "scorer", None)
        if active is None:
            metrics.scan_requests.labels("error").inc()
            return error_response(503, "MODEL_NOT_LOADED", "Model is not loaded", request)

        with metrics.scan_latency.time():
            result = active.score(body.feature_vector())
        metrics.scan_requests.labels("flagged" if result.flagged else "clean").inc()
        if result.flagged:
            metrics.scan_flagged.inc()

        return QuickScoreResponse(
            transactionId=body.transactionId,
            score=result.score,
            threshold=active.threshold,
            flagged=result.flagged,
            modelName=active.artifact.name,
            modelVersion=active.artifact.version,
        )

    @app.get("/health/live")
    def live():
        return {"status": "ok"}

    @app.get("/health")
    def health(request: Request):
        active: QuickScanScorer | None = getattr(request.app.state, "scorer", None)
        body = {
            "status": "ok" if active else "degraded",
            "service": settings.service_name,
            "version": __version__,
            "uptimeSeconds": round(time.monotonic() - started_at),
            "checks": {"model": "ok" if active else "fail"},
        }
        if active:
            body["model"] = active.artifact.describe()
        return JSONResponse(body, status_code=200 if active else 503)

    @app.get("/metrics")
    def prometheus_metrics():
        return Response(metrics.render(), media_type="text/plain; version=0.0.4; charset=utf-8")

    app.state.metrics = metrics
    return app
