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

# Fine-grained low buckets: single-row scoring takes a few milliseconds.
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
        self.risk_tiers = Counter("risk_tier_total", "Scored transactions by risk tier", ["tier"], registry=r)
        self.queue_consumed = Counter(
            "queue_messages_consumed_total", "transactions.flagged deliveries by outcome", ["result"], registry=r
        )
        self.queue_latency = Histogram(
            "queue_processing_latency_seconds",
            "Time from the flagged event's occurredAt to ack of its scored result",
            buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300),
            registry=r,
        )
        self.model_info = Gauge(
            "model_version_info", "Loaded model (value is always 1)", ["name", "version", "alias", "source"], registry=r
        )

    def set_model(self, describe: dict) -> None:
        self.model_info.labels(
            name=describe["name"], version=describe["version"], alias=describe["alias"] or "", source=describe["source"]
        ).set(1)

    def render(self) -> bytes:
        return generate_latest(self.registry)
