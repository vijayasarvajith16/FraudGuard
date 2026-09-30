"""Business flows end to end: gateway -> auth / transaction-service -> quick-scan -> RabbitMQ ->
deep-scan -> alerting -> transaction-service, observed only through the public API.

Expectations come from the running system itself where they may legitimately change: the tier
policy is read from the admin API (§6.2), and rows are the demo samples (§0.8), so a new model or
policy file changes the outcome without breaking the tests' logic.
"""

import uuid

import pytest
from conftest import money

TIERS_ABOVE_LOW = {"MEDIUM", "HIGH", "CRITICAL"}


def header(res, name):
    return next((v for k, v in res.headers.items() if k.lower() == name.lower()), None)


def statuses(tx):
    return [h["status"] for h in tx["statusHistory"]]


def send_until_tier(user, recipient, rows, wanted):
    """Send rows until one rests at a tier in `wanted`. Returns (row, transaction)."""
    seen = []
    for row in rows:
        amount = money(row["Amount"])
        res = user.transfer(recipient, amount, row)
        assert res.status == 201, res
        tx = user.wait_until_rest(res.body["transaction"]["id"])
        seen.append(tx["riskTier"])
        if tx["riskTier"] in wanted:
            return row, tx
        if tx["status"] == "ACCOUNT_FROZEN":
            break  # sender frozen: no further transfers possible
    pytest.fail(
        f"no sample reached {sorted(wanted)} (got {seen}); if the models changed, regenerate the samples "
        "with `make demo-samples`"
    )


# ---- quick-scan approvals -------------------------------------------------------------------


def test_normal_row_is_approved_instantly_as_low(new_user, bob, samples):
    alice = new_user("normal", deposit=500)
    bob_before = bob.wallet()["balance"]
    row = samples["categories"]["normal"][0]
    amount = money(row["Amount"])

    res = alice.transfer(bob, amount, row)

    assert res.status == 201, res
    tx = res.body["transaction"]
    assert (tx["status"], tx["riskTier"], tx["action"]) == ("APPROVED", "LOW", "NONE")
    assert tx["quickScan"]["flagged"] is False
    assert tx["quickScan"]["reason"] == "NORMAL"
    assert tx["deepScan"] is None and tx["riskScore"] is None
    assert tx["finalizedAt"]
    assert statuses(tx) == ["PENDING", "APPROVED"]
    assert alice.wallet()["balance"] == money(500 - amount)
    assert alice.wallet()["held"] == 0
    assert bob.wallet()["balance"] == money(bob_before + amount)
    assert alice.alerts_for(tx["id"]) == []


def test_transfer_without_features_uses_the_neutral_vector_and_is_approved(new_user, bob):
    alice = new_user("neutral", deposit=100)
    res = alice.transfer(bob, 12.5)
    assert res.status == 201, res
    tx = res.body["transaction"]
    assert tx["status"] == "APPROVED"
    assert tx["features"]["Amount"] == 12.5
    assert all(tx["features"][f"V{i}"] == 0 for i in range(1, 29))


def test_idempotency_key_replays_once_and_rejects_a_changed_body(new_user, bob):
    alice = new_user("idem", deposit=100)
    key = str(uuid.uuid4())

    first = alice.transfer(bob, 10, key=key)
    replay = alice.transfer(bob, 10, key=key)
    changed = alice.transfer(bob, 11, key=key)

    assert first.status == 201, first
    assert replay.status == 200, replay
    assert header(replay, "Idempotent-Replayed") == "true"
    assert replay.body["transaction"]["id"] == first.body["transaction"]["id"]
    assert changed.status == 409 and changed.code == "IDEMPOTENCY_KEY_REUSED"
    assert alice.wallet()["balance"] == 90  # debited once


def test_validation_and_funds_errors_use_the_envelope(new_user, bob):
    alice = new_user("errors", deposit=5)
    too_much = alice.transfer(bob, 50)
    to_self = alice.transfer(alice, 1)
    no_key = alice.post("/api/transactions", {"recipientEmail": bob.email, "amount": 1})
    assert (too_much.status, too_much.code) == (422, "INSUFFICIENT_FUNDS")
    assert (to_self.status, to_self.code) == (400, "VALIDATION_ERROR")
    assert (no_key.status, no_key.code) == (400, "VALIDATION_ERROR")
    for res in (too_much, to_self, no_key):
        assert res.body["error"]["requestId"]
    assert alice.wallet()["balance"] == 5


