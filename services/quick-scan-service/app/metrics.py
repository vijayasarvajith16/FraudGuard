"""Prometheus metrics. One registry per app instance keeps tests isolated."""

from __future__ import annotations

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    gc_collector,
    generate_latest,
    platform_collector,
    process_collector,
)

# Fine-grained low buckets: the scoring budget is p95 < 20 ms.
LATENCY_BUCKETS = (0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.1, 0.25)


class Metrics:
    def __init__(self, service: str) -> None:
        self.registry = CollectorRegistry()
        process_collector.ProcessCollector(registry=self.registry)
        platform_collector.PlatformCollector(registry=self.registry)
        gc_collector.GCCollector(registry=self.registry)
        r = self.registry

        self.http_requests = Counter(
            "http_requests_total", "HTTP requests handled", ["method", "route", "status"], registry=r
        )
        self.http_duration = Histogram(
            "http_request_duration_seconds", "HTTP request duration", ["method", "route"],
            buckets=LATENCY_BUCKETS, registry=r,
        )  # fmt: skip
        self.scan_requests = Counter("scan_requests_total", "Scoring requests by result", ["result"], registry=r)
        self.scan_latency = Histogram(
            "scan_latency_seconds", "Model scoring time (excludes HTTP)", buckets=LATENCY_BUCKETS, registry=r
        )
        self.scan_flagged = Counter("scan_flagged_total", "Transactions flagged for deep-scan", registry=r)
        self.model_info = Gauge(
            "model_version_info", "Loaded model (value is always 1)", ["name", "version", "alias", "source"], registry=r
        )

    def set_model(self, describe: dict) -> None:
        self.model_info.labels(
            name=describe["name"], version=describe["version"], alias=describe["alias"] or "", source=describe["source"]
        ).set(1)

    def render(self) -> bytes:
        return generate_latest(self.registry)
