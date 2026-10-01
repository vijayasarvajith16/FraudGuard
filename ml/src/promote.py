"""Promote evaluated models to production: the last step of the MLOps loop (docs/mlops.md).

Run by .github/workflows/model-promotion.yml, one subcommand per step:

    resolve     Which versions to evaluate (default: the `candidate` alias of each model) and which
                versions are in `production`.
    decide      promote or reject, from evaluate.py's JSON reports: the candidate passed the floors,
                does not regress against production, and does not send noticeably more traffic to
                deep-scan without a recall gain (comparisons skipped with --allow-regression, for
                rollbacks; never the floors).
    pin-values  Rewrite MODEL_URI in the scan services' Helm values: the version that runs is
                pinned in Git, and Argo CD rolls the pods when it changes.
    apply       Point the `production` alias at the versions and record the promotion on them.

Exit codes: 0 = done (for decide: a decision was made, see its output), 2 = error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from common import (
    CANDIDATE_ALIAS,
    DEEP_SCAN_MODEL_NAME,
    ML_ROOT,
    PRODUCTION_ALIAS,
    QUICK_SCAN_MODEL_NAME,
    log,
    setup_logging,
)

MODELS = {"quick": QUICK_SCAN_MODEL_NAME, "deep": DEEP_SCAN_MODEL_NAME}
VALUES_FILES = {"quick": "values-quick-scan-service.yaml", "deep": "values-deep-scan-service.yaml"}
DEFAULT_VALUES_DIR = ML_ROOT.parent / "infra" / "helm" / "values"
# Regression allowed against production before a candidate is rejected (absolute, on 0..1 metrics).
DEFAULT_TOLERANCE = 0.01
COMPARED = ("recall", "pr_auc")  # headline metrics that must not regress
# Cost: more traffic to deep-scan (percentage points of all transactions) is accepted only together
# with a real recall gain. The first promotion through this workflow (quick-scan v3) raised deep-scan
# traffic from 6.1% to 10.2% of transactions with exactly the same cascade results.
DEFAULT_MAX_TRAFFIC_INCREASE = 1.0
DEFAULT_MIN_RECALL_GAIN = 0.01
_MODEL_URI_LINE = re.compile(
    r'^(?P<indent>[ \t]*)MODEL_URI:[ \t]*"?models:/(?P<name>[^/@"\s]+)(?:@[\w-]+|/\d+)"?[ \t]*$', re.MULTILINE
)


def client():
    """Registry client for MLFLOW_TRACKING_URI. Never falls back to a local store: promoting into
    the wrong registry must be impossible."""
    from mlflow import MlflowClient

    uri = os.environ.get("MLFLOW_TRACKING_URI")
    if not uri:
        raise RuntimeError("MLFLOW_TRACKING_URI is not set")
    return MlflowClient(tracking_uri=uri, registry_uri=uri)


def _alias_version(registry, name: str, alias: str) -> str | None:
    from mlflow.exceptions import MlflowException

    try:
        return str(registry.get_model_version_by_alias(name, alias).version)
    except MlflowException:
        return None


# ---- resolve -------------------------------------------------------------------------------------


def resolve(registry, explicit: dict[str, str | None]) -> dict:
    """{"quick": {"candidate", "production"}, "deep": {...}, "same": bool}. Fails if a version is missing."""
    result: dict = {}
    for role, name in MODELS.items():
        candidate = explicit.get(role) or _alias_version(registry, name, CANDIDATE_ALIAS)
        if candidate is None:
            raise RuntimeError(f"{name} has no @{CANDIDATE_ALIAS} version and none was given")
        registry.get_model_version(name, candidate)  # raises if the version does not exist
        result[role] = {"candidate": str(candidate), "production": _alias_version(registry, name, PRODUCTION_ALIAS)}
    result["same"] = all(result[r]["candidate"] == result[r]["production"] for r in MODELS)
    return result


# ---- decide --------------------------------------------------------------------------------------


@dataclass
class Decision:
    promote: bool
    reasons: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return "promote" if self.promote else "reject"


def _traffic_cost(candidate: dict, production: dict, max_increase: float, min_gain: float) -> str | None:
    """Why the candidate's extra deep-scan traffic is not worth it, or None."""
    new = (candidate.get("cascade") or {}).get("deep_scan_traffic_pct")
    old = (production.get("cascade") or {}).get("deep_scan_traffic_pct")
    if new is None or old is None or new - old <= max_increase:
        return None
    gain = candidate["headline"]["recall"] - production["headline"]["recall"]
    if gain >= min_gain:
        return None
    return (
        f"cost: deep-scan traffic {old:.2f}% -> {new:.2f}% of transactions (+{new - old:.2f} points) "
        f"for a recall gain of {gain:+.4f} (more traffic needs at least +{min_gain})"
    )