# ---- deep-scan path -------------------------------------------------------------------------


def test_known_fraud_row_gets_the_action_mapped_for_its_tier(new_user, bob, samples, policy):
    alice = new_user("fraud", deposit=1000)
    row = samples["categories"]["fraud"][0]
    amount = money(row["Amount"])

    res = alice.transfer(bob, amount, row)

    assert res.status == 201, res
    created = res.body["transaction"]
    assert created["status"] == "UNDER_REVIEW"
    assert created["quickScan"]["flagged"] is True
    assert created["quickScan"]["reason"] == "ANOMALY"
    assert created["riskTier"] is None

    tx = alice.wait_until_rest(created["id"])
    tier = tx["riskTier"]
    rule = policy[tier]
    assert tier in TIERS_ABOVE_LOW
    assert tx["action"] == rule["action"]
    assert tx["status"] == rule["resultingStatus"]
    assert tx["riskScore"] == tx["deepScan"]["probability"]
    assert tx["deepScan"]["riskTier"] == tier
    assert statuses(tx)[:2] == ["PENDING", "UNDER_REVIEW"]
    alerts = alice.alerts_for(tx["id"])
    if rule["notifyUser"]:
        assert [(a["riskTier"], a["action"]) for a in alerts] == [(tier, rule["action"])]
    else:
        assert alerts == []


def test_critical_freezes_the_account_and_admin_approval_settles_it(new_user, bob, samples, admin):
    alice = new_user("critical", deposit=1000)
    row, tx = send_until_tier(alice, bob, samples["categories"]["fraud"], {"CRITICAL"})
    amount = money(row["Amount"])
    bob_before = bob.wallet()["balance"]

    assert (tx["status"], tx["action"]) == ("ACCOUNT_FROZEN", "BLOCK_AND_FREEZE")
    wallet = alice.wallet()
    assert wallet["frozen"] is True and wallet["held"] == amount
    blocked = alice.transfer(bob, 1)
    assert (blocked.status, blocked.code) == (423, "ACCOUNT_FROZEN")
    assert alice.post("/api/wallet/deposit", {"amount": 1}).status == 423
    assert alice.get("/api/alerts/admin/reviews").status == 403  # customers cannot see the queue

    queue = admin.get("/api/alerts/admin/reviews?status=OPEN")
    case = next(r for r in queue.body["items"] if r["transactionId"] == tx["id"])
    assert (case["riskTier"], case["amount"], case["userId"]) == ("CRITICAL", amount, alice.id)

    decided = admin.post(f"/api/alerts/admin/reviews/{case['id']}/decision", {"decision": "APPROVE", "note": "e2e"})
    assert decided.status == 200, decided
    assert decided.body["review"]["status"] == "RESOLVED"
    assert decided.body["transaction"]["status"] == "APPROVED"

    wallet = alice.wallet()
    assert (wallet["frozen"], wallet["held"], wallet["balance"]) == (False, 0, money(1000 - amount))
    assert bob.wallet()["balance"] == money(bob_before + amount)
    final = alice.get(f"/api/transactions/{tx['id']}").body["transaction"]
    assert final["statusHistory"][-1]["source"] == "admin"
    again = admin.post(f"/api/alerts/admin/reviews/{case['id']}/decision", {"decision": "REJECT"})
    assert (again.status, again.code) == (409, "REVIEW_ALREADY_RESOLVED")


