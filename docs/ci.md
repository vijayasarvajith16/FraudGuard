# Continuous integration

GitHub Actions, in `.github/workflows/`. Every service has a thin workflow that runs only when that
service changes and calls one of two reusable pipelines; repository-wide checks run on every change.

## Workflows

| Workflow | Runs on | What it does |
|---|---|---|
| `auth-service`, `transaction-service`, `alerting-service`, `frontend` | push to `main` and PRs to `main` touching the package (or its pipeline files) | `_node-service.yml`: lint and format check, unit tests with coverage (75% line floor), `npm audit` of production dependencies, then the image pipeline. |
| `quick-scan-service`, `deep-scan-service` | same, for the service | `_python-service.yml`: ruff, pytest with coverage (75% floor), `pip-audit` of runtime requirements, then the image pipeline. |
| `api-gateway` | same, for the gateway | Renders the Nginx templates and runs `nginx -t`, lints the black-box tests, then the image pipeline. |
| `ml` | changes under `ml/` | ruff and the sanity tests on synthetic data with tiny models. **No training in CI** (training runs in Colab). |
| `tools` | changes under `tools/` | ruff and the tool tests (fake gateway and scan servers). |
| `e2e` | every PR to `main` (not docs-only) | Builds the whole compose stack from the PR and runs the end-to-end suite, the gateway black-box tests and the RabbitMQ integration tests (docs/testing.md). Logs are uploaded on failure. |
| `codeql` | push, PR, weekly | CodeQL `security-and-quality` for JavaScript, Python and the workflows themselves. |
| `secrets` | push, PR | gitleaks over the full history with `.gitleaks.toml` (the same rules as the pre-commit hook, which can be skipped locally). |

### The image pipeline (`_container-image.yml`)

1. Build with Buildx, with the layer cache in the GitHub Actions cache (one scope per image).
2. Scan with Trivy; the job **fails on any HIGH or CRITICAL vulnerability that has a fix**. The full
   report is uploaded to *Security → Code scanning* either way.
3. On a push to `main` only: push to GHCR as `ghcr.io/<owner>/fraudguard-<service>` with two tags:
   - `sha-<full commit sha>`: immutable; deployments pin this (Phases 10 and 12).
   - `<semver>` from the service manifest (`package.json`, `pyproject.toml`, or the gateway's
     `VERSION`): points at the latest build of that version. Bump the manifest to cut a new version.

Pull requests never push images. The only credential is the workflow's `GITHUB_TOKEN`
(`packages: write` is granted to the image job only); no repository secrets are needed.

### Hardening

- Every third-party action is pinned to a full commit SHA (the version is in a comment), so a moved
  tag cannot change what runs. Dependabot keeps the pins current.
- Workflows default to `permissions: contents: read`; jobs request only what they need.
- `persist-credentials: false` on checkout; workflow inputs reach shell scripts through `env`, not
  template expansion.
- The workflows are checked with `actionlint` and `zizmor` (no findings above *low*; the remaining
  *low* note suggests a newer `$/` syntax for local reusable workflows, and `./` is kept).

## Dependabot (`.github/dependabot.yml`)

Weekly, grouped minor/patch updates for npm (3 services and the frontend), pip (scan services, `ml/`,
root dev tools), Docker base images (all 7 Dockerfiles) and GitHub Actions, each with a 7-day
cooldown (new releases are proposed only after a week, when compromised versions have usually been
yanked).

**Model libraries are excluded** (`numpy`, `scikit-learn`, `skops`, `xgboost`, `xgboost-cpu`,
`mlflow`, `mlflow-skinny`): a serialized model only reliably loads with the library versions that
trained it, so they are bumped by hand in `ml/` and both scan services together, followed by a
retrain.

## Branch protection (recommended settings for `main`)

*Settings → Rules → Rulesets → New branch ruleset*, target the default branch:

1. **Require a pull request before merging** (1 approval for a team; 0 is fine solo). Enable
   *Dismiss stale approvals* and *Require conversation resolution*.
2. **Require status checks to pass**, with *Require branches to be up to date*. Add these checks:
   - `compose stack` (e2e)
   - `gitleaks` (secrets)
   - `analyze (javascript-typescript)`, `analyze (python)`, `analyze (actions)` (CodeQL)
3. **Block force pushes** and **Restrict deletions**.
4. Optionally **Require signed commits** and **Require linear history**.

**Do not add the per-service checks as required.** They are path-filtered, so a PR that does not
touch a service never reports that service's check, and GitHub would wait for it forever ("Expected:
waiting for status to be reported"). That is safe to leave out: `compose stack` rebuilds and tests
every service image on every PR, and each service's own checks still block its PR through the
review. If per-service enforcement is needed later, the usual pattern is a single always-running
"gate" job that inspects which paths changed and fails if a triggered pipeline failed.

## Container images (GHCR)

After the first push to `main`, the images appear under the repository owner's *Packages*. GitHub
creates them **private**; to let the Kubernetes cluster (Phase 10) or anyone else pull without a
token, open each package → *Package settings* → *Change visibility* → *Public*. The image labels
(`org.opencontainers.image.source`) link each package to this repository.

```bash
docker pull ghcr.io/<owner>/fraudguard-auth-service:sha-<commit>
```
