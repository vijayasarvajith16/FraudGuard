# Performance

Load-test results for the local kind cluster (docs/kubernetes.md), measured with k6 (`tests/load/`)
on 2026-10-01. The numbers describe this laptop and these resource limits; they are not a production
capacity claim. How the metrics behind them are collected: docs/monitoring.md.

## Summary

| | Result |
|---|---|
| Transfers end to end (through the ingress and gateway) | **24 transfers/s with 0 errors**, p50 115 ms, p95 450 ms. Up to 20/s, p95 stays at 160–230 ms. |
| Breaking point | **~28 transfers/s**: MongoDB, limited to one core, saturates. At 32/s, p95 is 9 s with 4.7% errors, and at 40/s requests time out. |
| transaction-service autoscaler (CPU) | 1 → 4 pods as the load rose from 4 to 16 transfers/s; each new pod ready 5–6 s after the decision. |
| quick-scan alone (component test) | 160 calls/s at p95 12 ms; its autoscaler went 1 → 4 pods, each new pod ready ~20 s after the decision (model download included). |
| deep-scan autoscaler (queue depth) | After a 90 s consumer outage, it scaled 1 → 3 pods 11 s after deep-scan returned and drained 68 queued messages in 35 s; clients saw no errors. |
| Fraud screening under load | About 4–6% of transfers went to deep-scan in every step (quick-scan's flag rate on normal rows), with quick-scan scoring p95 at 2–5 ms. |

## Environment and method

| | |
|---|---|
| Host | Windows 11 laptop; Docker Desktop VM with 12 CPUs and 8 GB; kind, one node (Kubernetes 1.37); the docker compose stack idle alongside. |
| Limits | transaction-service 250m request / 1 core limit, 1–4 pods; quick-scan 250m / 1 core, 1–4 pods; deep-scan 100m / 1 core, 1–3 pods; auth and alerting 500m; **MongoDB 1 core**, 768 MiB; RabbitMQ 1 core. |
| Load generator | k6 2.3 inside the cluster, as an indexed Job (`tests/load/run.sh`). Requests go through Traefik and the nginx gateway, the same path a browser uses. The gateway limits each client IP to 20 requests/s, so each k6 pod stays at or below 18/s and the total load scales with the number of pods. |
| Traffic | Each k6 pod registers 8 users, funds them, and sends transfers in turn from each user to a random other user, each with a real normal row of the Kaggle dataset (`make load-rows`). k6 uses an open model (constant arrival rate): requests keep arriving while the system slows down, as with real users. |
| Measurement | k6 pushes its metrics to Prometheus as native histograms, so p50/p95/p99 are exact across all k6 pods. Each figure covers the held part of a step. Server-side figures come from Prometheus. A watcher records every autoscaler change every ~3 s, with the value the autoscaler read. |
| Reproduce | `make load-rows` once, then `make load-test PROFILE=ramp\|backlog\|quick-scan\|smoke` (`LOAD_PODS=4` by default). Results go to `tests/load/results/<run>/summary.md` (gitignored). |

## End to end: transfers through the gateway

`PROFILE=ramp`, 4 k6 pods, six steps of 75 s (run 20261001194221):

| Load | Achieved | p50 | p95 | p99 | Errors | transaction-service pods | transaction-service CPU | MongoDB CPU | To deep-scan |
|---|---|---|---|---|---|---|---|---|---|
| 4/s | 4.0/s | 117 ms | 433 ms | 509 ms | 0% | 2 | 0.28 cores | 0.32 cores | 3.8% |
| 8/s | 8.0/s | 75 ms | 198 ms | 321 ms | 0% | 2 | 0.27 | 0.24 | 4.7% |
| 12/s | 12.0/s | 64 ms | 160 ms | 214 ms | 0% | 3 | 0.37 | 0.30 | 6.4% |
| 16/s | 16.0/s | 65 ms | 174 ms | 268 ms | 0% | 4 | 0.62 | 0.38 | 5.4% |
| 20/s | 20.0/s | 74 ms | 226 ms | 324 ms | 0% | 4 | 0.82 | 0.50 | 4.8% |
| 24/s | 24.0/s | 115 ms | 450 ms | 756 ms | 0% | 4 | 1.03 | 0.71 | 6.0% |

The first step includes the cold start (first connections, JIT); p95 settles after it. Whole run:
7,621 transfers, 0 errors, no dropped iterations.

The same profile with 8 k6 pods finds the limit (run 20261001195543):

| Load | Achieved | p50 | p95 | p99 | Errors | MongoDB CPU |
|---|---|---|---|---|---|---|
| 8/s | 8.0/s | 152 ms | 310 ms | 602 ms | 0% | 0.25 cores |
| 16/s | 16.0/s | 126 ms | 331 ms | 589 ms | 0% | 0.49 |
| 24/s | 24.0/s | 159 ms | 1,011 ms | 2,209 ms | 0% | 0.72 |
| 32/s | 27.8/s | 360 ms | 9,109 ms | 10,191 ms | 4.7% | 0.91 |
| 40/s | 42.5/s | 9,622 ms | 10,297 ms | 10,359 ms | 100% | 1.00 |

**What limits it.** Each transfer costs 30–40 ms of transaction-service CPU (validation, two
MongoDB transactions, the quick-scan call, logging) and 10–20 ms of MongoDB CPU, both rising with
load as transactions start to conflict. quick-scan costs about 3 ms per call. transaction-service scales out, but every replica writes to the same MongoDB,
and its single core runs out at about 28 transfers/s. Past that point latency climbs to the gateway's
10 s upstream timeout and errors follow (see "Overload" below).

## Autoscaling

### transaction-service: CPU

During the 4-pod ramp:

| Time | Load | Decision | Ready |
|---|---|---|---|
| 1:02 | 4/s | 1 → 2 pods | 1:08 (6 s) |
| 3:29 | 9/s | 2 → 3 pods | 3:34 (5 s) |
| 5:33 | 16/s | 3 → 4 pods | 5:38 (5 s) |

A Node.js pod starts in seconds, so new capacity arrives almost as soon as it is decided. The target
(60% of a 250m request) scales out early, before the event loop of the existing pods is saturated.

### quick-scan: CPU (component test)

End to end, quick-scan reaches its target only at the breaking point (one scale-out to 2 pods at
~30 transfers/s, while MongoDB was already saturated). To see its autoscaler and per-pod capacity,
`PROFILE=quick-scan` calls its `/score` directly inside the cluster (2 k6 pods, no gateway; run
20261001201138):

| Load | Achieved | p50 | p95 | p99 | Errors | quick-scan pods | CPU, % of request (autoscaler's view) |
|---|---|---|---|---|---|---|---|
| 40/s | 40.0/s | 7.1 ms | 15 ms | 20 ms | 0% | 2 | 60% |
| 80/s | 79.9/s | 6.4 ms | 17 ms | 27 ms | 0% | 4 | 72% |
| 160/s | 159.5/s | 5.7 ms | 12 ms | 97 ms | 0% | 4 | 52% |
| 320/s | 278.6/s | 5.8 ms | 101 ms | 300 ms | 0% | 4 | 124% |

| Time | Load | Decision (CPU the autoscaler read) | Ready |
|---|---|---|---|
| 0:39 | 38/s | 1 → 2 pods (104%) | 1:01 (22 s) |
| 2:43 | 80/s | 2 → 3 pods (74%) | 3:03 (20 s) |
| 2:53 | 80/s | 3 → 4 pods (122%) | 3:13 (20 s) |

A new quick-scan pod needs ~20 s before it is ready: it downloads its model from the registry and
checks itself against scikit-learn (contract §4.1), which is why its autoscaler scales up without a
stabilization window. At 320/s all four pods were busy and k6 itself ran short of virtual users
(990 dropped iterations), so 280 calls/s is the measured ceiling with four pods. The 240/s step is
left out: it coincided with a 90 s stall of the whole node (no scrapes, no k6 pushes, quick-scan
idle), an artefact of the Docker Desktop VM rather than of the service.

### deep-scan: queue depth (consumer outage drill)

`PROFILE=backlog`: steady 12 transfers/s; deep-scan scaled to 0 at +60 s and back to 1 at +150 s
(run 20261001202553).

| Time | Event |
|---|---|
| 1:01 | deep-scan stopped (consumer outage); flagged transfers wait `UNDER_REVIEW` with funds held |
| 2:30 | deep-scan back at 1 replica (the autoscaler is paused while its target is at 0) |
| 2:41 | autoscaler reads 59 waiting messages per pod (target 20): 1 → 3 pods |
| 2:47 / 2:56 | first new pod ready / all three ready |
| 2:50 | backlog peaks at 68 messages |
| 3:05 | backlog drained (35 s after the return); time-to-verdict p95 peaked at 5.7 s |
| 5:56 | back to 1 pod after the 3-minute scale-down window |

Clients saw nothing: 4,288 transfers, p95 163 ms, 0 errors. The outage only delayed the verdict for
the ~6% of transfers that were flagged.

## What the load test found

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | transaction-service was the first bottleneck: ~30 ms of CPU per transfer against a 500m limit, so one pod saturated near 16 transfers/s. | The first ramps failed almost entirely (one: 99.5% of 40,548 requests, mostly gateway 504s), together with findings 2 and 3. | **Fixed:** 250m request, 1-core limit, CPU autoscaler 1–4 pods. |
| 2 | Liveness killed a busy pod: the saturated event loop answered `/health/live` too late, and the restarted pod got the same traffic. | Repeated restarts during a single run (CrashLoopBackOff). | **Fixed:** liveness allows 60 s (timeout 5 s × 4); readiness still removes a slow pod. |
| 3 | Hot accounts turn into a write-conflict storm. With 2 users per k6 pod, each account sent several transfers a second, and 81% of MongoDB transactions aborted (14,464 of 17,827); retries burned the CPU. | MongoDB `serverStatus().transactions`. | **Test fixed** (8 users per pod, random recipients). In the service: follow-up 2. |
| 4 | Overload does not shed load. Requests the gateway gave up on (10 s) keep running; the transfers they leave `PENDING` are recovered to `UNDER_REVIEW` 30 s later and all go to deep-scan. | After one overload: 1,698 transfers recovered in 15 minutes, and minutes of full MongoDB CPU after the load stopped. | Follow-ups 1 and 3. |
| 5 | A saturated MongoDB makes every transaction-service replica unready at once (readiness checks MongoDB), so slow responses become a full outage. | All 4 pods unready during the 40/s step. | Follow-up 4. |
| 6 | alerting-service dead-letters scored events when transaction-service is overloaded, leaving those transfers `UNDER_REVIEW`. | 464 messages in `transactions.scored.dlq`, 388 transfers stuck in review; the `DeadLetterQueueNotEmpty` alert fired. | Follow-up 5. |
| 7 | MongoDB had no memory headroom: ~330 MiB under load, plus a ~100 MiB `mongosh` for every exec probe, against 512 MiB. | A diagnostic `mongosh` got the container killed. | **Fixed:** 768 MiB. |
| 8 | Grafana stalled while rendering the dashboards: the chart sets `GOMEMLIMIT` to 60% of the memory limit (230 MiB), below Grafana 13's live heap. | 500m CPU in garbage collection, failed probes, "no available server". | **Fixed:** 768 MiB limit, `GOMEMLIMIT` at 85%. |
| 9 | Registering test users is slow by design: bcrypt at cost 12 on a 500m auth-service takes ~1 s per hash, and 8 pods registering at once ran into the gateway's 10 s timeout. | k6 setup failures (`409 EMAIL_TAKEN` on retry). | **Test fixed:** staggered setup; a retried registration accepts 409. |

### The alert rules on real incidents

During these runs, the rules in `infra/monitoring/alert-rules.yaml` fired on real events, not only in
their unit tests: `ServiceDown` (transaction-service with every pod unready, and MongoDB during its
restart), `QuickScanCallsFailing` and `ScrapeTargetDown` during the overloads, `DeadLetterQueueNotEmpty`
for finding 6 (still firing until the queue is handled), and `CriticalTierSpike` during the fraud
replay that validated the dashboards.

## Follow-ups (application changes, not in this phase)

1. **Shed load in transaction-service:** cap in-flight requests and answer `503` with `Retry-After`
   beyond it, and stop working on a request whose client has gone. Overload would then cost a few
   fast errors instead of a collapse.
2. **Bound transaction retries:** the MongoDB driver retries a conflicting transaction for up to
   120 s; a budget below the gateway timeout (driver `timeoutMS`, or an explicit retry limit) fails
   fast instead.
3. **One outbox relay at a time:** with 4 replicas, four relays race to recover the same transfers
   (harmless thanks to guarded transitions, but wasted work under load). A lease would elect one.
4. **Readiness that degrades:** report "MongoDB slow" without taking every replica out of the
   Service at once.
5. **alerting-service retries:** treat 5xx and timeouts from transaction-service as transient, with
   longer backoff before dead-lettering, and add a tool to replay `transactions.scored.dlq`.
6. **MongoDB capacity:** two transactions per transfer cost ~20 ms of database CPU; one transaction
   per transfer, or more than one core, would move the breaking point.

## Test data left behind

Every run registers its users as `load-<run>-<pod>-<n>@example.com` with their transfers; they stay
in the database like any other demo data. The failed early runs also left transfers in review and
messages in `transactions.scored.dlq` (finding 6).
