#!/usr/bin/env bash
# FraudGuard on a local kind cluster (docs/kubernetes.md). Called by the Makefile:
#   make k8s-up       create the cluster (if needed), install Traefik, deploy everything
#   make k8s-status   pods, ingress, node memory
#   make k8s-stop     stop the node container (keeps state);  make k8s-start  resume it
#   make k8s-down     delete the cluster and all its data
# Env: KIND_HTTP_PORT (default 8089); K8S_LOCAL_IMAGES=1 deploys locally built images
# (docker compose build) instead of the GHCR tags in infra/helm/values/.
set -euo pipefail
cd "$(dirname "$0")/../.."

CLUSTER=fraudguard
CTX="kind-${CLUSTER}"
NODE="${CLUSTER}-control-plane"
NS=fraudguard
KIND_HTTP_PORT="${KIND_HTTP_PORT:-8089}"
K8S_LOCAL_IMAGES="${K8S_LOCAL_IMAGES:-0}"
TRAEFIK_CHART_VERSION=41.6.1
SERVICES=(auth-service transaction-service alerting-service quick-scan-service deep-scan-service api-gateway frontend)
# Keys copied from .env into the fraudguard-secrets Secret (values are never written to the repo).
SECRET_KEYS=(MONGO_ROOT_USERNAME MONGO_ROOT_PASSWORD MONGO_AUTH_PASSWORD MONGO_TRANSACTIONS_PASSWORD
  MONGO_ALERTS_PASSWORD RABBITMQ_DEFAULT_USER RABBITMQ_DEFAULT_PASS JWT_SECRET INTERNAL_SERVICE_TOKEN
  OTP_SECRET ADMIN_EMAIL ADMIN_PASSWORD MLFLOW_TRACKING_USERNAME MLFLOW_TRACKING_PASSWORD)

# Every call targets this cluster's context explicitly: nothing here can touch another cluster.
k() { kubectl --context "$CTX" "$@"; }
h() { helm --kube-context "$CTX" "$@"; }
log() { printf '\n==> %s\n' "$*"; }
# kind/kubectl on Windows are native binaries: hand them Windows paths.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH (see docs/kubernetes.md)"; exit 1; }
  done
}

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; }

create_cluster() {
  if cluster_exists; then
    log "kind cluster '$CLUSTER' exists"
    return
  fi
  log "Creating kind cluster '$CLUSTER' (ingress on 127.0.0.1:${KIND_HTTP_PORT})"
  local cfg
  cfg="$(mktemp)"
  sed "s/hostPort: 8089/hostPort: ${KIND_HTTP_PORT}/" infra/kind/kind-config.yaml > "$cfg"
  kind create cluster --config "$(native_path "$cfg")" --wait 180s
  rm -f "$cfg"
}

apply_secrets() {
  log "Secret fraudguard-secrets from .env"
  local tmp key
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  # shellcheck disable=SC1091
  (
    set -a
    . ./.env
    set +a
    for key in "${SECRET_KEYS[@]}"; do printf '%s=%s\n' "$key" "${!key-}"; done
  ) > "$tmp"
  # Server-side apply: the values are not copied into a last-applied-configuration annotation.
  k -n "$NS" create secret generic fraudguard-secrets --from-env-file="$(native_path "$tmp")" \
    --dry-run=client -o yaml | k apply --server-side --force-conflicts -f -
  rm -f "$tmp"
}

install_ingress() {
  log "Traefik ingress controller (chart ${TRAEFIK_CHART_VERSION})"
  h upgrade --install traefik traefik/traefik --version "$TRAEFIK_CHART_VERSION" \
    --namespace traefik --create-namespace -f infra/kind/traefik-values.yaml --wait --timeout 5m
}

image_args() { # extra helm args for a service
  local svc="$1"
  if [ "$K8S_LOCAL_IMAGES" = "1" ]; then
    local id
    id="$(docker image inspect -f '{{.Id}}' "fraudguard/${svc}:dev" | cut -c8-19)"
    # A changed image id rolls the pods even though the tag stays "dev".
    printf -- '--set image.repository=fraudguard/%s --set image.tag=dev --set image.pullPolicy=Never --set-string podAnnotations.fraudguard/image-id=%s' "$svc" "$id"
  fi
}

