"""Isolation Forest scoring (docs/contracts.md §4)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import skops.io as sio
from sklearn.ensemble import IsolationForest
from sklearn.ensemble._iforest import _average_path_length

from .model_loader import ModelArtifact, ModelLoadError
from .schemas import FEATURE_COLUMNS

# The service decides what is safe to deserialize, not the model file. An IsolationForest
# needs exactly this type; anything else means the model changed and needs a review.
SKOPS_TRUSTED_TYPES = ["sklearn.tree._tree.Tree"]

# The fast path must reproduce scikit-learn's scores to within this tolerance, or startup fails.
SELF_CHECK_TOLERANCE = 1e-12
SELF_CHECK_ROWS = 256


@dataclass(frozen=True)
class QuickScore:
    score: float
    flagged: bool


class _SingleRowForest:
    """Single-row Isolation Forest scoring without joblib's per-tree dispatch.

    scikit-learn's score_samples dispatches every tree as a joblib task, which costs far
    more than the tree traversal when scoring one transaction (~15-25 ms vs ~1 ms for 100
    trees in the container). This performs the same arithmetic, in the same order, as
    sklearn.ensemble._iforest._compute_score_samples (scikit-learn 1.9.1): per tree,
    depth += decision_path_length[leaf] + average_path_length[leaf] - 1, then
    score = 2 ** (-depth / (n_trees * c(max_samples))).
    It reads fitted private attributes, so QuickScanScorer verifies it against
    score_samples at startup and refuses to serve on any mismatch.
    """

    def __init__(self, model: IsolationForest) -> None:
        n_features = model.n_features_in_
        all_features = np.arange(n_features)
        self.trees = []
        for estimator, features, path_lengths, avg_lengths in zip(
            model.estimators_,
            model.estimators_features_,
            model._decision_path_lengths,
            model._average_path_length_per_tree,
            strict=True,
        ):
            subset = None if np.array_equal(features, all_features) else np.asarray(features)
            self.trees.append((estimator.tree_, subset, path_lengths, avg_lengths))
        self.denominator = float(len(model.estimators_) * _average_path_length([model._max_samples])[0])
        self.n_features = n_features

    def anomaly_score(self, x32: np.ndarray) -> float:
        """x32: float32, shape (1, n_features). Returns -score_samples(x), higher = more anomalous."""
        depth = 0.0
        for tree, subset, path_lengths, avg_lengths in self.trees:
            xs = x32 if subset is None else np.ascontiguousarray(x32[:, subset])
            leaf = tree.apply(xs)[0]
            depth += path_lengths[leaf] + avg_lengths[leaf] - 1.0
        # scikit-learn substitutes a ratio of 1 when the denominator is 0 (single-sample trees).
        ratio = depth / self.denominator if self.denominator != 0 else 1.0
        return float(2**-ratio)


class QuickScanScorer:
    def __init__(self, artifact: ModelArtifact, threshold_override: float | None = None) -> None:
        model_file = artifact.path / "model.skops"
        if not model_file.is_file():
            raise ModelLoadError(f"{model_file} not found (expected a skops-serialized IsolationForest)")

        untrusted = sio.get_untrusted_types(file=model_file)
        unexpected = sorted(set(untrusted) - set(SKOPS_TRUSTED_TYPES))
        if unexpected:
            raise ModelLoadError(f"model contains types outside the allowlist: {unexpected}")
        model = sio.load(model_file, trusted=SKOPS_TRUSTED_TYPES)
        # skops trusts standard scikit-learn types by default, so check the model kind explicitly.
        if type(model) is not IsolationForest:
            raise ModelLoadError(f"expected an IsolationForest, got {type(model).__name__}")

        names = list(getattr(model, "feature_names_in_", []))
        if names != FEATURE_COLUMNS:
            raise ModelLoadError(f"model features {names} do not match the contract order {FEATURE_COLUMNS}")
        # Requests are scored as plain arrays in FEATURE_COLUMNS order (just verified); drop the
        # stored names so scikit-learn does not warn about unnamed input during the self-check.
        del model.feature_names_in_
        model.set_params(n_jobs=1)

        try:
            self._forest = _SingleRowForest(model)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ModelLoadError(f"unsupported IsolationForest internals for fast scoring: {exc}") from exc
        self._self_check(model)

        threshold = threshold_override if threshold_override is not None else artifact.metadata.get("threshold")
        if threshold is None:
            raise ModelLoadError("model metadata has no 'threshold' and QUICK_SCAN_THRESHOLD is not set")
        self.threshold = float(threshold)
        self.artifact = artifact

    def _self_check(self, model: IsolationForest) -> None:
        """Fail startup unless the fast path matches scikit-learn on varied probe rows."""
        rng = np.random.default_rng(0)
        probes = rng.normal(scale=3.0, size=(SELF_CHECK_ROWS, self._forest.n_features))
        probes[:, 0] = rng.uniform(0, 172_800, SELF_CHECK_ROWS)  # Time
        probes[:, -1] = rng.lognormal(3, 1.5, SELF_CHECK_ROWS)  # Amount
        expected = -model.score_samples(probes)
        actual = np.array([self._forest.anomaly_score(row.reshape(1, -1).astype(np.float32)) for row in probes])
        worst = float(np.max(np.abs(actual - expected)))
        if worst > SELF_CHECK_TOLERANCE:
            raise ModelLoadError(f"fast scoring deviates from scikit-learn by {worst:.3e}; refusing to serve")

    def score(self, vector: list[float]) -> QuickScore:
        x32 = np.asarray(vector, dtype=np.float32).reshape(1, -1)
        score = self._forest.anomaly_score(x32)
        return QuickScore(score=score, flagged=score >= self.threshold)
