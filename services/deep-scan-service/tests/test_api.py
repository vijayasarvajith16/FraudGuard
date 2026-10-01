import uuid

import pytest
from conftest import fraud_features, normal_features, settings_for
from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas import FEATURE_COLUMNS


def score(client, features, **extra):
    return client.post("/score", json={"features": features, **extra})


def test_normal_transaction_is_low_risk(client):
    res = score(client, normal_features())

    assert res.status_code == 200
    body = res.json()
    assert body["riskTier"] == "LOW"
    assert body["probability"] < 0.30
    assert body["thresholds"] == {"medium": 0.30, "high": 0.70, "critical": 0.90}
    assert (body["modelName"], body["modelVersion"]) == ("fraudguard-deep-scan", "local")


def test_fraud_like_transaction_is_critical(client):
    tx_id = str(uuid.uuid4())
    res = score(client, fraud_features(), transactionId=tx_id)

    assert res.status_code == 200
    assert res.json()["riskTier"] == "CRITICAL"
    assert res.json()["probability"] >= 0.90
    assert res.json()["transactionId"] == tx_id


def test_tier_thresholds_come_from_env(model_dir):
    settings = settings_for(model_dir, TIER_MEDIUM_MIN="0.001", TIER_HIGH_MIN="0.002", TIER_CRITICAL_MIN="0.999999")
    with TestClient(create_app(settings)) as c:
        body = score(c, fraud_features()).json()
    assert body["thresholds"] == {"medium": 0.001, "high": 0.002, "critical": 0.999999}
    assert body["riskTier"] == "HIGH"


@pytest.mark.parametrize(
    ("mutate", "field"),
    [
        (lambda f: f.pop("V14"), "features.V14"),
        (lambda f: f.update(V29=1.0), "features.V29"),
        (lambda f: f.update(V1="1.5"), "features.V1"),
        (lambda f: f.update(Amount=-1), "features.Amount"),
    ],
)
def test_invalid_features_return_400(client, mutate, field):
    features = normal_features()
    mutate(features)
    res = score(client, features)

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert field in [d["field"] for d in res.json()["error"]["details"]]


def test_nan_is_rejected(client):
    body = '{"features": {' + ", ".join(f'"{n}": {"NaN" if n == "V5" else 0}' for n in FEATURE_COLUMNS) + "}}"
    res = client.post("/score", content=body, headers={"Content-Type": "application/json"})
    assert res.status_code == 400


def test_health_and_metrics(client):
    score(client, normal_features())
    score(client, fraud_features())

    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["model"] == {"name": "fraudguard-deep-scan", "version": "local", "alias": None, "source": "local"}

    text = client.get("/metrics").text
    assert 'risk_tier_total{tier="LOW"} 1.0' in text
    assert 'risk_tier_total{tier="CRITICAL"} 1.0' in text
    assert 'scan_requests_total{result="flagged"} 1.0' in text
    assert 'model_version_info{alias="",name="fraudguard-deep-scan",source="local",version="local"} 1.0' in text
    assert "scan_latency_seconds_bucket" in text
    # Drift monitoring: the probability distribution (one normal, one fraud transaction).
    assert "scan_score_count 2.0" in text
    assert 'scan_score_bucket{le="0.3"} 1.0' in text
    assert 'scan_score_bucket{le="+Inf"} 2.0' in text


def test_error_envelope_and_request_id(client):
    res = client.get("/nope", headers={"X-Request-Id": "req-9"})
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "Not Found", "requestId": "req-9"}}
    assert res.headers["x-request-id"] == "req-9"
