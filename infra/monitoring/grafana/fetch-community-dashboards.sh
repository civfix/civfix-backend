#!/usr/bin/env bash
# Fetch polished community dashboards from grafana.com, repoint their datasource references to this
# stack's fixed UIDs (prometheus / loki), validate the JSON, and drop them into the provisioned
# dashboards dir. Re-runnable (idempotent: overwrites the community-*.json files). Needs curl + jq.
#
# These complement the hand-authored civfix-overview / civfix-logs dashboards with per-subsystem detail.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dashboards"
mkdir -p "$DIR"

# name -> grafana.com dashboard id (latest revision)
declare -A DASH=(
  [node-exporter-full]=1860     # host CPU/mem/disk/net/load
  [cadvisor]=14282              # per-container resource usage
  [postgres]=9628               # postgres_exporter
  [redis]=763                   # redis_exporter
)

for name in "${!DASH[@]}"; do
  id="${DASH[$name]}"
  url="https://grafana.com/api/dashboards/${id}/revisions/latest/download"
  tmp="$(mktemp)"
  if ! curl -fsSL --retry 3 "$url" -o "$tmp"; then
    echo "FETCH-FAIL  $name (gnet $id)"; rm -f "$tmp"; continue
  fi
  # Repoint datasource variables to our provisioned UIDs. Covers the input-name forms (${DS_*}) and the
  # datasource template-variable forms these specific dashboards use; leaves legit Grafana vars
  # ($job, $node, $__rate_interval, ...) untouched.
  sed -i \
    -e 's/\${DS_PROMETHEUS}/prometheus/g' \
    -e 's/\${DS_PROMETHEUS-PROD}/prometheus/g' \
    -e 's/\${DS_PROM}/prometheus/g' \
    -e 's/\${ds_prometheus}/prometheus/g' \
    -e 's/\${DS_LOKI}/loki/g' \
    "$tmp"
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    echo "BAD-JSON    $name (gnet $id)"; rm -f "$tmp"; continue
  fi
  install -m 644 "$tmp" "$DIR/community-${name}.json"
  rm -f "$tmp"
  echo "OK          $name (gnet $id) -> community-${name}.json"
done
