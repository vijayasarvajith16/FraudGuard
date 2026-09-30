"""XGBoost scoring (docs/contracts.md §5, §4.1)."""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import xgboost as xgb

from .config import TierThresholds
from .model_loader import ModelArtifact, ModelLoadError
from .schemas import FEATURE_COLUMNS


@dataclass(frozen=True)
class DeepScore:
    probability: float
    risk_tier: str


class DeepScanScorer:
    def __init__(self, artifact: ModelArtifact, tiers: TierThresholds) -> None:
        model_file = artifact.path / "model.json"
        if not model_file.is_file():
            raise ModelLoadError(f"{model_file} not found (expected an XGBoost model in native JSON format)")
        booster = xgb.Booster()
        booster.load_model(model_file)

        if booster.feature_names != FEATURE_COLUMNS:
            raise ModelLoadError(
                f"model features {booster.feature_names} do not match the contract order {FEATURE_COLUMNS}"
            )
        objective = json.loads(booster.save_config())["learner"]["objective"]["name"]
        if objective != "binary:logistic":
            raise ModelLoadError(f"expected objective binary:logistic (a probability), got {objective}")

        # Early stopping: the saved model holds every trained tree, but only the first
        # best_iteration + 1 are the selected model. Scoring with all of them is wrong.
        best_iteration = artifact.metadata.get("best_iteration")
        if best_iteration is None:
            raise ModelLoadError("model metadata has no 'best_iteration'")
        stored = booster.attr("best_iteration")
        if stored is not None and int(stored) != int(best_iteration):
            raise ModelLoadError(f"metadata best_iteration {best_iteration} != model attribute {stored}")

        booster.set_param({"nthread": 1})  # one transaction per request; avoid OpenMP overhead
        self.booster = booster
        self.iteration_range = (0, int(best_iteration) + 1)
        self.tiers = tiers
        self.artifact = artifact

    def score(self, vector: list[float]) -> DeepScore:
        x = np.asarray(vector, dtype=np.float32).reshape(1, -1)
        probability = float(self.booster.inplace_predict(x, iteration_range=self.iteration_range)[0])
        return DeepScore(probability=probability, risk_tier=self.tiers.tier_for(probability))
