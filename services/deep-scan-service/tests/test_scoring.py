"""Scoring correctness and model-loading rules (docs/contracts.md §4.1, §6.1)."""

from pathlib import Path

import numpy as np
import pytest
import xgboost as xgb
from conftest import LABELS, TRAIN, fraud_features, normal_features, save_model_dir, train_booster
from fastapi.testclient import TestClient

from app.config import TierThresholds, load_settings
from app.main import create_app
from app.model_loader import ModelArtifact, ModelLoadError
from app.schemas import FEATURE_COLUMNS
from app.scorer import DeepScanScorer

TIERS = TierThresholds(0.30, 0.70, 0.90)


def artifact(path, metadata):
    return ModelArtifact(Path(path), "fraudguard-deep-scan", "5", "production", "registry", metadata)


def test_scores_use_only_the_early_stopped_trees(booster, model_dir):
    assert booster.num_boosted_rounds() > booster.best_iteration + 1, "fixture must have trees past best_iteration"
    scorer = DeepScanScorer(artifact(model_dir, {"best_iteration": booster.best_iteration}), TIERS)
    rows = TRAIN.sample(50, random_state=1)

    served = np.array([scorer.score(list(row)).probability for row in rows.to_numpy()])
    expected = booster.predict(xgb.DMatrix(rows), iteration_range=(0, booster.best_iteration + 1))
    all_trees = booster.predict(xgb.DMatrix(rows))

    np.testing.assert_allclose(served, expected, rtol=1e-6)
    assert not np.allclose(served, all_trees), "scoring with all trees would give different probabilities"


@pytest.mark.parametrize(
    ("probability", "tier"),
    [
        (0.0, "LOW"),
        (0.2999, "LOW"),
        (0.30, "MEDIUM"),
        (0.6999, "MEDIUM"),
        (0.70, "HIGH"),
        (0.90, "CRITICAL"),
        (1.0, "CRITICAL"),
    ],
)
def test_tier_boundaries_are_inclusive(probability, tier):
    assert TIERS.tier_for(probability) == tier


def test_missing_best_iteration_fails(tmp_path, booster):
    save_model_dir(tmp_path, booster, {})
    with pytest.raises(ModelLoadError, match="best_iteration"):
        DeepScanScorer(artifact(tmp_path, {}), TIERS)


def test_best_iteration_mismatch_fails(model_dir, booster):
    with pytest.raises(ModelLoadError, match="!= model attribute"):
        DeepScanScorer(artifact(model_dir, {"best_iteration": booster.best_iteration + 3}), TIERS)


def test_regression_objective_is_refused(tmp_path):
    reg = xgb.train({"objective": "reg:squarederror"}, xgb.DMatrix(TRAIN, label=LABELS), num_boost_round=3)
    save_model_dir(tmp_path, reg, {"best_iteration": 2})
    with pytest.raises(ModelLoadError, match="binary:logistic"):
        DeepScanScorer(artifact(tmp_path, {"best_iteration": 2}), TIERS)


def test_feature_order_mismatch_fails(tmp_path):
    reordered = TRAIN[list(reversed(FEATURE_COLUMNS))]
    b = xgb.train({"objective": "binary:logistic"}, xgb.DMatrix(reordered, label=LABELS), num_boost_round=3)
    save_model_dir(tmp_path, b, {"best_iteration": 2})
    with pytest.raises(ModelLoadError, match="do not match the contract order"):
        DeepScanScorer(artifact(tmp_path, {"best_iteration": 2}), TIERS)


def test_missing_model_file_fails(tmp_path):
    (tmp_path / "MLmodel").write_text("metadata: {best_iteration: 1}\n")
    with pytest.raises(ModelLoadError, match=r"model\.json"):
        DeepScanScorer(artifact(tmp_path, {"best_iteration": 1}), TIERS)


def test_startup_fails_loudly_without_registry_or_fallback():
    with (
        pytest.raises(ModelLoadError, match="MLFLOW_TRACKING_URI is not set"),
        TestClient(create_app(load_settings({"CONSUMER_ENABLED": "false"}))),
    ):
        pass


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"TIER_MEDIUM_MIN": "0.8"}, "TIER_MEDIUM_MIN < TIER_HIGH_MIN < TIER_CRITICAL_MIN"),
        ({"TIER_CRITICAL_MIN": "1.0"}, "TIER_CRITICAL_MIN"),
        ({"TIER_MEDIUM_MIN": "0"}, "TIER_MEDIUM_MIN"),
        ({"ALLOW_LOCAL_MODEL_FALLBACK": "true"}, "LOCAL_MODEL_PATH is required"),
        ({}, "RABBITMQ_URL is required when CONSUMER_ENABLED=true"),
        ({"RABBITMQ_URL": "http://broker"}, "must be an amqp"),
    ],
)
def test_invalid_config_is_rejected(env, message):
    with pytest.raises(RuntimeError, match=message):
        load_settings(env)


def test_early_stopping_fixture_separates_classes():
    b = train_booster()
    scorer_input = [normal_features(), fraud_features()]
    probs = b.predict(
        xgb.DMatrix(np.array([[f[n] for n in FEATURE_COLUMNS] for f in scorer_input]), feature_names=FEATURE_COLUMNS),
        iteration_range=(0, b.best_iteration + 1),
    )
    assert probs[0] < 0.3 < 0.9 < probs[1]
