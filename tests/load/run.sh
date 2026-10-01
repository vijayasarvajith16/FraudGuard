#!/usr/bin/env bash
# Load test against the local kind cluster (docs/performance.md). `make load-test`.
#   PROFILE=ramp     stepped ramp through the gateway; quick-scan's CPU autoscaler reacts
#   PROFILE=backlog  steady load plus a deep-scan outage; the queue-depth autoscaler drains it
#   LOAD_PODS=8      k6 pods (the gateway allows each client IP 20 requests/s)
# k6 runs inside the cluster as an indexed Job and pushes its metrics to Prometheus. A watcher
# records every autoscaler change with a timestamp, and report.py turns both into the results in
# tests/load/results/<run>/ (gitignored). Needs tests/load/data/rows.json (make load-rows).
set -euo pipefail
cd "$(dirname "$0")/../.."

PROFILE="${PROFILE:-ramp}"
PODS="${LOAD_PODS:-8}"
PYTHON="${PYTHON:-python3}"
CTX=kind-fraudguard
NODE=fraudguard-control-plane
NS=fraudguard
LOAD_NS=fraudguard-load
K6_IMAGE=grafana/k6:2.3.0 # version-pinned; loaded into kind from the host's Docker
PROFILE_FILE="tests/load/profiles/${PROFILE}.json"
ROWS=tests/load/data/rows.json

k() { kubectl --context "$CTX" "$@"; }
log() { printf '\n==> %s\n' "$*"; }
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
sleep_until() { while [ "$(date +%s)" -lt "$1" ] && [ ! -f "$OUT/.stop" ]; do sleep 1; done; }

[ -f "$PROFILE_FILE" ] || { echo "error: no profile $PROFILE_FILE"; exit 1; }
[ -f "$ROWS" ] || { echo "error: no $ROWS (run 'make load-rows' first)"; exit 1; }
k get --raw /readyz >/dev/null || { echo "error: the kind cluster is not reachable (make k8s-up)"; exit 1; }

RUN_ID="$(date +%Y%m%d%H%M%S)"
OUT="tests/load/results/${RUN_ID}-${PROFILE}"
EVENTS="$OUT/events.log"
mkdir -p "$OUT"
# Profile: total duration in seconds, and the optional drill ("deployment stopAt resumeAt").
DURATION="$("$PYTHON" -c 'import json,sys; p=json.load(open(sys.argv[1])); print(sum(int(s["duration"].rstrip("s")) for s in p["stages"]))' "$PROFILE_FILE")"
DRILL="$("$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1])).get("drill"); print(d["deployment"], d["stopAt"], d["resumeAt"]) if d else None' "$PROFILE_FILE")"

log "k6 image"
if ! docker exec "$NODE" crictl inspecti "docker.io/${K6_IMAGE}" >/dev/null 2>&1; then
  docker image inspect "$K6_IMAGE" >/dev/null 2>&1 || docker pull -q "$K6_IMAGE"
  archive="$(mktemp)"
  docker save --platform linux/amd64 -o "$(native_path "$archive")" "$K6_IMAGE"
  kind load image-archive "$(native_path "$archive")" --name fraudguard
  rm -f "$archive"
fi

log "Namespace ${LOAD_NS}, script, profile and rows"
k apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${LOAD_NS}
  labels:
    app.kubernetes.io/part-of: fraudguard
    pod-security.kubernetes.io/enforce: restricted
EOF
k -n "$LOAD_NS" delete job -l app.kubernetes.io/name=k6 --ignore-not-found --wait=true
# Server-side apply: the rows exceed the client-side last-applied annotation limit.
k -n "$LOAD_NS" create configmap k6-script --from-file=transfers.js=tests/load/transfers.js \
  --from-file=profile.json="$PROFILE_FILE" --dry-run=client -o yaml | k apply --server-side --force-conflicts -f -
k -n "$LOAD_NS" create configmap k6-rows --from-file=rows.json="$ROWS" \
  --dry-run=client -o yaml | k apply --server-side --force-conflicts -f -

# Every pod registers its users first, then all start the ramp at START_AT.
START_AT=$(($(date +%s) + 75))
log "Run ${RUN_ID}: profile ${PROFILE}, ${PODS} k6 pods, ${DURATION} s from $(date -d "@${START_AT}" +%T 2>/dev/null || echo "+75 s")"
k apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: k6-${RUN_ID}
  namespace: ${LOAD_NS}
  labels:
    app.kubernetes.io/name: k6
    app.kubernetes.io/part-of: fraudguard
