# MLOps: the model lifecycle

How a fraud model gets from a training run to the scan services, and how it is watched once there.
The models and their measured results: docs/ml-results.md. The pipeline code: `ml/` (ml/README.md).

```
 train (Colab) ──► register @candidate ──► evaluate (CI) ──► approve ──► promote ──► roll out ──► monitor
 notebook          MLflow on DagsHub       test split,       GitHub      pin version   Argo CD      version panel,
                                           floors, no        environment in Git, move  rolls the    drift alert
                                           regression        reviewer    @production   scan pods        │
       ▲                                                                                                 │
       └────────────────────────────────────── retrain when drift or new data says so ◄─────────────────┘
```

## 1. Train (Google Colab)

`ml/notebooks/train_in_colab.ipynb` clones the repository, installs the pinned `ml/requirements.txt`
and runs the pipeline: deduplicated stratified split (seed 42), Isolation Forest for quick-scan,
XGBoost for deep-scan. MLflow credentials come from Colab Secrets only. To try a different candidate,
set `QUICK_SCAN_ARGS` / `DEEP_SCAN_ARGS` in its configuration cell, for example
`["--target-recall", "0.95"]` for a quick-scan that flags more fraud at a higher flag rate.

## 2. Register

Each training run registers a new version of `fraudguard-quick-scan` and `fraudguard-deep-scan` and
points the alias **`candidate`** at it. Every version carries:
- the tag `dataset_sha256`: the exact data it was trained on;
- quick-scan only: the tag `threshold`, and its training run's validation metrics, including
  `val.flag_rate` (the drift baseline, section 6).

The notebook also evaluates the candidate once, for the person training it. It does not promote
anything.

## 3. Evaluate (GitHub Actions, `model-promotion` workflow)

Runs daily at 05:17 UTC and on demand (*Actions → model-promotion → Run workflow*):

1. **Resolve**: which versions are `@candidate` and `@production`. If they are the same, the run
   ends: nothing to promote.
2. **Get the dataset**: the Kaggle Credit Card Fraud file, as published for the TensorFlow tutorials
   (the same bytes; the dataset is never in Git). The download must succeed (`curl --fail`) and match
   the pinned SHA-256 (`sha256sum --check --strict`) before it gets its final name.
3. **Evaluate** the candidate and production on the held-out test split with `ml/src/evaluate.py`.
   It verifies the dataset again before scoring anything: `--expect-sha256`, and each registry model's
   `dataset_sha256` tag. A truncated or different file exits with code 2 and stops the run. Before
   this check, half the dataset had "passed all gates" with inflated metrics.
4. **Decide** (`ml/src/promote.py decide`): promote only if the candidate passes every floor and does
   not regress against production. The job summary shows the comparison table.

| Rule | Value |
|---|---|
| Floors (test split) | cascade recall ≥ 0.75, cascade precision ≥ 0.85, deep-scan PR-AUC ≥ 0.78 |
| No regression | recall and PR-AUC at least production's minus 0.01 |
| A rejected candidate | fails a manual run; warns on a scheduled run, which re-checks daily until a new candidate is registered |

The evaluation job has no secrets: the registry allows anonymous reads.

## 4. Approve and promote

The `promote` job runs only for a "promote" decision on `main`. It uses the GitHub environment
**`model-registry`**, which requires a reviewer's approval: GitHub notifies the reviewer, and the job
waits (scheduled runs too) until someone approves it on the run page. Only this job sees the registry
token. Its first step refuses to go on unless the environment really has a required-reviewers rule
and the token: GitHub creates a missing environment without any protection, so a promotion could
otherwise start unapproved. It then:

1. **Pins the versions in Git**: `promote.py pin-values` rewrites the `MODEL_URI` line of
   `infra/helm/values/values-quick-scan-service.yaml` and `values-deep-scan-service.yaml` (for example
   `models:/fraudguard-quick-scan/3`). It commits as `github-actions[bot]`
   (`chore(model): promote quick-scan vN, deep-scan vM`), rebasing and retrying if another commit
   landed first.
2. **Moves `@production`** to the same versions and tags them with the promotion time, the workflow
   run and the test metrics (`promote.py apply`).

Git goes first because the cluster follows Git. If step 2 failed, the next run would see the candidate
still differing from production and finish the job; both steps are idempotent.

## 5. Roll out

Argo CD polls Git every 60 s. The new `MODEL_URI` changes the scan services' ConfigMap, and its
checksum rolls the pods. A new pod downloads exactly the pinned version, checks it (metadata, feature
order, quick-scan's self-check against scikit-learn) and only then becomes ready (about 20 s). A
broken model never takes traffic. docker compose keeps following `@production` (development).

## 6. Monitor

| Signal | Where |
|---|---|
| Which version runs | Grafana, *FraudGuard: fraud pipeline* → **Models**: the version panels (`model_version_info`; both versions during a rollout); `/health` of each scan service. |
| Score distribution | Heatmaps of `scan_score`: quick-scan's anomaly score, deep-scan's fraud probability. |
| Flag rate against the model's expectation | Live and 1-hour quick-scan flag rate next to `model_expected_flag_rate`, the loaded version's validation flag rate (5.96% for v2). |
| Drift alert | `QuickScanFlagRateDrift`: the 1-hour flag rate is more than 2× or less than half of the expected rate, for 30 minutes, with at least 0.05 req/s (docs/monitoring.md). |
| Model quality on labelled data | The daily evaluation (section 3), every time a candidate is registered. |

A flag-rate shift has two possible causes. If the traffic changed (a fraud wave, a new kind of
client), the model is doing its job and the alert is the news. If the model or its inputs went wrong,
retrain or roll back.

## 7. Roll back

| How | When |
|---|---|
| `git revert` the `chore(model): promote …` commit | Fastest: Argo CD rolls the previous pinned version back within a minute. Then move `@production` back too, using the next row. |
| Run the workflow with `quick_version`, `deep_version` set to the previous versions and `allow_regression` ticked | The audited path: the previous versions are evaluated against the floors (never skipped) and promoted like any candidate, with approval. |

## 8. Retrain

Retrain when the drift alert points at the model, when new labelled data arrives, or to try a better
configuration: section 1 again. The loop then picks the candidate up within a day.

## One-time setup (repository settings)

*Settings → Environments → New environment* `model-registry`:

| Setting | Value |
|---|---|
| Required reviewers | the people who may approve a model promotion |
| Deployment branches and tags | `main` only |
| Secret `MLFLOW_TRACKING_USERNAME` | the DagsHub user name |
| Secret `MLFLOW_TRACKING_PASSWORD` | a DagsHub access token with write access to the repository |

The tracking URI is public and set in the workflow. No other secret is needed.
