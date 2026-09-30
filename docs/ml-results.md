# ML results (production models)

Measured results for the models currently behind the `production` alias. The README and resume bullets quote this file, so every number here traces back to an MLflow run.

## Provenance

| | |
|---|---|
| Tracking server | https://dagshub.com/vijayasarvajith16/fraudguard.mlflow (experiment `fraudguard`) |
| Quick-scan model | `fraudguard-quick-scan` **v2** (`@production`), run `c587b698105a49819ad42d2068c0435f` |
| Deep-scan model | `fraudguard-deep-scan` **v2** (`@production`), run `2a5c9b1ae72e460e917c32b511055f22` |
| Evaluation run | `afd1eb474a8f469da2fec1ea4c20a2de` (`evaluate-cascade-test`) |
| Code | commit `54be1c6` |
| Dataset | Kaggle Credit Card Fraud, SHA-256 `76274b691b16a6c4…`, 283,726 rows after removing 1,081 exact duplicates |
| Split | stratified 60/20/20, seed 42: train 170,235 / validation 56,745 / test 56,746 (95 fraud) |
| Environment | Google Colab CPU, Python 3.13.15, scikit-learn 1.9.1, XGBoost 3.4.1, MLflow 3.16.1 |
| Date | 2026-09-30 |

Two independent training and evaluation runs produced identical models (same threshold, 0.389108…) and identical test metrics.

## Cascade (held-out test split)

| Metric | Value |
|---|---|
| Transactions sent to deep-scan | **6.10%** (3,462 of 56,746) |
| Fraud flagged by quick-scan | 84.2% (80 / 95) |
| Flagged fraud that deep-scan puts above LOW | 92.5% (74 / 80) |
| **Cascade recall** (fraud ending in any non-LOW tier) | **77.9%** (74 / 95) |
| **Cascade precision** | **93.7%** (74 / 79) |
| Cascade F1 | 0.851 |
| Recall of stopped fraud (HIGH or CRITICAL: OTP step-up or block) | 76.8% (73 / 95) |
| Precision of stopped transactions | **97.3%** (73 / 75) |

Tier distribution on test: LOW 56,667 (21 fraud), MEDIUM 4 (1 fraud), HIGH 4 (3 fraud), CRITICAL 71 (70 fraud).

## Per-model

| Model | Split | PR-AUC | ROC-AUC | Operating point |
|---|---|---|---|---|
| Quick-scan (Isolation Forest, 100 trees, max_samples 8192) | validation | 0.292 | 0.946 | threshold 0.3891: recall 90.4% at 5.96% flag rate |
| | test | 0.188 | 0.940 | recall 84.2% at 6.10% flag rate |
| Deep-scan (XGBoost, depth 5, 529 trees, scale_pos_weight 598) | validation | 0.885 | 0.973 | ≥0.30: P 91.0% / R 86.2% |
| | test | 0.825 | 0.973 | ≥0.30: P 93.9% / R 81.1%; ≥0.70: P 97.4% / R 77.9%; ≥0.90: P 98.6% / R 73.7% |

Quick-scan's low PR-AUC is expected: it is an unsupervised filter tuned for recall at a small flag rate, not a classifier. Its job is to discard ~94% of traffic cheaply while keeping most fraud.

## How to read these numbers

- **Small positive count.** The test split contains 95 fraud cases, so each one is worth ~1.05 percentage points of recall. Differences of a few points between validation and test (e.g. quick-scan 90.4% → 84.2%) are within sampling noise.
- **Where the misses are.** Of the 21 fraud cases that ended as LOW, 15 were never flagged by quick-scan and 6 were scored LOW by deep-scan. Quick-scan recall is the main lever for improvement.
- **Probabilities are not calibrated.** Deep-scan uses `scale_pos_weight ≈ 598`, so its scores are operating points rather than frequencies. Almost every flagged fraud lands in CRITICAL; the MEDIUM and HIGH bands are thin.
- **Latency.** Single-row scoring on Colab's shared CPU: quick-scan p50 12.7 ms / p95 21.8 ms, deep-scan p50 4.0 ms / p95 16.0 ms. Serving latency is measured in the scan services (Phase 4).

## Regression-gate floors

Set from these results with a margin of roughly 3 fraud cases on recall:

| Gate | Floor | Current |
|---|---|---|
| Cascade recall | 0.75 | 0.779 |
| Deep-scan PR-AUC | 0.78 | 0.825 |
| Cascade precision | 0.85 | 0.937 |
