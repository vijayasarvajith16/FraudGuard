# Monitoring and autoscaling

Prometheus and Grafana watch the kind cluster, and three autoscalers size the services on the
transfer path: transaction-service and quick-scan on CPU, deep-scan on RabbitMQ queue depth. Everything is code in `infra/monitoring/` and deployed by
Argo CD like the services (docs/gitops.md). Load-test results: docs/performance.md.

```
every FraudGuard pod ── prometheus.io/* annotations ──┐
RabbitMQ (per-queue depth, :15692) ───────────────────┤
kube-state-metrics (replicas, HPAs) ──────────────────┼──► Prometheus ──► Grafana (dashboards)
kubelet / cAdvisor (pod CPU, memory) ─────────────────┤        │   └──► alert rules (firing in Prometheus and Grafana)
k6 load test (remote write, native histograms) ───────┘        │
                                                               └──► prometheus-adapter ──► external metrics API ──► deep-scan HPA
kubelet ──► metrics-server ──► metrics API ──► quick-scan HPA
```

## What runs

| Component | Chart (pinned) | Namespace | Role | Memory |
|---|---|---|---|---|
| Prometheus 3.15 | `prometheus-community/prometheus` 29.35.0 | monitoring | Scrapes every 15 s; 2-day retention on an `emptyDir` (a restart starts empty). No Alertmanager, node-exporter or Pushgateway. Accepts remote write (the k6 load test). | ~180 MiB |
| kube-state-metrics | (Prometheus subchart) | monitoring | Deployment availability (`ServiceDown`) and autoscaler state for the dashboards. | ~25 MiB |
| Grafana 13.2 | `grafana-community/grafana` 13.2.7 | monitoring | Dashboards and the data source are provisioned from Git; no persistent volume. Plugin preinstall is off (built-in panels only, no downloads at startup). | ~300 MiB, up to ~480 MiB while rendering (limit 768 MiB) |
| prometheus-adapter 0.12 | `prometheus-community/prometheus-adapter` 5.3.0 | monitoring | Serves `rabbitmq_queue_messages_ready` on `external.metrics.k8s.io` for deep-scan's autoscaler. | ~40 MiB |
| metrics-server 0.9 | `kubernetes-sigs/metrics-server` 3.14.0 | kube-system | Pod CPU and memory (`metrics.k8s.io`) for quick-scan's autoscaler and `kubectl top`. | ~25 MiB |

Values files: `infra/monitoring/*-values.yaml`; alert rules: `infra/monitoring/alert-rules.yaml`
(a second values file for the Prometheus chart); dashboards and the namespace:
`infra/monitoring/manifests/` (kustomize). The chart versions are pinned once, in
`infra/argocd/apps/values.yaml`; Argo CD, `infra/kind/k8s.sh` and CI all read them from there.

## Open it

| | |
|---|---|
| Grafana | **http://localhost:8089/grafana/** (through the same Traefik ingress as the app, bound to 127.0.0.1). Dashboards open without a login; `make k8s-grafana` prints the `admin` password (random, generated once per cluster into the `grafana-admin` Secret, never in Git or `.env`). |
| Prometheus | `make k8s-prometheus`: port-forward to http://localhost:9090 (`/alerts`, `/targets`). |
| Autoscalers | `make k8s-status` lists them; `kubectl --context kind-fraudguard -n fraudguard get hpa -w` follows them. |

## Dashboards

**FraudGuard: fraud pipeline** (`fraudguard-overview`)