# Third-party images (Traefik, MongoDB, RabbitMQ) are loaded from the host's Docker cache instead of
# being pulled inside the node: much faster (the compose stack already has them) and no Docker Hub
# rate limits. The list comes from the rendered charts, so it cannot drift from the values.
# "mongo:7.0" -> "docker.io/library/mongo:7.0" (how containerd names it on the node).
full_image_name() {
  local img="$1" first="${1%%/*}"
  # No registry host (the first part has no "." or ":" and is not localhost): Docker Hub.
  if [ "$img" = "$first" ] || { ! printf '%s' "$first" | grep -q '[.:]' && [ "$first" != localhost ]; }; then
    img="docker.io/$img"
  fi
  # Docker Hub images without a namespace live under library/.
  case "$img" in
    docker.io/*/*) ;;
    docker.io/*) img="docker.io/library/${img#docker.io/}" ;;
  esac
  printf '%s' "$img"
}

preload_platform_images() {
  log "Loading platform images into kind"
  local images img
  images="$(
    {
      h template traefik traefik/traefik --version "$TRAEFIK_CHART_VERSION" -f infra/kind/traefik-values.yaml
      h template mongodb infra/helm/mongodb -n "$NS"
      h template rabbitmq infra/helm/rabbitmq -n "$NS"
    } | sed -nE 's/^[[:space:]]*image:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' | sort -u
  )"
  local archive
  archive="$(mktemp)"
  for img in $images; do
    if docker exec "$NODE" crictl inspecti "$(full_image_name "$img")" >/dev/null 2>&1; then
      echo "already on the node: $img"
      continue
    fi
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
    # Registry images are multi-platform; with Docker Desktop's containerd store, `kind load
    # docker-image` exports an index whose other platforms are absent and the import fails
    # ("content digest ... not found"). Exporting only the node's platform avoids that.
    docker save --platform linux/amd64 -o "$(native_path "$archive")" "$img"
    kind load image-archive "$(native_path "$archive")" --name "$CLUSTER"
  done
  rm -f "$archive"
}

load_local_images() {
  [ "$K8S_LOCAL_IMAGES" = "1" ] || return 0
  log "Building the images (docker compose) and loading them into kind"
  # Without provenance attestations an unchanged (fully cached) build keeps its image id, so a
  # re-run neither reloads the images into kind nor rolls the pods. (With them, Docker Desktop's
  # containerd store gives every build a new id.) CI-published images keep their attestations.
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build "${SERVICES[@]}"
  local id deployed
  for svc in "${SERVICES[@]}"; do
    # kind's own "already present" check never matches with Docker Desktop's containerd store, so
    # compare with the image id the running Deployment was created from (see image_args).
    id="$(docker image inspect -f '{{.Id}}' "fraudguard/${svc}:dev" | cut -c8-19)"
    deployed="$(k -n "$NS" get "deploy/${svc}" \
      -o jsonpath='{.spec.template.metadata.annotations.fraudguard/image-id}' 2>/dev/null || true)"
    if [ "$id" = "$deployed" ]; then
      echo "unchanged, already loaded: fraudguard/${svc}:dev"
      continue
    fi
    kind load docker-image "fraudguard/${svc}:dev" --name "$CLUSTER"
  done
}

deploy() {
  log "Namespace and data stores"
  k apply -f "$(native_path infra/kind/namespace.yaml)"
  apply_secrets
  # First start initializes the replica set and users: allow for a slow machine.
  h upgrade --install mongodb infra/helm/mongodb -n "$NS" --wait --timeout 10m
  h upgrade --install rabbitmq infra/helm/rabbitmq -n "$NS" --wait --timeout 10m

  log "Services"
  local svc
  for svc in "${SERVICES[@]}"; do
    # shellcheck disable=SC2046
    h upgrade --install "$svc" infra/helm/service -n "$NS" \
      -f "infra/helm/values/values-${svc}.yaml" $(image_args "$svc")
  done
  for svc in "${SERVICES[@]}"; do
    k -n "$NS" rollout status "deploy/${svc}" --timeout=8m
  done
}

up() {
  need docker kind kubectl helm
  [ -f .env ] || { echo "error: no .env (run 'make env')"; exit 1; }
  create_cluster
  helm repo add traefik https://traefik.github.io/charts --force-update >/dev/null
  preload_platform_images
  install_ingress
  load_local_images
  deploy
  log "FraudGuard is up: http://localhost:${KIND_HTTP_PORT}  (API: /api, see docs/kubernetes.md)"
  status
}

status() {
  need kubectl docker
  k -n "$NS" get pods -o wide
  echo
  k -n "$NS" get ingress
  echo
  docker stats --no-stream --format 'kind node {{.Name}}: {{.MemUsage}} memory, {{.CPUPerc}} CPU' "$NODE" 2>/dev/null || true
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  stop) need docker; docker stop "$NODE" ;;
  start) need docker; docker start "$NODE" && echo "started; pods take a minute to become ready (make k8s-status)" ;;
  down) need kind; kind delete cluster --name "$CLUSTER" ;;
  *) echo "usage: $0 up|status|stop|start|down"; exit 2 ;;
esac