def decide(
    candidate: dict,
    production: dict | None,
    tolerance: float,
    allow_regression: bool,
    *,
    max_traffic_increase: float = DEFAULT_MAX_TRAFFIC_INCREASE,
    min_recall_gain: float = DEFAULT_MIN_RECALL_GAIN,
) -> Decision:
    """Promote only a candidate that passed every floor, does not regress against production, and
    does not buy its results with deep-scan traffic that brings no recall."""
    reasons: list[str] = []
    gates = candidate.get("gates") or {}
    floors = {k: gates.get(f"min_{k}") for k in ("recall", "pr_auc", "precision")}
    missing = [k for k, v in floors.items() if v is None]
    if missing:
        reasons.append(f"the candidate was evaluated without the {', '.join(missing)} floor(s)")
    if not gates.get("passed"):
        reasons.extend(f"floor: {failure}" for failure in gates.get("failures") or ["gates did not pass"])
    if production is not None and not allow_regression:
        for metric in COMPARED:
            new, old = candidate["headline"][metric], production["headline"][metric]
            if new < old - tolerance:
                reasons.append(f"regression: {metric} {new:.4f} < production {old:.4f} - {tolerance}")
        cost = _traffic_cost(candidate, production, max_traffic_increase, min_recall_gain)
        if cost:
            reasons.append(cost)
    shas = {r.get("dataset_sha256") for r in (candidate, production) if r}
    if len(shas) > 1:
        reasons.append("the reports were computed on different datasets")
    return Decision(promote=not reasons, reasons=reasons)


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value * 100:.1f}%"


def _versions(report: dict) -> str:
    quick = report.get("quick_scan", {}).get("model", "?")
    deep = report.get("deep_scan", {}).get("model", "?")
    return f"{quick}<br>{deep}"


def _fmt(metric: str, value: float | None) -> str:
    """Recall and precision as percentages; PR-AUC is an area, shown as a score."""
    if value is None:
        return "-"
    return f"{value:.3f}" if metric == "pr_auc" else _pct(value)


def _headline(report: dict | None, metric: str) -> str:
    return _fmt(metric, report["headline"][metric]) if report else "-"


def _traffic(report: dict | None) -> str:
    """Share of transactions sent to deep-scan (evaluate.py reports it in percent)."""
    if not report or "cascade" not in report:
        return "-"
    return _pct(report["cascade"]["deep_scan_traffic_pct"] / 100)


def summary_markdown(decision: Decision, candidate: dict, production: dict | None, allow_regression: bool) -> str:
    gates = candidate.get("gates") or {}
    rows = [
        ("Cascade recall", "recall", gates.get("min_recall")),
        ("Cascade precision", "precision", gates.get("min_precision")),
        ("Deep-scan PR-AUC", "pr_auc", gates.get("min_pr_auc")),
    ]
    lines = [
        f"### Model promotion: **{decision.name}**",
        "",
        "| Metric (test split) | Production | Candidate | Floor |",
        "|---|---|---|---|",
        f"| Models | {_versions(production) if production else 'none'} | {_versions(candidate)} | |",
    ]
    for label, metric, floor in rows:
        prod, cand = _headline(production, metric), _headline(candidate, metric)
        lines.append(f"| {label} | {prod} | {cand} | {_fmt(metric, floor)} |")
    lines.append(f"| Sent to deep-scan | {_traffic(production)} | {_traffic(candidate)} | |")
    lines.append("")
    if decision.reasons:
        lines += [f"- {r}" for r in decision.reasons]
    else:
        lines.append(
            "Passed every floor"
            + (" (regression check skipped: --allow-regression)." if allow_regression else " and no regression.")
        )
    return "\n".join(lines) + "\n"


# ---- pin-values ----------------------------------------------------------------------------------


def pin_values(values_dir: Path, versions: dict[str, str]) -> list[Path]:
    """Point each scan service's MODEL_URI at its version. Returns the files that changed."""
    changed = []
    for role, filename in VALUES_FILES.items():
        path, name, version = values_dir / filename, MODELS[role], versions[role]
        text = path.read_text(encoding="utf-8")
        matches = [m for m in _MODEL_URI_LINE.finditer(text) if m["name"] == name]
        if len(matches) != 1:
            raise RuntimeError(f"{path}: expected exactly one MODEL_URI line for {name}, found {len(matches)}")
        m = matches[0]
        new_line = f"{m['indent']}MODEL_URI: models:/{name}/{version}"
        if m.group(0) != new_line:
            path.write_text(text[: m.start()] + new_line + text[m.end() :], encoding="utf-8", newline="\n")
            changed.append(path)
    return changed


