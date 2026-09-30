import json
import random
import threading
import uuid
from collections import Counter

import pytest
from conftest import FRAUD_MARKER, JsonHandler

import replay
from creditcard import collect


class FakeGateway:
    """Enough of the gateway API for the replay tool, with scripted failures.

    - The first login answers 429 once; the first attempt of every transfer answers 503
      (the tool must retry with the same Idempotency-Key).
    - Rows with V1 == FRAUD_MARKER go UNDER_REVIEW and freeze the sender; listing them
      later shows ACCOUNT_FROZEN / CRITICAL, as after deep-scan and alerting.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.users = {}  # email -> {"password", "frozen"}
        self.transactions = []  # dicts with an extra "_owner"
        self.keys = Counter()  # Idempotency-Key -> attempts
        self.bodies = []
        self.logins_limited = False

    def handler(self):
        gw = self

        class Handler(JsonHandler):
            def owner(self):
                auth = self.headers.get("Authorization", "")
                return auth.removeprefix("Bearer tok-") if auth.startswith("Bearer tok-") else None

            def do_POST(self):
                body = self.read_json()
                with gw.lock:
                    self.route_post(body)

            def route_post(self, body):
                if self.path == "/api/auth/register":
                    if body["email"] in gw.users:
                        return self.reply(409, {"error": {"code": "EMAIL_TAKEN"}})
                    gw.users[body["email"]] = {"password": body["password"], "frozen": False}
                    return self.reply(201, {"user": {"email": body["email"]}})
                if self.path == "/api/auth/login":
                    if not gw.logins_limited:
                        gw.logins_limited = True
                        return self.reply(429, {"error": {"code": "RATE_LIMITED"}}, {"Retry-After": "1"})
                    return self.reply(200, {"accessToken": f"tok-{body['email']}"})
                email = self.owner()
                if email not in gw.users:
                    return self.reply(401, {"error": {"code": "UNAUTHORIZED"}})
                if self.path == "/api/wallet/deposit":
                    return self.reply(200, {"wallet": {"balance": body["amount"]}})
                if self.path == "/api/transactions":
                    return self.transfer(email, body)
                return self.reply(404, {"error": {"code": "NOT_FOUND"}})

            def transfer(self, email, body):
                gw.bodies.append(body)
                key = self.headers["Idempotency-Key"]
                gw.keys[key] += 1
                if gw.keys[key] == 1:
                    return self.reply(503, {"error": {"code": "SERVICE_UNAVAILABLE"}})
                if gw.users[email]["frozen"]:
                    return self.reply(423, {"error": {"code": "ACCOUNT_FROZEN"}})
                fraud = body["features"]["V1"] == FRAUD_MARKER
                tx = {
                    "id": str(uuid.uuid4()),
                    "amount": body["amount"],
                    "status": "UNDER_REVIEW" if fraud else "APPROVED",
                    "riskTier": None if fraud else "LOW",
                    "action": None if fraud else "NONE",
                    "deepScan": None,
                    "quickScan": {"reason": "ANOMALY" if fraud else "NORMAL"},
                    "_owner": email,
                }
                if fraud:
                    gw.users[email]["frozen"] = True
                gw.transactions.append(tx)
                self.reply(201, {"transaction": {k: v for k, v in tx.items() if k != "_owner"}})

            def do_GET(self):
                email = self.owner()
                if not self.path.startswith("/api/transactions?"):
                    return self.reply(404, {"error": {"code": "NOT_FOUND"}})
                with gw.lock:
                    mine = [t for t in reversed(gw.transactions) if t["_owner"] == email]
                    for tx in mine:  # deep-scan + alerting have run by the time anyone polls
                        if tx["status"] == "UNDER_REVIEW":
                            tx.update(status="ACCOUNT_FROZEN", riskTier="CRITICAL", action="BLOCK_AND_FREEZE")
                            tx["deepScan"] = {"probability": 0.99, "riskTier": "CRITICAL"}
                    # two items per page, to exercise cursor pagination
                    start = int(self.path.split("cursor=")[1]) if "cursor=" in self.path else 0
                    page = mine[start : start + 2]
                    cursor = str(start + 2) if start + 2 < len(mine) else None
                    items = [{k: v for k, v in t.items() if k != "_owner"} for t in page]
                self.reply(200, {"items": items, "nextCursor": cursor})

        return Handler


@pytest.fixture
def gateway(serve):
    fake = FakeGateway()
    server = serve(fake.handler())
    return fake, server.url


def make_replay(url, users=2):
    r = replay.Replay(
        replay.Gateway(url, sleep=lambda _s: None), "replay-test", "Replay-demo-2026", 500.0, random.Random(4)
    )
    for _ in range(users):
        r.add_user()
    return r


def test_replay_sends_every_row_and_summarizes_by_tier_and_label(dataset, gateway):
    fake, url = gateway
    pools = collect(dataset, normal_sample=6, rng=random.Random(2))
    plan = replay.build_plan(pools.fraud, pools.normal, count=9, fraud_ratio=1 / 3, rng=random.Random(2))
    r = make_replay(url)

    r.run(plan, rate=15)
    r.wait_for_outcomes(timeout=5, poll_interval=0)
    summary = replay.summarize(r.sent)

    assert summary["transfers"] == 9
    assert summary["byOutcome"]["CRITICAL"] == {"total": 3, "fraud": 3, "normal": 0}
    assert summary["byOutcome"]["LOW (quick-scan)"] == {"total": 6, "fraud": 0, "normal": 6}
    assert summary["statuses"] == {"ACCOUNT_FROZEN": 3, "APPROVED": 6}
    assert summary["fraudRowsEscalated"] == {"escalated": 3, "of": 3}
    # 3 senders were frozen, so replacements were registered on demand
    assert len(r.users) > 2
    assert sum(u["frozen"] for u in fake.users.values()) == 3


def test_amount_is_the_rows_own_amount_and_the_label_never_leaves(dataset, gateway):
    fake, url = gateway
    pools = collect(dataset, normal_sample=3, rng=random.Random(0))
    r = make_replay(url)
    r.run(pools.normal[:3], rate=15)
    for body, row in zip(fake.bodies[1::2], pools.normal[:3], strict=True):  # every 2nd: the retried attempt
        assert body["amount"] == round(row.amount, 2) == body["features"]["Amount"]
        assert "Class" not in json.dumps(body)
        assert set(body) == {"recipientEmail", "amount", "features"}


def test_retries_reuse_the_idempotency_key_and_honour_429(dataset, gateway):
    fake, url = gateway
    pools = collect(dataset, normal_sample=2, rng=random.Random(0))
    r = make_replay(url)
    r.run(pools.normal[:2], rate=15)
    assert all(count == 2 for count in fake.keys.values())  # 503 then success, same key
    assert len(fake.keys) == 2
    assert r.gateway.retries == Counter({"503": 2, "429": 1})


def test_rejections_are_reported_not_raised(serve):
    class Handler(JsonHandler):
        def do_POST(self):
            self.read_json()
            if self.path == "/api/transactions":
                return self.reply(404, {"error": {"code": "RECIPIENT_NOT_FOUND"}})
            self.reply(201 if self.path.endswith("register") else 200, {"accessToken": "tok-x"})

    url = serve(Handler).url
    r = make_replay(url)
    row = replay.Row({"Amount": 12.5, "V1": 0.0}, 0)
    item = r.send(row)
    assert item.rejected == "RECIPIENT_NOT_FOUND"
    assert replay.outcome(item) == "rejected"


def test_gateway_gives_up_after_bounded_retries(serve):
    class Handler(JsonHandler):
        def do_GET(self):
            self.reply(502, {"error": {"code": "SERVICE_UNAVAILABLE"}})

    gw = replay.Gateway(serve(Handler).url, sleep=lambda _s: None, max_retries=2)
    with pytest.raises(replay.GatewayError) as err:
        gw.request("GET", "/api/wallet")
    assert err.value.status == 502
    assert gw.retries == Counter({"502": 2})


def test_build_plan_is_exact_and_samples_with_replacement_when_short(dataset):
    pools = collect(dataset, normal_sample=12, rng=random.Random(0))
    plan = replay.build_plan(pools.fraud, pools.normal, count=10, fraud_ratio=0.3, rng=random.Random(0))
    assert len(plan) == 10
    assert sum(r.label for r in plan) == 3
    big = replay.build_plan(pools.fraud, pools.normal, count=10, fraud_ratio=0.8, rng=random.Random(0))
    assert sum(r.label for r in big) == 8  # only 4 distinct fraud rows: reused
    with pytest.raises(ValueError, match="normal rows"):
        replay.build_plan(pools.fraud, pools.normal[:1], count=10, fraud_ratio=0.1, rng=random.Random(0))


@pytest.mark.parametrize(
    ("tx", "expected"),
    [
        ({"riskTier": "LOW", "deepScan": None}, "LOW (quick-scan)"),
        ({"riskTier": "LOW", "deepScan": {"probability": 0.1}}, "LOW (deep-scan)"),
        ({"riskTier": "HIGH", "deepScan": {"probability": 0.8}}, "HIGH"),
        ({"riskTier": None, "deepScan": None}, "not scored yet"),
    ],
)
def test_outcome_classification(tx, expected):
    assert replay.outcome(replay.Sent(replay.Row({"Amount": 1.0}, 0), "a", tx)) == expected


@pytest.mark.parametrize(
    "argv",
    [
        ["x.csv", "--rate", "16"],
        ["x.csv", "--rate", "0"],
        ["x.csv", "--fraud-ratio", "1.5"],
        ["x.csv", "--users", "1"],
        ["x.csv", "--count", "0"],
    ],
)
def test_cli_rejects_out_of_range_options(argv):
    with pytest.raises(SystemExit):
        replay.parse_args(argv)
