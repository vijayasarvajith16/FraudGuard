# Kubernetes (Helm on kind)

FraudGuard runs on a local single-node [kind](https://kind.sigs.k8s.io/) cluster with the Helm charts
in `infra/helm/`. Daily development stays on docker compose; this is the deployment target that
CI images (GHCR) and GitOps (Phase 12) build on.

```
browser ──► 127.0.0.1:8089 ──► Traefik (Ingress)
                                 ├── /      ──► frontend        (React SPA, nginx)
                                 └── /api   ──► api-gateway     (nginx)
                                                  ├── auth-service
                                                  ├── transaction-service ──► quick-scan-service
                                                  └── alerting-service
            transaction-service ──► RabbitMQ ──► deep-scan-service ──► RabbitMQ ──► alerting-service
            auth / transaction / alerting ──► MongoDB (single-node replica set rs0)
```

## Prerequisites

Docker, `kind`, `kubectl`, `helm` and GNU make (Windows: `winget install Kubernetes.kind
Kubernetes.kubectl Helm.Helm ezwinports.make`), and a `.env` (`make env`).

## Commands

| Command | What it does |
|---|---|
| `make k8s-up` | Creates the kind cluster `fraudguard` (if missing), installs Traefik and **Argo CD**, creates the `fraudguard-secrets` Secret from `.env`, and applies the root Application: Argo CD then deploys the namespace, MongoDB and RabbitMQ, and the seven services from Git, in sync waves (docs/gitops.md). Waits until every application is Synced and Healthy. Re-running it is safe. |
| `make k8s-up K8S_LOCAL_IMAGES=1` | Without Argo CD: builds the images locally (`docker compose build`), loads them into kind and deploys with Helm directly. Use it to test changes CI has not published yet; on a cluster Argo CD already manages, run `make k8s-down` first (self-heal would revert local images). |
| `make k8s-status` | Argo CD applications, pods, ingress and the node's memory use. |
| `make k8s-argocd` | Argo CD UI via port-forward (https://localhost:8443, user `admin`; prints the password). |
| `make k8s-grafana` | Grafana's URL (http://localhost:8089/grafana/, dashboards need no login) and its `admin` password. |
| `make k8s-prometheus` | Prometheus UI via port-forward (http://localhost:9090). |
| `make load-test` | k6 load test inside the cluster (`PROFILE=ramp\|backlog\|smoke`, `LOAD_PODS=8`); needs `make load-rows` once. Results: docs/performance.md. |
| `make k8s-stop` / `make k8s-start` | Stops / resumes the node container. All state is kept; pods are ready again about a minute after a start. |
| `make k8s-down` | Deletes the cluster and all its data (the Secret, the databases). |

The app is then at **http://localhost:8089** (`KIND_HTTP_PORT` changes the port; it is bound to
127.0.0.1 only). Every `kubectl`/`helm` call in `infra/kind/k8s.sh` pins the `kind-fraudguard`
context, so it never touches another cluster in your kubeconfig.

## What gets deployed

| Release | Chart | Notes |
|---|---|---|
| `traefik` (namespace `traefik`) | `traefik/traefik` 41.6.1 | Ingress controller, `hostPort: 80` on the node, mapped to the host by kind. Chosen over ingress-nginx, which the Kubernetes project retired in March 2026. |
| `mongodb` | `infra/helm/mongodb` | StatefulSet, `mongo:7.0`, single-node replica set with keyfile auth; per-service users created on first start. Same scripts as docker compose (`infra/helm/mongodb/files/`). |
| `rabbitmq` | `infra/helm/rabbitmq` | StatefulSet, `rabbitmq:3.13-management-alpine`; the services declare the topology. |
| 7 services | `infra/helm/service` (shared) | One release per service, named after it, configured by `infra/helm/values/values-<service>.yaml`. quick-scan and deep-scan have autoscalers. |
| Monitoring (namespaces `monitoring`, `kube-system`) | Prometheus, Grafana, prometheus-adapter, metrics-server (pinned upstream charts) | Dashboards, alert rules and the metrics APIs the autoscalers read: docs/monitoring.md. |

The shared chart renders a Deployment, a Service (same port as compose, so in-cluster URLs are
unchanged: `http://auth-service:3001`), a ConfigMap for plain settings, Secret references for
credentials, optional mounted config files, and an Ingress where enabled (`/` frontend, `/api`
gateway). Probes follow contract §0.6: liveness `/health/live`, readiness `/health`; the scan
services add a startup probe that allows 3 minutes for the model download. Liveness tolerates 60 s
without an answer: under load a saturated pod answers late, and restarting it only made it crash-loop
(docs/performance.md); readiness takes it out of the Service within 30 s instead. Pods carry
`prometheus.io/*` annotations for scraping; optional `sidecars` (the gateway's nginx exporter) and an
optional HorizontalPodAutoscaler, in which case the Deployment leaves `replicas` to it.

### Image tags

Each values file pins an immutable `sha-<commit>` tag published by CI (docs/ci.md). A new release is
a one-line change to `image.tag`, which Phase 12 automates. A tag that is not yet published (the
gateway change in this phase) can be tested with `K8S_LOCAL_IMAGES=1`.

### Secrets

Nothing secret is committed. `make k8s-up` copies the needed keys from `.env` into the
`fraudguard-secrets` Secret (through a temporary `chmod 600` file, with server-side apply so the
values are not duplicated into an annotation). Charts only reference it (`secretKeyRef`), and
connection strings are composed in the pod (`$(MONGO_AUTH_PASSWORD)` expansion). Changing `.env`
later needs `make k8s-up` plus a `kubectl rollout restart`. As in compose, MongoDB creates the
service users only on its first start.

### Live policy changes

alerting-service's tier policy (`values-alerting-service.yaml` → `configFiles.tierActions.json`) is a
mounted ConfigMap, deliberately left out of the pod checksum: after `helm upgrade` the kubelet
updates the file in place and the service's 10-second poll loads it, with no restart (contract §6.2).

## Security posture

- Every service pod meets the Pod Security **restricted** profile: non-root (numeric UID), read-only
  root filesystem (writable `emptyDir`s only where needed, such as `/tmp` and nginx's `conf.d`), all
  capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp, and no service-account
  token mounted. The namespace enforces **baseline** (the official MongoDB and RabbitMQ images start
  as root, then drop privileges) and warns and audits on **restricted**. During deployment, only
  MongoDB and RabbitMQ produce restricted-level warnings.
- The gateway trusts `X-Forwarded-For` only from the pod network (`NGINX_TRUSTED_PROXIES`), so its
  per-IP rate limits apply to real clients, not to the ingress pod (contract §8).
- Scan services and `/internal` routes stay unreachable from outside: the ingress routes only to the
  frontend and the gateway, and the gateway's deny list still applies.

## Resources

Requests and limits per pod, sized from measured usage under compose and adjusted by the load test
(docs/performance.md):

| Pod | CPU request / limit | Memory request / limit | Replicas | Profile |
|---|---|---|---|---|
| transaction-service | 250m / 1 | 96Mi / 256Mi | 1–4 (CPU) | Every transfer runs here synchronously, ~30 ms of CPU each: a pod may use a full core (one Node.js process). |
| quick-scan-service | 250m / 1 | 256Mi / 320Mi | 1–4 (CPU) | Low latency, small: reserves real CPU because it sits on the transfer's 300 ms hot path; memory stays tight (~180 MiB measured). |
| deep-scan-service | 100m / 1 | 256Mi / 512Mi | 1–3 (queue depth) | Bigger, throughput: an asynchronous queue consumer, so little reserved CPU but more memory headroom for the booster and prefetch. |
| auth, alerting (each) | 50m / 500m | 96Mi / 256Mi | 1 | Node services (~45 MiB measured). |
| api-gateway | 60m / 600m | 48Mi / 96Mi | 1 | nginx plus the nginx-prometheus-exporter sidecar. |
| frontend | 10m / 200m | 16Mi / 32Mi | 1 | Static files. |
| mongodb | 100m / 1 | 256Mi / 768Mi | 1 | WiredTiger cache capped at 0.25 GB; ~330 MiB under load plus a `mongosh` per exec probe. Its one core is the end-to-end bottleneck. |
| rabbitmq | 100m / 1 | 256Mi / 512Mi | 1 | High-watermark derived from the limit. |
| traefik | 50m / 500m | 48Mi / 128Mi | 1 | |
| Monitoring: Prometheus, Grafana (+ sidecar), kube-state-metrics, prometheus-adapter, metrics-server | 210m in total | 784Mi requested / 2 GiB limit | 1 each | docs/monitoring.md. |
| **Total, one replica each** | **1.23 cores** requested | **2.2 GiB** requested / **5.1 GiB** limit | | |

## Memory footprint and how to stop it

Measured on the running cluster (kubelet summary API, working set, after replay traffic):

| Part | Memory |
|---|---|
| Kubernetes itself: API server (462 MiB), etcd, controller manager, scheduler, CoreDNS, kube-proxy, CNI, storage provisioner | 786 MiB |
| FraudGuard services (7 pods; quick-scan 176, deep-scan 124, Node services ~42 each, gateway 12, frontend 8) | 446 MiB |
| MongoDB 163 + RabbitMQ 142 | 305 MiB |
| Traefik | 21 MiB |
| **Whole kind node** (all pods + kubelet, containerd, image cache) | **2.4 GiB** (`docker stats`) |
| With Argo CD (GitOps, Phase 12): application controller 126, repo server 35, server 23, Redis 5 (Dex, notifications and ApplicationSets scaled to 0) | +190 MiB; **node 3.1 GiB** |
| With monitoring (Phase 13): Grafana 322 (with its dashboard sidecar), Prometheus 181, metrics-server 32, kube-state-metrics 27, prometheus-adapter 25 | +590 MiB; **node 4.1 GiB** after the load tests (MongoDB keeps more in memory) |

The application uses about 0.75 GiB, as it does under docker compose; Kubernetes adds roughly
1.6 GiB, Argo CD about 0.2 GiB and monitoring about 0.6 GiB. A load test adds the autoscaled pods
(up to 3 more of each scan service and transaction-service) and the k6 pods. On a 16 GB machine with Docker Desktop's default 8 GB VM, the
cluster and the compose stack fit side by side.

To free the memory: `make k8s-stop` (keeps everything; `make k8s-start` resumes) or `make k8s-down`
(deletes the cluster; `make k8s-up` recreates it in about 6 minutes). The compose stack and the
cluster can run side by side, but there is no need to: stop one with `make down` or `make k8s-stop`.

## Local-cluster notes (Docker Desktop on Windows)

- **cgroup v1:** since Kubernetes 1.35 the kubelet refuses to start on cgroup v1 hosts. Docker Desktop
  on an older WSL2 kernel (5.15) still uses cgroup v1 (`docker info` shows "Cgroup Version"), so
  `infra/kind/kind-config.yaml` sets `failCgroupV1: false`, a no-op on cgroup v2. The lasting fix is
  a cgroup v2 host: `wsl --update`, then `wsl --shutdown` (this restarts Docker and all containers).
- **etcd and fsync:** through Docker Desktop's virtual disk, a single etcd fsync took 4 to 5 s under
  load (healthy is ~10 ms). The API server stalled, its probes restarted it, and every pod
  restarted with it. The kind config runs etcd with `unsafe-no-fsync`: fine for a disposable local
  cluster, never for production.
- **Third-party images** (Traefik, MongoDB, RabbitMQ) are loaded from the host's Docker cache rather
  than pulled inside the node, where a first `mongo:7.0` pull took about 5 minutes and outlasted the
  install timeout (it also avoids Docker Hub's anonymous rate limit). They are exported for
  `linux/amd64` only: with Docker Desktop's containerd image store, `kind load docker-image` on a
  multi-platform image fails with "content digest … not found".
- **Data-store liveness probes are plain TCP checks.** The first version ran `mongosh` and
  `rabbitmq-diagnostics` (a Node.js runtime and an Erlang VM per probe); under host CPU contention
  both timed out and Kubernetes killed healthy data stores. The thorough checks stay as readiness
  probes, where a slow answer only delays traffic instead of restarting the database.
- **Traefik on a single node** holds host port 80, so its rollout stops the old pod before starting
  the new one; the chart's default surge-first rollout left the new pod Pending forever. Traefik also
  publishes `127.0.0.1` into each Ingress's status: without an address, Argo CD keeps an Ingress (and
  so the gateway and frontend Applications) at Progressing.
- **Re-running `make k8s-up` changes nothing** when nothing changed. Local images are built without
  provenance attestations because, with them, every cached build gets a new image id, which made
  each re-run reload all images and roll every pod (9 minutes). Unchanged images are now
  skipped (compared with the image id recorded on each Deployment), so a no-op re-run takes about
  40 seconds and restarts nothing.
