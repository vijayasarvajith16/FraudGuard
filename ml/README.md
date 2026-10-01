# FraudGuard ML pipeline

Trains the two models of the fraud-scoring cascade and registers them in MLflow (hosted on DagsHub):

| Model | Registry name | Algorithm | Stored as | Role |
|---|---|---|---|---|
| quick-scan | `fraudguard-quick-scan` | Isolation Forest (unsupervised) | skops (no pickle) | Scores **every** transaction synchronously; flags the anomalous ~5–10%. |
| deep-scan | `fraudguard-deep-scan` | XGBoost classifier | XGBoost native JSON | Scores only flagged transactions; its probability sets the risk tier. |

Training happens in **Google Colab**, not locally. Dataset: [Kaggle Credit Card Fraud](https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud) (`Time`, `V1`–`V28`, `Amount`, label `Class`; ~0.17% fraud). It is never committed.

## Layout

```
ml/
├── src/
│   ├── data.py               # load + validate + dedupe, stratified 60/20/20 split, split metadata
│   ├── train_quick_scan.py   # Isolation Forest, threshold chosen on validation recall vs flag rate
│   ├── train_deep_scan.py    # XGBoost with scale_pos_weight, early stopping on PR-AUC
│   ├── evaluate.py           # test-set metrics for quick / deep / cascade; regression gate (exit 1)
│   ├── promote.py            # promotion steps run by the model-promotion workflow (docs/mlops.md)
│   ├── metrics.py            # threshold selection, tiers, cascade metrics, plots
│   └── common.py             # feature list, MLflow config, run context, helpers
├── notebooks/train_in_colab.ipynb
├── tests/                    # fast sanity tests on synthetic data (no dataset needed)
├── requirements.txt          # pinned; must match the scan services' versions
└── requirements-dev.txt      # + pytest, ruff
```

## Run it in Colab (step by step)

1. **Tracking server.** Create a free repo on [DagsHub](https://dagshub.com) (you can connect it to the GitHub repo). Open *Remote → Experiments* and copy the MLflow tracking URI, `https://dagshub.com/<user>/<repo>.mlflow`. Create a token under *Settings → Tokens*.
2. **Dataset.** Download `creditcard.csv` from Kaggle and upload it to Google Drive at `MyDrive/fraudguard/creditcard.csv`.
3. **Open the notebook.** In Colab: *File → Open notebook → GitHub*, then paste the repo URL and pick `ml/notebooks/train_in_colab.ipynb`. (For a private repo, upload the notebook instead and set `CODE_SOURCE = "drive"` with a copy of the repo in Drive.)
4. **Secrets.** In the Secrets panel (key icon), add the following and toggle *Notebook access* on for each:
   | Name | Value |
   |---|---|
   | `MLFLOW_TRACKING_URI` | `https://dagshub.com/<user>/<repo>.mlflow` |
   | `MLFLOW_TRACKING_USERNAME` | your DagsHub username |
   | `MLFLOW_TRACKING_PASSWORD` | your DagsHub token |
5. **Run all** (*Runtime → Run all*). A CPU runtime is enough; it takes a few minutes. The notebook:
   - writes the split metadata and logs it to each run,
   - trains and registers both models with alias **`candidate`**,
   - evaluates the cascade on the held-out test split with the gate `MIN_RECALL` / `MIN_PR_AUC`, logs an `evaluate-cascade-test` run, and saves `evaluation_report.json` to Drive.
6. **Review** the runs in DagsHub → Experiments: metrics, PR curves, confusion matrices, grid search results, feature importance.
7. **Promote.** Not in the notebook: run the **model-promotion** workflow (GitHub → Actions), or wait for its daily run. It evaluates the candidate against the floors and against production, and after your approval pins the version in the scan services' Helm values (Argo CD rolls it out) and moves alias **`production`** ([docs/mlops.md](../docs/mlops.md)).

Record the cascade line of the evaluation output (recall, precision, deep-scan traffic %). Those are the numbers for the README and your resume.

## Design choices

- **No accuracy anywhere.** With 0.17% fraud, approving everything is 99.8% accurate. The metrics are PR-AUC, and precision/recall/F1 at operating thresholds.
- **Duplicates dropped before splitting.** The dataset has ~1,000 exact duplicate rows; without deduplication, identical rows would appear in both train and test.
- **Quick-scan threshold** (`--target-recall 0.90`, `--max-flag-rate 0.10`): the lowest flag rate on validation that reaches 90% recall, capped at flagging 10% of traffic. If the target is out of reach, it takes the best recall at the cap and logs `val.target_met = 0`. The threshold is stored in the model metadata *and* as a registry tag, so the service never hard-codes it.
- **Quick-scan latency.** Scoring cost grows linearly with tree count (~0.08 ms per tree), so the forest uses 100 trees and all features (feature subsampling made scoring ~50% slower). Latency p50/p95 are logged per run; the model is saved with `n_jobs=1` because a thread pool per single-row request is pure overhead.
- **Deep-scan imbalance.** `scale_pos_weight = negatives / positives` (`--scale-pos-weight sqrt` gives softer weighting). Probabilities are therefore not calibrated frequencies; the tier thresholds (0.30 / 0.70 / 0.90, env-configurable in the service) are operating points, which the evaluation reports precision and recall for.
- **Deep-scan trains on all training rows**, not only rows quick-scan would flag: that uses every fraud example. The cascade evaluation measures the combined behaviour.
- **Cascade metrics.** Detected = any non-LOW tier (an action beyond logging). `recall_high_plus` counts only fraud that is stopped (OTP step-up or block). `deep_scan_traffic_pct` = share of all transactions reaching deep-scan.
- **No pickle.** Isolation Forest is saved with skops, which refuses unknown types; its allowlist is exactly `sklearn.tree._tree.Tree`. XGBoost is saved as native JSON.
- **Reproducibility.** Each run logs library versions, the dataset SHA-256, split sizes, seed and git commit. Scripts recompute the split and fail if it differs from `artifacts/split_metadata.json`.

## Evaluation gate

```bash
python src/evaluate.py --data <csv> \
  --quick-model models:/fraudguard-quick-scan@candidate \
  --deep-model  models:/fraudguard-deep-scan@candidate \
  --min-recall 0.75 --min-pr-auc 0.78 --min-precision 0.85 [--log-to-mlflow] [--output report.json]
```

The floors come from the measured production results in [docs/ml-results.md](../docs/ml-results.md). Exit code `0` = gates passed, `1` = a gate failed, `2` = error (e.g. model not found). In `cascade` mode, recall and precision are the cascade's, and PR-AUC is the deep-scan model's.

The dataset is checked before anything is scored, and a mismatch exits with `2`: `--expect-sha256 <hex>` must match the file, and a registry model's `dataset_sha256` tag (the data it was trained on) must match too. A truncated download that still parses therefore cannot produce metrics for a different test split. The model-promotion workflow runs this gate before every promotion ([docs/mlops.md](../docs/mlops.md)).

## Local development (no training)

```bash
cd ml
python -m venv .venv && .venv/Scripts/activate   # Windows; use .venv/bin/activate elsewhere
pip install -r requirements-dev.txt
pytest          # ~20 s: synthetic data, trains tiny models, exercises registry + gate
ruff check . && ruff format --check .
```

Without `MLFLOW_TRACKING_URI`, the scripts log to a local SQLite store at `artifacts/mlflow.db` (gitignored).
