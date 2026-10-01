"""Failure behaviour (docs/contracts.md §9): every uncertainty resolves toward review, never approval.

These tests stop, pause and restart real containers, and always restore them. They run last
(file order) and can be skipped with `-m "not disruptive"`.
"""

import os
import shlex
import subprocess
import time

import pytest
from conftest import REPO_ROOT, money

pytestmark = pytest.mark.disruptive
COMPOSE = shlex.split(os.environ.get("E2E_COMPOSE", "docker compose"))


def compose(*args, check=True):
    return subprocess.run([*COMPOSE, *args], cwd=REPO_ROOT, check=check, capture_output=True, text=True, timeout=240)


def restore(service, timeout=180):
    """Unpause/start the service and wait until its healthcheck passes again.

    Not `up --wait`: a container that was paused is still marked unhealthy (its checks timed out)
    until the next check succeeds, and --wait fails on that stale state instead of waiting.
    """
    compose("unpause", service, check=False)  # no-op unless paused
    compose("up", "-d", "--no-deps", service)
    container = compose("ps", "-q", service).stdout.strip()
    deadline = time.monotonic() + timeout
    while True:
        health = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Health.Status}}", container], capture_output=True, text=True
        ).stdout.strip()
        if health == "healthy":
            return
        if time.monotonic() > deadline:
            pytest.fail(f"{service} not healthy {timeout}s after restore (last: {health})")
        time.sleep(1)


@pytest.fixture
def quick_scan():
    yield "quick-scan-service"
    restore("quick-scan-service")


@pytest.fixture
def deep_scan():
    yield "deep-scan-service"
    restore("deep-scan-service")


def test_quick_scan_timeout_sends_the_transfer_to_review_not_approval(new_user, bob, quick_scan, policy):
    alice = new_user("qs-timeout", deposit=100)
    compose("pause", quick_scan)  # accepts connections but never answers: the 300 ms timeout path

    started = time.monotonic()
    res = alice.transfer(bob, 10)
    elapsed = time.monotonic() - started

    assert res.status == 201, res
    tx = res.body["transaction"]
    assert tx["status"] == "UNDER_REVIEW"
    assert tx["quickScan"]["reason"] == "QUICK_SCAN_UNAVAILABLE"
    assert elapsed < 3, f"the hot path must not wait on a hung quick-scan ({elapsed:.1f}s)"
    assert alice.wallet()["held"] == 10

    # Deep-scan still scores it; the neutral vector is LOW, so it is approved *after* a real score.
    final = alice.wait_until_rest(tx["id"])
    assert final["deepScan"] is not None
    assert final["status"] == policy[final["riskTier"]]["resultingStatus"]
    assert [h["status"] for h in final["statusHistory"]][:2] == ["PENDING", "UNDER_REVIEW"]


def test_quick_scan_down_sends_the_transfer_to_review_and_recovers(new_user, bob, quick_scan, samples):
    alice = new_user("qs-down", deposit=100)
    compose("stop", quick_scan)  # connection refused: the error path

    res = alice.transfer(bob, 10)

    assert res.status == 201, res
    assert res.body["transaction"]["status"] == "UNDER_REVIEW"
    assert res.body["transaction"]["quickScan"]["reason"] == "QUICK_SCAN_UNAVAILABLE"

    restore(quick_scan)  # reloads the production model from the registry (~20 s)
    row = samples["categories"]["normal"][0]
    after = alice.transfer(bob, money(row["Amount"]), row)
    assert after.body["transaction"]["status"] == "APPROVED"
    assert after.body["transaction"]["quickScan"]["reason"] == "NORMAL"


SQUATTER = "e2e-ip-squatter"


@pytest.fixture
def auth_service():
    yield "auth-service"
    ids = subprocess.run(
        ["docker", "ps", "-aq", "--filter", f"name={SQUATTER}-"], capture_output=True, text=True
    ).stdout.split()
    if ids:
        subprocess.run(["docker", "rm", "-f", *ids], capture_output=True)
    restore("auth-service")


def container_ip(name):
    return subprocess.run(
        ["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def test_gateway_follows_a_redeployed_service_to_its_new_address(api, auth_service):
    """Regression: nginx used to keep upstream IPs from startup, so a recreated service got 502s."""
    old_container = compose("ps", "-q", auth_service).stdout.strip()
    old_ip = container_ip(old_container)
    network = subprocess.run(
        ["docker", "inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}", old_container],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    image = subprocess.run(
        ["docker", "inspect", "-f", "{{.Config.Image}}", old_container], capture_output=True, text=True, check=True
    ).stdout.strip()

    compose("rm", "-sf", auth_service)
    # Docker hands out the lowest free address, so park placeholders until one holds the freed
    # address; the recreated service is then guaranteed a different one.
    for i in range(32):
        name = f"{SQUATTER}-{i}"
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                name,
                "--network",
                network,
                "--entrypoint",
                "sleep",
                image,
                "300",
            ],
            capture_output=True,
            check=True,
        )
        if container_ip(name) == old_ip:
            break
    else:
        pytest.fail(f"could not reserve {old_ip} on {network}")
    restore(auth_service)
    new_ip = container_ip(compose("ps", "-q", auth_service).stdout.strip())
    assert new_ip != old_ip

    deadline = time.monotonic() + 20  # the upstream resolver's valid=10s, plus margin
    while True:
        res = api.call("POST", "/api/auth/login", {"email": "nobody@demo.test", "password": "x1x1x1x1"})
        if res.status == 401:  # reached auth-service (wrong credentials), not a gateway 502
            break
        assert time.monotonic() < deadline, f"gateway still answers {res.status} for the redeployed service"
        time.sleep(1)


def test_deep_scan_down_keeps_flagged_transfers_held_until_it_returns(new_user, bob, deep_scan, samples):
    alice = new_user("ds-down", deposit=1000)
    row = samples["categories"]["fraud"][0]
    compose("stop", deep_scan)

    res = alice.transfer(bob, money(row["Amount"]), row)
    assert res.status == 201, res
    tx_id = res.body["transaction"]["id"]
    time.sleep(6)  # longer than a retry cycle: nothing may resolve it while deep-scan is away
    waiting = alice.get(f"/api/transactions/{tx_id}").body["transaction"]
    assert waiting["status"] == "UNDER_REVIEW"
    assert waiting["deepScan"] is None
    assert alice.wallet()["held"] == money(row["Amount"])

    restore(deep_scan)  # the message waited durably in transactions.flagged
    final = alice.wait_until_rest(tx_id, timeout=60)
    assert final["deepScan"] is not None
    assert final["riskTier"] in {"MEDIUM", "HIGH", "CRITICAL"}
