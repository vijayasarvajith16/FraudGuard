# 0002: GitOps with Argo CD

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

CI builds and scans an image for each service on every merge. Something has to put those images,
their configuration and, later, the model versions onto the cluster. The cluster runs on the
developer's machine and is deliberately not reachable from the internet, so GitHub cannot push into
it.

## Decision

Argo CD runs inside the cluster and pulls from Git (an app-of-apps with sync waves, automated sync,
prune and self-heal). CI never touches the cluster: after a successful build on `main`, a release job
commits the new immutable `sha-<commit>` image tag into the service's Helm values file. Argo CD sees
the commit and rolls out only that service. The promotion workflow pins model versions the same way
([mlops.md](../mlops.md)).

## Alternatives considered

- **`helm upgrade` / `kubectl apply` from CI (push):** needs cluster credentials in CI and network
  access from GitHub to the cluster, which a local-only cluster does not offer. Manual changes in the
  cluster would also drift silently.
- **Flux:** the same pull model. Argo CD was chosen for its UI, which shows sync state and history
  at a glance.

## Consequences

- Git is the record of what runs: every image tag and model version change is a commit, and a
  rollback is `git revert`.
- Drift is undone: a manual scale was reverted after 69 s and a deleted Deployment recreated after
  73 s ([gitops.md](../gitops.md)).
- Changes arrive by polling, within about a minute. Webhooks would need the cluster to be reachable.
- Secrets are not in Git: `make k8s-up` creates them from `.env`. A shared environment would add
  Sealed Secrets or the External Secrets Operator.
- Autoscaled Deployments leave `replicas` out of Git, so self-heal and the autoscalers do not fight.