# ---- apply ---------------------------------------------------------------------------------------


def apply(registry, versions: dict[str, str], report: dict | None, run_url: str | None, now: datetime) -> None:
    """Move `production` and record who promoted what, when, and on which evaluation."""
    tags = {"promotion.promoted_at": now.isoformat(timespec="seconds"), "promotion.run": run_url or "manual"}
    if report:
        tags.update({f"promotion.test.{k}": f"{v:.6f}" for k, v in report["headline"].items()})
        tags["promotion.dataset_sha256"] = report.get("dataset_sha256", "")
    for role, name in MODELS.items():
        version = versions[role]
        registry.get_model_version(name, version)  # raises if it does not exist
        registry.set_registered_model_alias(name, PRODUCTION_ALIAS, version)
        for key, value in tags.items():
            registry.set_model_version_tag(name, version, key, value)
        log.info("%s v%s -> @%s", name, version, PRODUCTION_ALIAS)


# ---- CLI -----------------------------------------------------------------------------------------


def _write_outputs(path: str | None, outputs: dict[str, str]) -> None:
    lines = "".join(f"{k}={v}\n" for k, v in outputs.items())
    print(lines, end="")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(lines)


def _read_json(path: str | None) -> dict | None:
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("resolve")
    p.add_argument("--quick", help="quick-scan version (default: @candidate)")
    p.add_argument("--deep", help="deep-scan version (default: @candidate)")
    p.add_argument("--github-output")

    p = sub.add_parser("decide")
    p.add_argument("--candidate", required=True, help="evaluate.py report of the candidate (with floors)")
    p.add_argument("--production", help="evaluate.py report of production (omit if there is none)")
    p.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    p.add_argument("--max-traffic-increase", type=float, default=DEFAULT_MAX_TRAFFIC_INCREASE)
    p.add_argument("--min-recall-gain", type=float, default=DEFAULT_MIN_RECALL_GAIN)
    p.add_argument("--allow-regression", action="store_true", help="deliberate rollback: skip the comparison")
    p.add_argument("--summary", help="append a markdown summary here (GITHUB_STEP_SUMMARY)")
    p.add_argument("--github-output")

    p = sub.add_parser("pin-values")
    p.add_argument("--quick", required=True)
    p.add_argument("--deep", required=True)
    p.add_argument("--values-dir", type=Path, default=DEFAULT_VALUES_DIR)

    p = sub.add_parser("apply")
    p.add_argument("--quick", required=True)
    p.add_argument("--deep", required=True)
    p.add_argument("--report", help="the candidate's evaluate.py report, recorded on the versions")
    p.add_argument("--run-url", help="the workflow run that promoted")

    args = parser.parse_args(argv)
    setup_logging()
    try:
        if args.command == "resolve":
            r = resolve(client(), {"quick": args.quick, "deep": args.deep})
            _write_outputs(
                args.github_output,
                {
                    "quick_candidate": r["quick"]["candidate"],
                    "deep_candidate": r["deep"]["candidate"],
                    "quick_production": r["quick"]["production"] or "",
                    "deep_production": r["deep"]["production"] or "",
                    "has_production": str(bool(r["quick"]["production"] and r["deep"]["production"])).lower(),
                    "same": str(r["same"]).lower(),
                },
            )
        elif args.command == "decide":
            candidate, production = _read_json(args.candidate), _read_json(args.production)
            decision = decide(
                candidate,
                production,
                args.tolerance,
                args.allow_regression,
                max_traffic_increase=args.max_traffic_increase,
                min_recall_gain=args.min_recall_gain,
            )
            text = summary_markdown(decision, candidate, production, args.allow_regression)
            if args.summary:
                with open(args.summary, "a", encoding="utf-8") as fh:
                    fh.write(text)
            log.info("decision: %s %s", decision.name, "; ".join(decision.reasons))
            _write_outputs(args.github_output, {"decision": decision.name})
        elif args.command == "pin-values":
            changed = pin_values(args.values_dir, {"quick": args.quick, "deep": args.deep})
            log.info("pinned: %s", ", ".join(str(p) for p in changed) or "already pinned, nothing changed")
        elif args.command == "apply":
            versions = {"quick": args.quick, "deep": args.deep}
            apply(client(), versions, _read_json(args.report), args.run_url, datetime.now(UTC))
    except Exception as exc:
        log.error("%s failed: %s", args.command, exc)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
