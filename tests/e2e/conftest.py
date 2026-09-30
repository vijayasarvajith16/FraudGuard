"""Fixtures for the end-to-end suite. It runs against the docker compose stack through the gateway
only, exactly like a client (docs/contracts.md §8); `make e2e` starts the stack and sets the env.

    E2E_GATEWAY_URL   gateway base URL (default http://127.0.0.1:8080)
    ADMIN_EMAIL / ADMIN_PASSWORD   the bootstrapped admin (from .env)
    E2E_COMPOSE       compose command for the resilience tests (default "docker compose")
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY = os.environ.get("E2E_GATEWAY_URL", "http://127.0.0.1:8080").rstrip("/")
PASSWORD = "e2e-pass-2026"
RESTING = {"APPROVED", "BLOCKED", "AWAITING_OTP", "ACCOUNT_FROZEN"}


class Api:
    """Minimal JSON client. Retries 429 honouring Retry-After (login is limited to 10/min per IP)."""

    def call(self, method, path, body=None, token=None, headers=None, max_wait=90.0):
        hdrs = {"Content-Type": "application/json", **(headers or {})}
        if token:
            hdrs["Authorization"] = f"Bearer {token}"
        data = None if body is None else json.dumps(body).encode()
        deadline = time.monotonic() + max_wait
        while True:
            req = urllib.request.Request(f"{GATEWAY}{path}", data=data, method=method, headers=hdrs)
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    return Response(res.status, dict(res.headers), _json(res.read()))
            except urllib.error.HTTPError as err:
                response = Response(err.code, dict(err.headers), _json(err.read()))
            if response.status != 429 or time.monotonic() > deadline:
                return response
            time.sleep(float(response.headers.get("Retry-After") or 1) + 0.5)


@dataclass
class Response:
    status: int
    headers: dict
    body: dict | None

    @property
    def code(self):
        return (self.body or {}).get("error", {}).get("code")


def _json(raw: bytes):
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return {"raw": raw[:200].decode(errors="replace")}


@dataclass
class User:
    api: Api
    email: str
    token: str
    id: str

    def get(self, path):
        return self.api.call("GET", path, token=self.token)

    def post(self, path, body=None, headers=None):
        return self.api.call("POST", path, body, token=self.token, headers=headers)

    def wallet(self):
        res = self.get("/api/wallet")
        assert res.status == 200, res
        return res.body["wallet"]

    def deposit(self, amount):
        res = self.post("/api/wallet/deposit", {"amount": amount})
        assert res.status == 200, res
        return res.body["wallet"]

    def transfer(self, recipient, amount, features=None, key=None):
        body = {"recipientEmail": recipient.email, "amount": amount}
        if features is not None:
            body["features"] = {**features, "Amount": amount}
        return self.post("/api/transactions", body, headers={"Idempotency-Key": key or str(uuid.uuid4())})

    def wait_until_rest(self, tx_id, timeout=45.0):
        """Poll like the frontend does until the transaction no longer depends on the pipeline."""
        deadline = time.monotonic() + timeout
        while True:
            res = self.get(f"/api/transactions/{tx_id}")
            assert res.status == 200, res
            tx = res.body["transaction"]
            if tx["status"] in RESTING:
                return tx
            if time.monotonic() > deadline:
                pytest.fail(f"transaction {tx_id} still {tx['status']} after {timeout}s: {tx}")
            time.sleep(0.5)

    def alerts_for(self, tx_id):
        res = self.get("/api/alerts?limit=100")
        assert res.status == 200, res
        return [a for a in res.body["items"] if a["transactionId"] == tx_id]


@pytest.fixture(scope="session")
def api():
    res = Api().call("GET", "/health")
    if res.status != 200:
        pytest.exit(f"gateway not reachable at {GATEWAY} (HTTP {res.status}); run `make e2e` or `make up`", 2)
    return Api()


@pytest.fixture(scope="session")
def new_user(api):
    """Factory: register and sign in a fresh demo user."""
    run = uuid.uuid4().hex[:6]
    count = 0

    def make(label="user", deposit=None):
        nonlocal count
        count += 1
        email = f"e2e-{run}-{label}-{count}@demo.test"
        res = api.call("POST", "/api/auth/register", {"email": email, "password": PASSWORD, "name": label})
        assert res.status == 201, res
        login = api.call("POST", "/api/auth/login", {"email": email, "password": PASSWORD})
        assert login.status == 200, login
        user = User(api, email, login.body["accessToken"], login.body["user"]["id"])
        if deposit:
            user.deposit(deposit)
        return user

    return make


@pytest.fixture(scope="session")
def bob(new_user):
    """A shared recipient."""
    return new_user("bob")


@pytest.fixture(scope="session")
def admin(api):
    email, password = os.environ.get("ADMIN_EMAIL"), os.environ.get("ADMIN_PASSWORD")
    if not (email and password):
        pytest.fail("ADMIN_EMAIL and ADMIN_PASSWORD must be set (make e2e reads them from .env)")
    res = api.call("POST", "/api/auth/login", {"email": email, "password": password})
    assert res.status == 200, res
    assert res.body["user"]["role"] == "admin"
    return User(api, email, res.body["accessToken"], res.body["user"]["id"])


@pytest.fixture(scope="session")
def policy(admin):
    """The tier -> action mapping the alerting-service is actually running (§6.2)."""
    res = admin.get("/api/alerts/admin/config/tier-actions")
    assert res.status == 200, res
    return res.body["policy"]["tiers"]


@pytest.fixture(scope="session")
def samples():
    """Real dataset rows by category (§0.8), the same ones the frontend offers."""
    doc = json.loads((REPO_ROOT / "frontend" / "src" / "demo" / "sampleFeatures.json").read_text(encoding="utf-8"))
    return doc


def money(value):
    return round(value, 2)