spec:
  completionMode: Indexed
  completions: ${PODS}
  parallelism: ${PODS}
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: k6
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 12345
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: k6
          image: ${K6_IMAGE}
          imagePullPolicy: IfNotPresent
          args: [run, --quiet, --out, experimental-prometheus-rw, /scripts/transfers.js]
          env:
            - { name: RUN_ID, value: "${RUN_ID}" }
            - { name: START_AT, value: "${START_AT}000" }
            - { name: PROFILE_FILE, value: /scripts/profile.json }
            - { name: ROWS_FILE, value: /data/rows.json }
            - { name: BASE_URL, value: "http://traefik.traefik.svc.cluster.local" }
            - { name: K6_PROMETHEUS_RW_SERVER_URL, value: "http://prometheus-server.monitoring.svc.cluster.local/api/v1/write" }
            - { name: K6_PROMETHEUS_RW_PUSH_INTERVAL, value: 5s }
            - { name: K6_FEATURES, value: native-histograms }
            - { name: K6_NO_USAGE_REPORT, value: "true" }
          resources:
            requests: { cpu: 100m, memory: 96Mi }
            limits: { cpu: 500m, memory: 256Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - { name: script, mountPath: /scripts, readOnly: true }
            - { name: rows, mountPath: /data, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: script
          configMap: { name: k6-script }
        - name: rows
          configMap: { name: k6-rows }
        - name: tmp
          emptyDir: { sizeLimit: 16Mi }
EOF

# ---- watcher: every autoscaler change, with replicas actually ready --------------------------------
watch_autoscalers() {
  declare -A last=()
  local name current desired ready state
  while [ ! -f "$OUT/.stop" ]; do
    while read -r name current desired; do
      ready="$(k -n "$NS" get deploy "$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
      state="current=${current:-0} desired=${desired:-0} ready=${ready:-0}"
      if [ "${last[$name]:-}" != "$state" ]; then
        echo "$(date +%s) hpa ${name} ${state}" >> "$EVENTS"
        last[$name]="$state"
      fi
    done < <(k -n "$NS" get hpa -o jsonpath='{range .items[*]}{.metadata.name} {.status.currentReplicas} {.status.desiredReplicas}{"\n"}{end}')
    sleep 2
  done
}

# ---- drill (profile "backlog"): a consumer outage -------------------------------------------------
DRILL_DEPLOY=""
if [ "$DRILL" != "None" ]; then
  read -r DRILL_DEPLOY drill_stop drill_resume <<< "$DRILL"
  DRILL_STOP=$((START_AT + drill_stop))
  DRILL_RESUME=$((START_AT + drill_resume))
fi
run_drill() {
  sleep_until "$DRILL_STOP"
  [ ! -f "$OUT/.stop" ] || return 0
  k -n "$NS" scale "deploy/${DRILL_DEPLOY}" --replicas=0 >/dev/null
  echo "$(date +%s) drill ${DRILL_DEPLOY} stopped (consumer outage)" >> "$EVENTS"
  sleep_until "$DRILL_RESUME"
  # Back to one replica: the autoscaler (paused while the target was at 0) takes over again.
  k -n "$NS" scale "deploy/${DRILL_DEPLOY}" --replicas=1 >/dev/null
  echo "$(date +%s) drill ${DRILL_DEPLOY} resumed" >> "$EVENTS"
}

cleanup() {
  touch "$OUT/.stop"
  # shellcheck disable=SC2046
  kill $(jobs -p) 2>/dev/null || true
  # Never leave the consumer scaled to zero, whatever happened.
  if [ -n "$DRILL_DEPLOY" ] && [ "$(k -n "$NS" get "deploy/${DRILL_DEPLOY}" -o jsonpath='{.spec.replicas}')" = "0" ]; then
    k -n "$NS" scale "deploy/${DRILL_DEPLOY}" --replicas=1 >/dev/null
    echo "restored ${DRILL_DEPLOY} to 1 replica"
  fi
}
trap cleanup EXIT

echo "$START_AT start" > "$EVENTS"
watch_autoscalers &
[ -z "$DRILL_DEPLOY" ] || run_drill &

log "Running; Grafana: http://localhost:8089/grafana/d/fraudguard-autoscaling"
deadline=$((START_AT + DURATION + 600))
while :; do
  succeeded="$(k -n "$LOAD_NS" get job "k6-${RUN_ID}" -o jsonpath='{.status.succeeded}')"
  failed="$(k -n "$LOAD_NS" get job "k6-${RUN_ID}" -o jsonpath='{.status.failed}')"
  [ "${succeeded:-0}" -ge "$PODS" ] && break
  if [ "${failed:-0}" -gt 0 ]; then echo "error: ${failed} k6 pod(s) failed (logs in $OUT)"; break; fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "error: the Job did not finish in time"; break; }
  sleep 10
done
END_AT="$(date +%s)"
echo "$END_AT end" >> "$EVENTS"

log "Collecting k6 logs; waiting 45 s for the last metric pushes and the deep-scan backlog"
for pod in $(k -n "$LOAD_NS" get pods -l "job-name=k6-${RUN_ID}" -o name); do
  k -n "$LOAD_NS" logs "$pod" > "$OUT/$(basename "$pod").log" 2>&1 || true
done
sleep 45
touch "$OUT/.stop"
wait_for_watcher=$((SECONDS + 10))
while [ $SECONDS -lt $wait_for_watcher ] && jobs -r | grep -q .; do sleep 1; done

"$PYTHON" tests/load/report.py --run-id "$RUN_ID" --profile "$PROFILE_FILE" --pods "$PODS" \
  --events "$EVENTS" --out "$OUT"
