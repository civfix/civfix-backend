# civfix monitoring stack

A self-contained observability stack overlaid onto the production `compose` project. Brought up by
`ops/start.sh` / `ops/deploy.sh` alongside the app (third `-f docker-compose.monitoring.yml`), so it
survives reboots and isn't reaped by `--remove-orphans`.

```
client ── Cloudflare (Access + proxy) ──► Caddy :443 ──► grafana:3000   (monitor.civfix.org)
                                                            │
                  Prometheus ◄── scrape ── node-exporter, cadvisor, postgres-exporter,
                       │                    redis-exporter, caddy:9974, loki, alloy, grafana
                       └─ datasource ─► Grafana ◄─ datasource ─ Loki ◄── push ── Alloy ◄─ socket-proxy ─ docker.sock(ro)
```

## What it monitors

| Need | Source |
| --- | --- |
| **Resource usage** | node-exporter (host CPU/mem/disk/net/load), cadvisor (per-container) |
| **Errors** | Loki on the pino JSON logs (`res_statusCode >= 500`, `level >= 50`); Caddy edge request rate + latency |
| **Abuse** | postgres-exporter custom queries on `abuse_flags` → `civfix_abuse_flags_{open,recent,total}_count{reason,source}`; Loki views of rate-limit / Turnstile / WS-origin rejections |
| **Alerts** | Prometheus rules (`prometheus/alerts.yml`): target down, core container missing, host mem/disk/CPU, Postgres conns, Redis mem, abuse surge, NSFW spike |

## Retention (tune in place)

- **Metrics** (Prometheus): 30 days OR 15 GB, whichever first (`docker-compose.monitoring.yml` flags).
- **Logs** (Loki): 30 days, compactor-enforced (`loki/loki-config.yaml` → `retention_period: 720h`).
- **Container stdout buffer**: capped by the host Docker `local` driver at 10 MB × 5 per container.

## Security posture

- **No host ports published.** Only Caddy:443 (Cloudflare-IP-locked) is public; it reverse-proxies to
  `grafana:3000`. Everything else is scrape-internal on `compose_default`.
- Grafana sits behind **Cloudflare Access** (Zero-Trust gate) **and** its own strong admin login;
  sign-up + anonymous + org-create disabled, secure cookies, CSP/HSTS on, telemetry off.
- The Docker socket is touched only by a **read-only `socket-proxy`** (POST denied, containers+logs GET
  only); Alloy reaches it over TCP and never sees the raw socket.
- postgres-exporter uses a **least-privilege `monitoring` role** (`pg_monitor` + `SELECT` on `abuse_flags`).
- All images are **version-pinned**; every container is **mem-capped**, runs `no-new-privileges`, and
  drops caps / runs read-only rootfs where the image allows.

## Secrets

SOPS+age encrypted, decrypted transiently by `ops/start.sh` (same pattern as the app):

- `infra/secrets/grafana.env` — `GF_SECURITY_ADMIN_USER`, `GF_SECURITY_ADMIN_PASSWORD`
- `infra/secrets/monitoring.env` — `DATA_SOURCE_NAME` for the `monitoring` Postgres role

Templates: `grafana.env.example`, `monitoring.env.example`.

## Dashboards

Provisioned from `grafana/dashboards/` into the **civfix** folder. Custom: `civfix-overview.json`,
`civfix-logs.json`. Community dashboards (Node Exporter Full, cAdvisor, Postgres, Redis) are fetched
onto the box into the same folder at setup (see `ops/DEPLOY.md`), datasource-pinned to uid `prometheus`.

## Enabling alert delivery later

Delivery is intentionally off (dashboards-only). To page:
1. Add an `alertmanagers:` block to `prometheus/prometheus.yml` and run an Alertmanager service, **or**
2. Recreate the rules as Grafana-managed alerts with an SMTP contact point (OCI Email is already on the
   box) under `grafana/provisioning/alerting/`.
Log-based (5xx-rate, Loki) alerting needs the Loki ruler — a follow-up tied to wiring delivery.