| Panel | Query (5-minute windows unless noted) |
|---|---|
| Fraud-flag rate | quick-scan verdicts that flag: `scan_requests_total{result="flagged"}` / (`flagged` + `clean`) |
| Deep-scan traffic | transfers sent to review: `transactions_created_total{status="UNDER_REVIEW"}` / all created (includes quick-scan timeouts, which also go to review) |
| Risk-tier distribution | over the dashboard's time range: LOW from quick-scan (approved immediately) plus deep-scan's `risk_tier_total{tier}` |
| Deep-scan verdicts by tier, mitigation actions | `risk_tier_total`, alerting-service `alerts_created_total{action}` |
| quick-scan / deep-scan scoring p50 and p95 | `scan_latency_seconds` per service, with the 20 ms budget as a dashed line |
| Transfer API p50 / p95 | transaction-service `POST /transactions`, plus the quick-scan call as transaction-service sees it |
| RabbitMQ queue lag | `rabbitmq_detailed_queue_messages_ready` per queue |
| Time to verdict | deep-scan and alerting `queue_processing_latency_seconds` (event time to acknowledgement) |
| Errors | 5xx share per service, responses by status, quick-scan call results, consumer outcomes |
| Models | the version each scan service runs (`model_version_info`), quick-scan's flag rate against the model's `model_expected_flag_rate`, and heatmaps of `scan_score` (quick-scan's anomaly score, deep-scan's probability): drift monitoring, docs/mlops.md |
| Firing alerts, models in service | `ALERTS`, `model_version_info` |

**FraudGuard: autoscaling** (`fraudguard-autoscaling`): gateway requests per second (from the nginx
exporter sidecar), transfers and their p95, then per autoscaler: current, desired, available and
maximum replicas; the metric exactly as the autoscaler sees it next to its target (CPU % of request;
waiting messages per pod); CPU, throttling and throughput per pod; MongoDB CPU against its limit (the
end-to-end bottleneck, docs/performance.md); memory and CPU of every pod. Dashboards refresh every
30 s by default.

