"""Turn a load-test run into result tables (called by tests/load/run.sh).

Reads Prometheus through the Kubernetes API server proxy (no port-forward): the client-side numbers
come from k6's native histograms (exact percentiles across all k6 pods), the server-side ones from
the services, kube-state-metrics and RabbitMQ. Autoscaler changes come from the watcher's
events.log, which samples every few seconds (Prometheus only every 15 s).

Writes summary.md and summary.json next to the events log. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

CONTEXT = "kind-fraudguard"
PROXY = "/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/"
REQ = 'name="POST /api/transactions"'
REPLICAS = "kube_horizontalpodautoscaler_status_current_replicas"


def prom(endpoint: str, **params: str | float) -> list[dict]:
    query = urllib.parse.urlencode(params)
    out = subprocess.run(
        ["kubectl", "--context", CONTEXT, "get", "--raw", f"{PROXY}{endpoint}?{query}"],
        capture_output=True,
        text=True,
        check=True,
    )
    body = json.loads(out.stdout)
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus: {body}")
    return body["data"]["result"]


def value(expr: str, at: float) -> float | None:
    result = prom("query", query=expr, time=at)
    if not result:
        return None
    v = float(result[0]["value"][1])
    return None if math.isnan(v) else v


def series(expr: str, start: float, end: float, step: int = 5) -> list[tuple[float, float]]:
    result = prom("query_range", query=expr, start=start, end=end, step=step)
    return [(float(t), float(v)) for t, v in result[0]["values"]] if result else []


@dataclass
class Event:
    t: int
    kind: str
    name: str
    fields: dict[str, int]
    text: str


def read_events(path: Path) -> tuple[int, int, list[Event]]:
    start = end = 0
    events: list[Event] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        t = int(parts[0])
        if parts[1] == "start":
            start = t
        elif parts[1] == "end":
            end = t
        elif parts[1] == "hpa":
            fields = {k: int(v) for k, v in (p.split("=") for p in parts[3:])}
            events.append(Event(t, "hpa", parts[2], fields, ""))
        elif parts[1] == "drill":
            events.append(Event(t, "drill", parts[2], {}, " ".join(parts[3:])))
    return start, end, events


def stage_windows(profile: dict, start: int) -> list[tuple[str, int, int, float]]:
    """(label, from, to, per-pod target) for each labeled (held) stage."""
    windows, t = [], start
    for stage in profile["stages"]:
        seconds = int(stage["duration"].rstrip("s"))
        if stage.get("label"):
            windows.append((stage["label"], t, t + seconds, stage["target"]))
        t += seconds
    return windows


def ms(seconds: float | None) -> str:
    return "-" if seconds is None else f"{seconds * 1000:.0f} ms" if seconds >= 0.01 else f"{seconds * 1000:.1f} ms"


def pct(ratio: float | None) -> str:
    return "-" if ratio is None else f"{ratio * 100:.2f}%"


def num(v: float | None, fmt: str = "{:.0f}") -> str:
    return "-" if v is None else fmt.format(v)


def clock(t: float, start: int) -> str:
    s = round(t - start)
    sign = "-" if s < 0 else ""
    return f"{sign}{abs(s) // 60}:{abs(s) % 60:02d}"


def stage_row(run: str, label: str, t0: int, t1: int, target: float, pods: int) -> dict:
    d = t1 - t0
    sel = f'testid="{run}", {REQ}'
    total = value(f"sum(increase(k6_http_reqs_total{{{sel}}}[{d}s]))", t1)
    failed = value(f'sum(increase(k6_http_reqs_total{{{sel}, expected_response="false"}}[{d}s]))', t1) or 0.0
    hist = f"sum(increase(k6_http_req_duration_seconds{{{sel}}}[{d}s]))"
    qs_hpa = 'horizontalpodautoscaler="quick-scan-service"'
    ds_hpa = 'horizontalpodautoscaler="deep-scan-service"'
    return {
        "stage": label,
        "target_rps": target * pods,
        "achieved_rps": None if total is None else total / d,
        "p50": value(f"histogram_quantile(0.50, {hist})", t1),
        "p95": value(f"histogram_quantile(0.95, {hist})", t1),
        "p99": value(f"histogram_quantile(0.99, {hist})", t1),
        "error_rate": None if not total else failed / total,
        "dropped": value(f'sum(increase(k6_dropped_iterations_total{{testid="{run}"}}[{d}s]))', t1),
        "quick_scan_pods": value(f"max_over_time({REPLICAS}{{{qs_hpa}}}[{d}s])", t1),
        "quick_scan_cpu": value(
            "avg_over_time(kube_horizontalpodautoscaler_status_target_metric"
            f'{{{qs_hpa}, metric_name="cpu", metric_target_type="utilization"}}[{d}s])',
            t1,
        ),
        "quick_scan_p95": value(
            "histogram_quantile(0.95, sum by (le) (increase("
            f'scan_latency_seconds_bucket{{app_kubernetes_io_name="quick-scan-service"}}[{d}s])))',
            t1,
        ),
        "transaction_cpu": value(
            "sum(rate(container_cpu_usage_seconds_total"
            f'{{namespace="fraudguard", container="transaction-service"}}[{d}s]))',
            t1,
        ),
        "deep_share": value(
            f'sum(increase(transactions_created_total{{status="UNDER_REVIEW"}}[{d}s]))'
            f" / sum(increase(transactions_created_total[{d}s]))",
            t1,
        ),
        "queue_max": value(
            f'max_over_time(sum(rabbitmq_detailed_queue_messages_ready{{queue="transactions.flagged"}})[{d}s:5s])', t1
        ),
        "deep_scan_pods": value(f"max_over_time({REPLICAS}{{{ds_hpa}}}[{d}s])", t1),
    }


def scaling_rows(run: str, start: int, events: list[Event]) -> list[dict]:
    """One row per change of desired replicas (the decision) or ready replicas (capacity online)."""
    rows, last = [], {}
    for e in events:
        if e.kind == "drill":
            rows.append({"t": e.t, "what": f"drill: {e.name} {e.text}", "metric": "", "load": None})
            continue
        prev = last.get(e.name)
        last[e.name] = e.fields
        if prev is None:
            continue
        load = value(f'sum(rate(k6_http_reqs_total{{testid="{run}", {REQ}}}[30s]))', e.t)
        if e.name == "quick-scan-service":
            m = value(
                'kube_horizontalpodautoscaler_status_target_metric{horizontalpodautoscaler="quick-scan-service", '
                'metric_name="cpu", metric_target_type="utilization"}',
                e.t,
            )
            metric = f"CPU {num(m)}% of request (target 60%)"
        else:
            m = value('sum(rabbitmq_detailed_queue_messages_ready{queue="transactions.flagged"})', e.t)
            metric = f"{num(m)} messages waiting (target 20 per pod)"
        for key, label in (("desired", "desired"), ("ready", "ready")):
            if e.fields[key] != prev[key]:
                rows.append(
                    {
                        "t": e.t,
                        "what": f"{e.name}: {label} {prev[key]} -> {e.fields[key]}",
                        "metric": metric,
                        "load": load,
                    }
                )
    return rows


def backlog_summary(start: int, end: int, events: list[Event]) -> dict | None:
    drill = {e.text.split()[0]: e.t for e in events if e.kind == "drill"}
    if "resumed" not in drill:
        return None
    queue = series('sum(rabbitmq_detailed_queue_messages_ready{queue="transactions.flagged"})', start, end + 45)
    peak_t, peak = max(queue, key=lambda p: p[1]) if queue else (0, 0)
    drained = next((t for t, v in queue if t > peak_t and v == 0), None)
    verdict = series(
        "histogram_quantile(0.95, sum by (le) (rate("
        'queue_processing_latency_seconds_bucket{app_kubernetes_io_name="deep-scan-service"}[1m])))',
        start,
        end + 45,
    )
    return {
        "outage_seconds": drill["resumed"] - drill["stopped"],
        "peak_messages": peak,
        "peak_at": peak_t,
        "drained_at": drained,
        "drain_seconds": None if drained is None else drained - drill["resumed"],
        "verdict_p95_max": max((v for _, v in verdict if not math.isnan(v)), default=None),
    }


def render(
    run: str,
    profile_name: str,
    pods: int,
    start: int,
    stages: list[dict],
    scaling: list[dict],
    totals: dict,
    backlog: dict | None,
) -> str:
    out = [
        f"# Load test {run} ({profile_name}, {pods} k6 pods)",
        "",
        "| Stage | Target | Achieved | p50 | p95 | p99 | Errors | quick-scan pods | quick-scan CPU (HPA) "
        "| quick-scan scoring p95 | transaction-service CPU | To deep-scan | Queue max | deep-scan pods |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for s in stages:
        out.append(
            f"| {s['stage']} | {s['target_rps']:.0f}/s | {num(s['achieved_rps'], '{:.1f}')}/s | {ms(s['p50'])} "
            f"| {ms(s['p95'])} | {ms(s['p99'])} | {pct(s['error_rate'])} | {num(s['quick_scan_pods'])} "
            f"| {num(s['quick_scan_cpu'])}% | {ms(s['quick_scan_p95'])} | {num(s['transaction_cpu'], '{:.2f}')} cores "
            f"| {pct(s['deep_share'])} | {num(s['queue_max'])} | {num(s['deep_scan_pods'])} |"
        )
    out += [
        "",
        f"Whole run: {num(totals['requests'])} transfers, p95 {ms(totals['p95'])}, p99 {ms(totals['p99'])}, "
        f"errors {pct(totals['error_rate'])}, dropped iterations {num(totals['dropped'])}.",
        "",
        "## Autoscaling events",
        "",
        "| Time (from start) | Change | Metric at that moment | Load |",
        "|---|---|---|---|",
    ]
    for r in scaling:
        load = "" if r["load"] is None else f"{r['load']:.0f}/s"
        out.append(f"| {clock(r['t'], start)} | {r['what']} | {r['metric']} | {load} |")
    if backlog:
        out += [
            "",
            "## Consumer outage",
            "",
            f"- deep-scan was down for {backlog['outage_seconds']} s; the backlog peaked at "
            f"{backlog['peak_messages']:.0f} messages ({clock(backlog['peak_at'], start)}).",
            f"- Drained {num(backlog['drain_seconds'])} s after deep-scan came back"
            + ("" if backlog["drained_at"] is None else f" ({clock(backlog['drained_at'], start)})")
            + f"; time-to-verdict p95 peaked at {num(backlog['verdict_p95_max'], '{:.1f}')} s.",
        ]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run-id", required=True)
    p.add_argument("--profile", type=Path, required=True)
    p.add_argument("--pods", type=int, required=True)
    p.add_argument("--events", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args(argv)

    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    start, end, events = read_events(args.events)
    run = args.run_id
    stages = [stage_row(run, *w, args.pods) for w in stage_windows(profile, start)]
    d = end - start
    sel = f'testid="{run}", {REQ}'
    hist = f"sum(increase(k6_http_req_duration_seconds{{{sel}}}[{d}s]))"
    total = value(f"sum(increase(k6_http_reqs_total{{{sel}}}[{d}s]))", end)
    failed = value(f'sum(increase(k6_http_reqs_total{{{sel}, expected_response="false"}}[{d}s]))', end) or 0.0
    totals = {
        "requests": total,
        "p95": value(f"histogram_quantile(0.95, {hist})", end),
        "p99": value(f"histogram_quantile(0.99, {hist})", end),
        "error_rate": None if not total else failed / total,
        "dropped": value(f'sum(increase(k6_dropped_iterations_total{{testid="{run}"}}[{d}s]))', end) or 0.0,
    }
    scaling = scaling_rows(run, start, events)
    backlog = backlog_summary(start, end, events)

    text = render(run, args.profile.stem, args.pods, start, stages, scaling, totals, backlog)
    (args.out / "summary.md").write_text(text, encoding="utf-8", newline="\n")
    doc = {"run": run, "start": start, "end": end, "stages": stages, "scaling": scaling, "totals": totals}
    doc["backlog"] = backlog
    (args.out / "summary.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
