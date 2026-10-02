# 0004: Models output a risk tier; a separate policy decides the action

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

What to do about a risky transfer (log it, notify, ask for a one-time code, freeze the account) is a
business decision that changes more often than the models, and is owned by different people. If the
action were baked into a model or a service's code, changing it would mean retraining or
redeploying.

## Decision

- deep-scan outputs a probability and a **tier** (LOW, MEDIUM, HIGH, CRITICAL) from configurable
  thresholds (contract §6.1).
- alerting-service maps the tier to an **action** using `tierActions.json` (contract §6.2): today
  LOG, NOTIFY, OTP_STEP_UP and BLOCK_AND_FREEZE.
- The file is validated as a whole: each action has exactly one consistent resulting status.
- It is reloaded without restarts: a 30-second poll, or an admin reload endpoint. An invalid file
  is rejected and the last good policy stays active.
- In Kubernetes the policy is a mounted ConfigMap, so a policy change is a Git commit, rolled out
  by Argo CD, with no pod restart.

## Alternatives considered

- **Actions decided by the model service:** couples policy changes to model releases.
- **Hard-coded mapping in alerting-service:** every change is a code change and a redeploy.
- **A rules engine:** far more than four tiers need.

## Consequences

- Policy and models evolve independently: a model promotion ([mlops.md](../mlops.md)) does not touch
  the policy, and a policy change does not touch the models.
- The end-to-end suite reads the active policy from the running system instead of assuming it, so the
  tests keep passing when the policy changes ([testing.md](../testing.md)).
- A bad policy file cannot take effect, and its rejection is visible
  (`tier_actions_config_reloads_total{result="invalid"}`).