Every query is checked by `make test-monitoring` (below); a dashboard change merged to `main` is live
in Grafana within about a minute (Argo CD polls Git, Grafana's sidecar reloads the ConfigMap).

## How metrics are collected

- **Services:** the service chart annotates every pod with `prometheus.io/scrape`, `port` and `path`
  (`infra/helm/service`). The chart's built-in `kubernetes-pods` job keeps those pods and copies their
  labels, so every series carries `namespace`, `pod` and `app_kubernetes_io_name`, the label the
  rules and dashboards use to tell services apart (the Python services have no `service` label).
- **Gateway:** nginx only offers `stub_status`; an `nginx-prometheus-exporter` sidecar turns it into
  metrics on port 9113, and the gateway pod's annotation points there.
- **RabbitMQ:** its Prometheus plugin (enabled in the image) serves per-queue depth on
  `/metrics/detailed?family=queue_coarse_metrics`; the pod's `prometheus.io/param_family` annotation
  adds the parameter.
- **Not scraped:** the API server and kubelet jobs (thousands of series nobody here reads), MongoDB
  (no exporter), the frontend (static files). cAdvisor is trimmed to CPU, throttling and memory.

## Alert rules

`infra/monitoring/alert-rules.yaml` holds 11 rules. There is no Alertmanager in this local setup, so
nothing is sent anywhere: firing alerts show in Prometheus (`/alerts`) and on the pipeline dashboard.

| Alert | Fires when | For | Severity |
|---|---|---|---|
| `ServiceDown` | a FraudGuard Deployment or StatefulSet has no available replica (kube-state-metrics, so it also fires when every pod is gone) | 2 min | critical |
| `ScrapeTargetDown` | one pod's `/metrics` cannot be scraped | 5 min | warning |
| `QueueLagHigh` | more than 100 ready messages in `transactions.flagged` or `transactions.scored` (deep-scan already scales at 20 per pod) | 2 min | warning |
| `DeepScanVerdictDelayed` | p95 from a flagged event to its acknowledged score above 10 s | 5 min | warning |
| `DeadLetterQueueNotEmpty` | any `*.dlq` queue holds messages | 1 min | warning |
| `QuickScanLatencySLOBreach` | quick-scan scoring p95 above 20 ms (contract §4) | 5 min | critical |
| `QuickScanFlagRateDrift` | quick-scan's 1-hour flag rate is above 2x or below half of the loaded model's validation flag rate (at least 0.05 req/s; quiet without a baseline) | 30 min | warning |
| `DeepScanLatencySLOBreach` | deep-scan scoring p95 above 20 ms | 5 min | warning |
| `HighErrorRate` | more than 5% 5xx on a service's API (health checks excluded, at least 0.1 req/s) | 5 min | warning |
| `QuickScanCallsFailing` | more than 5% of quick-scan calls time out or fail (those transfers go to review) | 5 min | warning |
| `CriticalTierSpike` | at least 5 CRITICAL verdicts in 10 minutes and more than 3x the rate of the 6 hours before (an empty baseline counts as zero) | - | critical |

### Tests

`make test-monitoring` (CI: the `helm` workflow) runs promtool from the same Prometheus release, in
Docker:

1. The rules are extracted exactly as the chart renders them and unit-tested
   (`tests/monitoring/alert-rules.test.yaml`): every alert fires on synthetic series at the expected
   minute with the expected labels and rendered annotations, and the negative cases stay quiet (other
   namespaces, retry queues, failing health checks, a low-traffic service, a steady CRITICAL rate).
2. Every PromQL query in the dashboards must parse (69 queries).

CI also renders the four upstream charts with these values files and validates the output with
kubeconform.

## Autoscaling

| | transaction-service | quick-scan | deep-scan |
|---|---|---|---|
| Metric | CPU, 60% of the 250m request (metrics-server) | CPU, 60% of the 250m request (metrics-server) | ready messages in `transactions.flagged`, 20 per pod (RabbitMQ → Prometheus → prometheus-adapter) |
| Why this metric | every transfer runs here synchronously (~30 ms of CPU each): the first service to saturate, found by the load test | scoring is CPU-bound and synchronous: CPU tracks load directly, and the transfer waits for it | an asynchronous consumer: falling behind shows as waiting messages long before its CPU looks busy |
| Replicas | 1 to 4 | 1 to 4 | 1 to 3 |
| Scale up | immediately, up to doubling every 15 s | immediately, up to doubling every 15 s | immediately |
| Scale down | after 2 minutes of lower load, one pod per minute | after 2 minutes of lower load, one pod per minute | after 3 minutes |
| New pod ready (measured) | 5–6 s | ~20 s (model download and self-check) | 6–17 s |

- The service chart leaves `replicas` out of a Deployment that has an autoscaler, so neither Helm
  nor Argo CD's self-heal resets the autoscaler's choice.
- A new scan pod downloads its model from the registry before it is ready (contract §4.1); the
  scaling timelines in docs/performance.md show how long that takes.
- More transaction-service pods do not raise the end-to-end ceiling past MongoDB's: every replica
  writes to the same single-core database (docs/performance.md).
- If Prometheus or the adapter is unavailable (for example right after Prometheus restarts with an
  empty volume), deep-scan's autoscaler cannot read its metric and keeps the current replica count
  until the series is back (about one scrape interval). Argo CD briefly shows the application as
  Degraded meanwhile.
- `K8S_LOCAL_IMAGES=1` installs the same charts with Helm directly, so autoscaling works without
  Argo CD too.

## Limitations (deliberate, local demo)

- **No notifications:** no Alertmanager. Wiring one to email or chat is configuration, not code.
- **Short memory:** 2 days on an `emptyDir`; restarting Prometheus starts from empty. Enough for
  demos and load tests on a laptop.
- **metrics-server skips kubelet TLS verification** (`--kubelet-insecure-tls`): kind's kubelets serve
  self-signed certificates. A real cluster uses kubelet certificates signed by the cluster CA.
- **Anonymous Grafana viewers:** fine on a port bound to 127.0.0.1; a shared deployment would use SSO.
- **One Prometheus, one Grafana:** no high availability, as for everything else in the local cluster.
