"""Replay Kaggle credit-card rows as transfers through the FraudGuard gateway (docs/contracts.md §8.2).

    python tools/replay.py ml/data/creditcard.csv --count 100 --rate 2 --fraud-ratio 0.2

Registers and funds demo users, then sends each chosen row's feature vector as a transfer
between two of them, at a fixed rate. The transfer amount is the row's own Amount, so the
vector the models score is exactly the dataset row. The row label is only used locally for the
summary; it never leaves this process. At the end the tool waits for flagged transfers to
settle and logs outcome counts per risk tier, split by label.

Standard library only. Talks only to the gateway (/api/*).
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import random
import secrets
import signal
import sys
import time
import urllib.parse
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from creditcard import Row, collect

log = logging.getLogger("replay")

RESTING = frozenset({"APPROVED", "BLOCKED", "AWAITING_OTP", "ACCOUNT_FROZEN"})
RETRYABLE = frozenset({429, 500, 502, 503, 504})
MAX_RATE = 15.0  # the gateway allows 20 req/s per IP; leave room for polling and logins
OUTCOME_ORDER = (
    "LOW (quick-scan)",
    "LOW (deep-scan)",
    "MEDIUM",
    "HIGH",
    "CRITICAL",
    "not scored yet",
    "rejected",
)


class GatewayError(RuntimeError):
    def __init__(self, status: int, body: object) -> None:
        self.status = status
        self.body = body
        self.code = body.get("error", {}).get("code") if isinstance(body, dict) else None
        super().__init__(f"HTTP {status} {self.code or ''}".strip())


class Gateway:
    """JSON client for the gateway over one keep-alive connection.

    Retries 429 (honouring Retry-After), 5xx and connection errors with the *same* request,
    headers included, so a retried transfer reuses its Idempotency-Key.
    """

    def __init__(self, base_url: str, timeout: float = 15.0, max_retries: int = 5, sleep=time.sleep) -> None:
        parts = urllib.parse.urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"expected an http(s) gateway URL, got {base_url!r}")
        conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        self._new_conn = lambda: conn_cls(parts.hostname, parts.port, timeout=timeout)
        self._conn: http.client.HTTPConnection | None = None
        self.prefix = parts.path.rstrip("/")
        self.max_retries = max_retries
        self.sleep = sleep
        self.retries = Counter()

    def request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        token: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict | None]:
        """Return (status, json) for 2xx/4xx answers; raise GatewayError once retries run out."""
        hdrs = {"Content-Type": "application/json", "Accept": "application/json", **(headers or {})}
        if token:
            hdrs["Authorization"] = f"Bearer {token}"
        data = None if body is None else json.dumps(body)
        for attempt in range(self.max_retries + 1):
            try:
                status, res_headers, payload = self._send(method, self.prefix + path, data, hdrs)
            except (OSError, http.client.HTTPException) as err:
                if attempt == self.max_retries:
                    raise GatewayError(0, {"error": {"code": "NETWORK_ERROR", "message": str(err)}}) from err
                self.retries["network"] += 1
                self.sleep(min(0.5 * 2**attempt, 8))
                continue
            if status in RETRYABLE and attempt < self.max_retries:
                self.retries[str(status)] += 1
                retry_after = res_headers.get("retry-after")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 0.5 * 2**attempt
                self.sleep(min(max(delay, 0.5 * 2**attempt), 15))
                continue
            if status >= 500 or status == 429:
                raise GatewayError(status, payload)
            return status, payload
        raise AssertionError("unreachable")

    def _send(self, method: str, path: str, data: str | None, headers: dict[str, str]):
        if self._conn is None:
            self._conn = self._new_conn()
        try:
            self._conn.request(method, path, body=data, headers=headers)
            res = self._conn.getresponse()
            raw = res.read()
        except Exception:
            self._conn.close()
            self._conn = None
            raise
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = {"raw": raw[:200].decode(errors="replace")}
        return res.status, {k.lower(): v for k, v in res.getheaders()}, payload


@dataclass
class DemoUser:
    email: str
    token: str = ""
    frozen: bool = False


@dataclass
class Sent:
    row: Row
    sender: str
    transaction: dict | None = None  # latest known representation
    rejected: str | None = None  # error code when the gateway refused the transfer


@dataclass
class Replay:
    gateway: Gateway
    run_id: str
    password: str
    deposit: float
    rng: random.Random
    users: list[DemoUser] = field(default_factory=list)
    sent: list[Sent] = field(default_factory=list)
    stop_requested: bool = False

    # ---- demo users ----------------------------------------------------------------------

    def add_user(self) -> DemoUser:
        user = DemoUser(f"{self.run_id}-{len(self.users) + 1}@demo.test")
        status, body = self.gateway.request(
            "POST",
            "/api/auth/register",
            {"email": user.email, "password": self.password, "name": f"Replay {len(self.users) + 1}"},
        )
        if status not in (201, 409):  # 409 EMAIL_TAKEN: reusing a --run-id
            raise GatewayError(status, body)
        status, body = self.gateway.request("POST", "/api/auth/login", {"email": user.email, "password": self.password})
        if status != 200:
            raise GatewayError(status, body)
        user.token = body["accessToken"]
        self.top_up(user)
        self.users.append(user)
        log.info("demo user %s ready", user.email)
        return user

    def top_up(self, user: DemoUser) -> None:
        status, body = self.gateway.request("POST", "/api/wallet/deposit", {"amount": self.deposit}, user.token)
        if status == 423:
            user.frozen = True
        elif status != 200:
            raise GatewayError(status, body)

    def pick_pair(self) -> tuple[DemoUser, DemoUser]:
        active = [u for u in self.users if not u.frozen]
        if not active:
            log.info("every sender is frozen; adding a demo user")
            active = [self.add_user()]
        sender = self.rng.choice(active)
        recipients = [u for u in self.users if u is not sender]
        if not recipients:
            recipients = [self.add_user()]
        return sender, self.rng.choice(recipients)

    # ---- sending -------------------------------------------------------------------------

    def send(self, row: Row) -> Sent:
        amount = round(row.amount, 2)
        for _ in range(len(self.users) + 3):  # bounded: each pass retires a frozen sender or tops up
            sender, recipient = self.pick_pair()
            body = {"recipientEmail": recipient.email, "amount": amount, "features": row.features}
            status, res = self.gateway.request(
                "POST", "/api/transactions", body, sender.token, {"Idempotency-Key": str(uuid.uuid4())}
            )
            if status in (200, 201):
                return Sent(row, sender.email, res["transaction"])
            code = (res or {}).get("error", {}).get("code")
            if status == 423:
                sender.frozen = True
                log.info("%s is frozen (manual review pending); choosing another sender", sender.email)
                continue
            if status == 422 and code == "INSUFFICIENT_FUNDS":
                self.top_up(sender)
                continue
            return Sent(row, sender.email, rejected=code or f"HTTP_{status}")
        return Sent(row, "", rejected="NO_AVAILABLE_SENDER")

    def run(self, plan: list[Row], rate: float) -> None:
        interval = 1.0 / rate
        start = time.monotonic()
        for i, row in enumerate(plan, start=1):
            if self.stop_requested:
                log.warning("interrupted: stopping after %d of %d transfers", i - 1, len(plan))
                break
            delay = start + (i - 1) * interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            item = self.send(row)
            self.sent.append(item)
            log.info("[%*d/%d] %s", len(str(len(plan))), i, len(plan), describe(item))
        elapsed = time.monotonic() - start
        log.info("sent %d transfers in %.1fs (%.2f/s)", len(self.sent), elapsed, len(self.sent) / max(elapsed, 1e-9))

    # ---- waiting for outcomes ------------------------------------------------------------

    def wait_for_outcomes(self, timeout: float, poll_interval: float = 2.0) -> None:
        """Poll each sender's transaction list (one request per page, not per transfer)."""
        deadline = time.monotonic() + timeout
        tokens = {u.email: u.token for u in self.users}
        while True:
            pending = [s for s in self.sent if s.transaction and s.transaction["status"] not in RESTING]
            if not pending:
                return
            if time.monotonic() >= deadline:
                log.warning("%d transfers still under review after %.0fs", len(pending), timeout)
                return
            log.info("waiting for %d flagged transfers to be scored...", len(pending))
            time.sleep(poll_interval)
            by_id = {s.transaction["id"]: s for s in pending}
            for sender in sorted({s.sender for s in pending}):
                for tx in self.list_transactions(tokens[sender], want=by_id.keys()):
                    by_id[tx["id"]].transaction = tx

    def list_transactions(self, token: str, want) -> list[dict]:
        """The wanted transactions from one sender's history (newest first, paged)."""
        wanted, found, cursor = set(want), [], None
        while True:
            query = "?limit=100" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
            status, body = self.gateway.request("GET", f"/api/transactions{query}", token=token)
            if status != 200:
                raise GatewayError(status, body)
            found += [tx for tx in body["items"] if tx["id"] in wanted]
            cursor = body["nextCursor"]
            if not cursor or {tx["id"] for tx in found} >= wanted:
                return found


