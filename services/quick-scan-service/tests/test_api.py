import math
import uuid

import pytest
from conftest import anomalous_features, normal_features

from app.schemas import FEATURE_COLUMNS


def score(client, features, **extra):
    return client.post("/score", json={"features": features, **extra})


def test_normal_transaction_is_not_flagged(client):
    res = score(client, normal_features())

    assert res.status_code == 200
    body = res.json()
    assert body["flagged"] is False
    assert body["score"] < body["threshold"]
    assert body["modelName"] == "fraudguard-quick-scan"
    assert body["modelVersion"] == "local"
    assert body["transactionId"] is None


def test_anomalous_transaction_is_flagged_and_echoes_transaction_id(client):
    tx_id = str(uuid.uuid4())
    res = score(client, anomalous_features(), transactionId=tx_id)

    assert res.status_code == 200
    assert res.json()["flagged"] is True
    assert res.json()["transactionId"] == tx_id


def test_integer_feature_values_are_accepted(client):
    features = {name: 0 for name in FEATURE_COLUMNS}
    assert score(client, features).status_code == 200


@pytest.mark.parametrize(
    ("mutate", "field"),
    [
        (lambda f: f.pop("V14"), "features.V14"),
        (lambda f: f.update(V29=1.0), "features.V29"),
        (lambda f: f.update(V1="1.5"), "features.V1"),
        (lambda f: f.update(V2=True), "features.V2"),
        (lambda f: f.update(V3=None), "features.V3"),
        (lambda f: f.update(Amount=-0.01), "features.Amount"),
        (lambda f: f.update(Time=-1), "features.Time"),
    ],
)
def test_invalid_features_return_400_with_field_details(client, mutate, field):
    features = normal_features()
    mutate(features)
    res = score(client, features)

    assert res.status_code == 400
    error = res.json()["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert field in [d["field"] for d in error["details"]]
    assert error["requestId"]


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e400"])
def test_non_finite_numbers_are_rejected(client, literal):
    body = '{"features": {' + ", ".join(f'"{n}": {literal if n == "V5" else 0}' for n in FEATURE_COLUMNS) + "}}"
    res = client.post("/score", content=body, headers={"Content-Type": "application/json"})
    assert res.status_code == 400


@pytest.mark.parametrize(
    "body",
    [
        {"features": normal_features(), "extra": 1},
        {"transactionId": "not-a-uuid", "features": normal_features()},
        {},
    ],
)
def test_malformed_requests_return_400(client, body):
    assert client.post("/score", json=body).status_code == 400


def test_malformed_json_returns_400(client):
    res = client.post("/score", content="{not json", headers={"Content-Type": "application/json"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_scores_are_deterministic(client):
    a = score(client, normal_features()).json()["score"]
    b = score(client, normal_features()).json()["score"]
    assert a == b and math.isfinite(a)


def test_health_reports_model(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {
        "status": "ok",
        "service": "quick-scan-service",
        "version": "1.0.0",
        "uptimeSeconds": res.json()["uptimeSeconds"],
        "checks": {"model": "ok"},
        "model": {"name": "fraudguard-quick-scan", "version": "local", "alias": None, "source": "local"},
    }
    assert client.get("/health/live").json() == {"status": "ok"}


def test_metrics_expose_scan_and_model_info(client):
    score(client, normal_features())
    score(client, anomalous_features())
    score(client, {"bad": 1})

    text = client.get("/metrics").text
    assert 'scan_requests_total{result="clean"} 1.0' in text
    assert 'scan_requests_total{result="flagged"} 1.0' in text
    assert "scan_flagged_total 1.0" in text
    assert 'model_version_info{alias="",name="fraudguard-quick-scan",source="local",version="local"} 1.0' in text
    assert 'http_requests_total{method="POST",route="/score",status="400"} 1.0' in text
    assert "scan_latency_seconds_bucket" in text


def test_request_id_is_echoed_or_generated(client):
    assert client.get("/health/live", headers={"X-Request-Id": "abc-123"}).headers["x-request-id"] == "abc-123"
    generated = client.get("/health/live", headers={"X-Request-Id": "bad id!"}).headers["x-request-id"]
    assert uuid.UUID(generated)


def test_unknown_route_uses_error_envelope(client):
    res = client.get("/nope")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"
