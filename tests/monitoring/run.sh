#!/usr/bin/env bash
# Monitoring-as-code checks (docs/monitoring.md), with promtool from the Prometheus release the
# cluster runs. Needs only Docker. `make test-monitoring`; CI runs it in .github/workflows/helm.yml.
#   1. The alert rules, extracted exactly as the Prometheus chart renders them, are valid and pass
#      the unit tests in alert-rules.test.yaml.
#   2. Every PromQL query in the Grafana dashboards parses (Grafana's $__rate_interval and $__range
#      are substituted first).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Keep in sync with the Prometheus chart's appVersion (infra/argocd/apps/values.yaml).
PROMETHEUS_IMAGE=quay.io/prometheus/prometheus:v3.15.0@sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e
YQ_IMAGE=mikefarah/yq:4.54.1@sha256:4b3d9475d65571d28cbb19544d3820ec2945e4c8b2f18279394282b8dc3a592e

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Docker Desktop on Windows (Git Bash) needs a Windows path for the bind mount.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
yq() { docker run --rm -i "$YQ_IMAGE" "$@"; }
promtool() {
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(native_path "$work"):/work" -w /work \
    --entrypoint promtool "$PROMETHEUS_IMAGE" "$@"
}

echo "==> Alert rules: syntax and unit tests"
yq '.serverFiles."alerting_rules.yml"' < infra/monitoring/alert-rules.yaml > "$work/alerting_rules.yml"
cp tests/monitoring/alert-rules.test.yaml "$work/"
promtool check rules alerting_rules.yml
promtool test rules alert-rules.test.yaml

echo "==> Dashboard queries parse"
# shellcheck disable=SC2016 # Grafana's variables, not the shell's
grafana_vars='s/\$__rate_interval/1m/g; s/\$__range/1h/g'
{
  printf 'groups:\n  - name: dashboard-queries\n    rules:\n'
  for dashboard in infra/monitoring/manifests/dashboards/*.json; do
    # One JSON string per query: also a valid YAML double-quoted scalar.
    yq -p=json -o=json -I=0 '.. | select(tag == "!!map" and has("expr")) | .expr' < "$dashboard"
  done | sed -e "$grafana_vars" \
    | awk '{ printf "      - record: dashboard_query_%d\n        expr: %s\n", NR, $0 }'
} > "$work/dashboard_queries.yml"
count="$(grep -c 'record:' "$work/dashboard_queries.yml")"
[ "$count" -gt 0 ] || { echo "error: no queries found in the dashboards"; exit 1; }
promtool check rules --lint=none dashboard_queries.yml
echo "${count} dashboard queries parse"