# ---- planning and reporting --------------------------------------------------------------


def build_plan(fraud: list[Row], normal: list[Row], count: int, fraud_ratio: float, rng: random.Random) -> list[Row]:
    """Exactly round(count * fraud_ratio) fraud rows, the rest normal, shuffled."""
    n_fraud = round(count * fraud_ratio)
    if n_fraud and not fraud:
        raise ValueError("the dataset has no usable fraud rows")
    if n_fraud > len(fraud):
        log.warning("only %d distinct fraud rows; some will be sent more than once", len(fraud))
        picked_fraud = [rng.choice(fraud) for _ in range(n_fraud)]
    else:
        picked_fraud = rng.sample(fraud, n_fraud)
    n_normal = count - n_fraud
    if n_normal > len(normal):
        raise ValueError(f"need {n_normal} normal rows, only {len(normal)} sampled")
    plan = picked_fraud + rng.sample(normal, n_normal)
    rng.shuffle(plan)
    return plan


def outcome(item: Sent) -> str:
    if item.rejected:
        return "rejected"
    tx = item.transaction or {}
    tier = tx.get("riskTier")
    if tier is None:
        return "not scored yet"
    if tier == "LOW":
        return "LOW (deep-scan)" if tx.get("deepScan") else "LOW (quick-scan)"
    return tier