def test_critical_rejection_returns_funds_and_keeps_the_account_frozen(new_user, bob, samples, admin):
    alice = new_user("reject", deposit=1000)
    _, tx = send_until_tier(alice, bob, samples["categories"]["fraud"], {"CRITICAL"})
    case = next(
        r for r in admin.get("/api/alerts/admin/reviews?status=OPEN").body["items"] if r["transactionId"] == tx["id"]
    )

    decided = admin.post(f"/api/alerts/admin/reviews/{case['id']}/decision", {"decision": "REJECT"})

    assert decided.status == 200, decided
    assert decided.body["transaction"]["status"] == "BLOCKED"
    wallet = alice.wallet()
    assert (wallet["frozen"], wallet["held"], wallet["balance"]) == (True, 0, 1000)
    assert alice.transfer(bob, 1).status == 423

    unfrozen = admin.post(f"/api/alerts/admin/accounts/{alice.id}/unfreeze")
    assert unfrozen.status == 200, unfrozen
    assert unfrozen.body["wallet"]["frozen"] is False
    assert alice.transfer(bob, 1).body["transaction"]["status"] == "APPROVED"


# ---- OTP step-up (HIGH) ---------------------------------------------------------------------


@pytest.fixture(scope="module")
def high_risk(new_user, bob, samples):
    """A sample the deployed model rates HIGH, and the probe transfer that found it (AWAITING_OTP)."""
    probe = new_user("otp", deposit=2000)
    row, tx = send_until_tier(probe, bob, samples["categories"]["suspicious"], {"HIGH"})
    return row, probe, tx


def otp_for(user, tx):
    alert = next(a for a in user.alerts_for(tx["id"]) if a["action"] == "OTP_STEP_UP")
    if not alert.get("simulatedOtp"):
        pytest.skip("EXPOSE_SIMULATED_OTP is off, so the code is not observable")
    return alert["simulatedOtp"]


def wrong(code):
    return "000000" if code != "000000" else "111111"


def test_high_risk_holds_funds_until_the_otp_is_verified(high_risk, bob):
    row, alice, tx = high_risk
    amount = money(row["Amount"])
    balance_before = alice.wallet()["balance"] + alice.wallet()["held"]
    assert (tx["status"], tx["action"]) == ("AWAITING_OTP", "OTP_STEP_UP")
    assert alice.wallet()["held"] >= amount
    code = otp_for(alice, tx)
    assert len(code) == 6 and code.isdigit()

    bad = alice.post("/api/alerts/otp/verify", {"transactionId": tx["id"], "code": wrong(code)})
    assert (bad.status, bad.code) == (400, "INVALID_OTP")
    assert bad.body["error"]["details"][0]["attemptsRemaining"] == 2

    good = alice.post("/api/alerts/otp/verify", {"transactionId": tx["id"], "code": code})
    assert good.status == 200, good
    assert good.body == {"transactionId": tx["id"], "status": "APPROVED"}
    final = alice.get(f"/api/transactions/{tx['id']}").body["transaction"]
    assert final["status"] == "APPROVED"
    assert final["statusHistory"][-1]["source"] == "otp"
    wallet = alice.wallet()
    assert money(wallet["balance"] + wallet["held"]) == money(balance_before - amount)

    replay = alice.post("/api/alerts/otp/verify", {"transactionId": tx["id"], "code": code})
    assert (replay.status, replay.code) == (409, "OTP_ALREADY_RESOLVED")
    other = bob.post("/api/alerts/otp/verify", {"transactionId": tx["id"], "code": code})
    assert other.status == 404  # someone else's challenge does not exist for them


def test_three_wrong_otps_block_the_transfer_and_release_the_funds(high_risk, new_user, bob):
    row = high_risk[0]
    amount = money(row["Amount"])
    alice = new_user("otp-fail", deposit=1000)
    res = alice.transfer(bob, amount, row)
    tx = alice.wait_until_rest(res.body["transaction"]["id"])
    assert tx["status"] == "AWAITING_OTP"
    bad = wrong(otp_for(alice, tx))

    remaining = []
    for _ in range(3):
        r = alice.post("/api/alerts/otp/verify", {"transactionId": tx["id"], "code": bad})
        assert (r.status, r.code) == (400, "INVALID_OTP")
        remaining.append(r.body["error"]["details"][0]["attemptsRemaining"])

    assert remaining == [2, 1, 0]
    assert alice.get(f"/api/transactions/{tx['id']}").body["transaction"]["status"] == "BLOCKED"
    wallet = alice.wallet()
    assert (wallet["balance"], wallet["held"], wallet["frozen"]) == (1000, 0, False)
