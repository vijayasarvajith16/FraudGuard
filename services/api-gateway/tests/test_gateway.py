"""Black-box tests for the Nginx gateway (docs/contracts.md §8) against a running stack.

    GATEWAY_URL=http://127.0.0.1:8088 pytest services/api-gateway/tests   (or: make gateway-test)

Skipped when GATEWAY_URL is not set. Uses only the standard library.
"""

import json
import os
import urllib.error
import urllib.request
import uuid

import pytest

GATEWAY = os.environ.get("GATEWAY_URL", "").rstrip("/")
ALLOWED_ORIGIN = os.environ.get("GATEWAY_ALLOWED_ORIGIN", "http://localhost:5173")
pytestmark = pytest.mark.skipif(not GATEWAY, reason="GATEWAY_URL not set")


def call(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(
        f"{GATEWAY}{path}", method=method, data=data, headers={"Content-Type": "application/json", **(headers or {})}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            text = res.read().decode()
            return res.status, dict(res.headers), (json.loads(text) if text else None)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        try:
            payload = json.loads(text) if text else None
        except json.JSONDecodeError:
            payload = text
        return err.code, dict(err.headers), payload


def assert_envelope(body, code):
    assert body["error"]["code"] == code
    assert body["error"]["requestId"]


# ---- gateway itself -------------------------------------------------------------------------


def test_health_and_security_headers():
    status, headers, body = call("GET", "/health")
    assert status == 200
    assert body == {"status": "ok", "service": "api-gateway"}
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert headers["Server"] == "nginx"  # no version


def test_request_id_is_generated_echoed_and_sanitized():
    _, generated, _ = call("GET", "/health")
    assert len(generated["X-Request-Id"]) >= 16
    _, echoed, _ = call("GET", "/health", headers={"X-Request-Id": "client-req-42"})
    assert echoed["X-Request-Id"] == "client-req-42"
    _, replaced, _ = call("GET", "/health", headers={"X-Request-Id": "bad id with spaces"})
    assert replaced["X-Request-Id"] != "bad id with spaces"


def test_request_id_reaches_the_service_and_comes_back_once():
    status, headers, body = call("GET", "/api/wallet", headers={"X-Request-Id": "trace-me-123"})
    assert status == 401  # routed to transaction-service, which demands a token
    assert body["error"]["requestId"] == "trace-me-123"
    assert headers["X-Request-Id"] == "trace-me-123"


# ---- routing and deny list ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "expected_status"),
    [
        ("GET", "/api/auth/me", 401),
        ("GET", "/api/wallet", 401),
        ("GET", "/api/transactions", 401),
        ("GET", f"/api/transactions/{uuid.uuid4()}", 401),
        ("GET", "/api/alerts", 401),
        ("POST", "/api/alerts/otp/verify", 401),
    ],
)
def test_routes_reach_their_service(method, path, expected_status):
    status, _, body = call(method, path, body={} if method == "POST" else None)
    assert status == expected_status
    assert_envelope(body, "UNAUTHORIZED")


def test_registration_is_proxied():
    email = f"gw-{uuid.uuid4().hex[:8]}@demo.test"
    status, _, body = call("POST", "/api/auth/register", {"email": email, "password": "demo-pass-123", "name": "GW"})
    assert status == 201
    assert body["user"]["email"] == email


@pytest.mark.parametrize(
    "path",
    [
        "/api/auth/internal/users/lookup?email=a@b.co",
        "/api/transactions/internal/whatever",
        "/api/alerts/metrics",
        "/api/auth/health",
        "/api/wallet/health/live",
        "/api/auth/../../internal/users/lookup",  # normalized to /internal/... -> not an API route
        "/api/score",
        "/api/quick-scan/score",
        "/internal/transactions/x/status",
        "/metrics",
    ],
)
def test_internal_metrics_and_scan_routes_are_unreachable(path):
    status, _, body = call("GET", path)
    assert status == 404
    assert_envelope(body, "NOT_FOUND")


def test_unknown_api_route_uses_envelope():
    status, _, body = call("GET", "/api/nope")
    assert status == 404
    assert_envelope(body, "NOT_FOUND")


# ---- CORS -----------------------------------------------------------------------------------


def test_cors_preflight_for_an_allowed_origin():
    status, headers, _ = call(
        "OPTIONS",
        "/api/transactions",
        headers={"Origin": ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == ALLOWED_ORIGIN
    assert "PATCH" in headers["Access-Control-Allow-Methods"]
    assert "Idempotency-Key" in headers["Access-Control-Allow-Headers"]
    assert "Idempotent-Replayed" in headers["Access-Control-Expose-Headers"]


def test_no_cors_headers_for_an_unlisted_origin():
    _, headers, _ = call("OPTIONS", "/api/transactions", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in headers
    assert "Access-Control-Allow-Methods" not in headers


# ---- limits (rate-limit test last: it uses up this client's login budget for a minute) ------


def test_body_over_100kb_is_rejected_with_envelope():
    status, _, body = call("POST", "/api/auth/register", raw=b'{"x":"' + b"a" * 110_000 + b'"}')
    assert status == 413
    assert_envelope(body, "PAYLOAD_TOO_LARGE")


def test_zz_login_is_rate_limited_per_ip():
    statuses = []
    for i in range(10):
        status, headers, body = call("POST", "/api/auth/login", {"email": f"nobody{i}@x.co", "password": "x1x1x1x1"})
        statuses.append(status)
        if status == 429:
            assert_envelope(body, "RATE_LIMITED")
            assert headers["Retry-After"] == "1"
    # 10 req/min with burst 5: at most 6 get through.
    assert statuses.count(429) >= 4, statuses