def describe(item: Sent) -> str:
    label = "fraud " if item.row.label else "normal"
    if item.rejected:
        return f"{label} ${item.row.amount:>9,.2f}  rejected: {item.rejected}"
    tx = item.transaction
    reason = (tx.get("quickScan") or {}).get("reason", "")
    return f"{label} ${tx['amount']:>9,.2f}  {tx['status']:<12} quick-scan {reason}"


def summarize(sent: list[Sent]) -> dict:
    by_outcome = {name: {"total": 0, "fraud": 0, "normal": 0} for name in OUTCOME_ORDER}
    for item in sent:
        cell = by_outcome[outcome(item)]
        cell["total"] += 1
        cell["fraud" if item.row.label else "normal"] += 1
    statuses = Counter(s.transaction["status"] for s in sent if s.transaction)
    actions = Counter(s.transaction.get("action") or "pending" for s in sent if s.transaction)
    rejected = Counter(s.rejected for s in sent if s.rejected)
    fraud_total = sum(1 for s in sent if s.row.label and not s.rejected)
    fraud_escalated = sum(1 for s in sent if s.row.label and outcome(s) in ("MEDIUM", "HIGH", "CRITICAL"))
    return {
        "transfers": len(sent),
        "byOutcome": by_outcome,
        "statuses": dict(statuses),
        "actions": dict(actions),
        "rejected": dict(rejected),
        "fraudRowsEscalated": {"escalated": fraud_escalated, "of": fraud_total},
    }


def log_summary(summary: dict) -> None:
    log.info("")
    log.info("%-18s %7s %7s %7s", "outcome by tier", "total", "fraud", "normal")
    for name in OUTCOME_ORDER:
        cell = summary["byOutcome"][name]
        if cell["total"] or name not in ("not scored yet", "rejected"):
            log.info("%-18s %7d %7d %7d", name, cell["total"], cell["fraud"], cell["normal"])
    log.info("statuses: %s", ", ".join(f"{k} {v}" for k, v in sorted(summary["statuses"].items())) or "none")
    log.info("actions:  %s", ", ".join(f"{k} {v}" for k, v in sorted(summary["actions"].items())) or "none")
    if summary["rejected"]:
        log.info("rejected: %s", ", ".join(f"{k} {v}" for k, v in summary["rejected"].items()))
    esc = summary["fraudRowsEscalated"]
    if esc["of"]:
        log.info("fraud rows escalated to MEDIUM or above: %d of %d", esc["escalated"], esc["of"])


# ---- CLI ---------------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", type=Path, help="path to the Kaggle creditcard.csv")
    p.add_argument(
        "--gateway",
        default=os.environ.get("GATEWAY_URL", "http://127.0.0.1:8080"),
        help="gateway base URL (env GATEWAY_URL; default http://127.0.0.1:8080)",
    )
    p.add_argument("--count", type=int, default=50, help="transfers to send (default 50)")
    p.add_argument("--rate", type=float, default=2.0, help=f"transfers per second (default 2, max {MAX_RATE:g})")
    p.add_argument(
        "--fraud-ratio",
        type=float,
        default=None,
        help="fraction of rows drawn from fraud rows, e.g. 0.2 (default: the dataset's natural rate, ~0.17%%)",
    )
    p.add_argument("--users", type=int, default=6, help="demo users to create up front (default 6, min 2)")
    p.add_argument("--deposit", type=float, default=5000.0, help="initial deposit per demo user (default 5000)")
    p.add_argument("--password", default="Replay-demo-2026", help="password for the throwaway demo users")
    p.add_argument("--run-id", default=None, help="demo user email prefix (default: replay-<random>)")
    p.add_argument("--wait", type=float, default=60.0, help="seconds to wait for flagged transfers (default 60)")
    p.add_argument("--seed", type=int, default=None, help="seed for row selection and user pairing")
    p.add_argument("--report", type=Path, default=None, help="also write the summary as JSON")
    args = p.parse_args(argv)
    if args.count < 1:
        p.error("--count must be >= 1")
    if not 0 < args.rate <= MAX_RATE:
        p.error(f"--rate must be in (0, {MAX_RATE:g}]")
    if args.fraud_ratio is not None and not 0 <= args.fraud_ratio <= 1:
        p.error("--fraud-ratio must be within [0, 1]")
    if args.users < 2:
        p.error("--users must be >= 2 (a transfer needs a sender and a recipient)")
    if not 0 < args.deposit <= 1_000_000:
        p.error("--deposit must be in (0, 1000000]")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    rng = random.Random(args.seed)
    run_id = args.run_id or f"replay-{secrets.token_hex(3)}"

    log.info("reading %s ...", args.csv)
    pools = collect(args.csv, normal_sample=args.count, rng=rng)
    natural = len(pools.fraud) / max(len(pools.fraud) + pools.seen_normal, 1)
    ratio = natural if args.fraud_ratio is None else args.fraud_ratio
    plan = build_plan(pools.fraud, pools.normal, args.count, ratio, rng)
    n_fraud = sum(r.label for r in plan)
    log.info(
        "plan: %d transfers, %d from fraud rows (ratio %.4f%s); skipped %d rows with Amount 0",
        len(plan),
        n_fraud,
        ratio,
        ", natural rate" if args.fraud_ratio is None else "",
        pools.skipped_zero_amount,
    )

    replay = Replay(Gateway(args.gateway), run_id, args.password, args.deposit, rng)

    def request_stop(*_):
        replay.stop_requested = True

    signal.signal(signal.SIGINT, request_stop)
    try:
        for _ in range(args.users):
            replay.add_user()
        replay.run(plan, args.rate)
        replay.wait_for_outcomes(args.wait)
    except GatewayError as err:
        log.error("gateway error: %s %s", err, json.dumps(err.body)[:300])
        if not replay.sent:
            return 2
    summary = summarize(replay.sent)
    summary["gatewayRetries"] = dict(replay.gateway.retries)
    log_summary(summary)
    if replay.users:
        log.info("")
        log.info(
            "log in to the UI as any demo user to see their alerts, e.g. %s / %s", replay.users[0].email, args.password
        )
    if args.report:
        args.report.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8", newline="\n")
        log.info("summary written to %s", args.report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
