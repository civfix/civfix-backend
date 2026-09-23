# civfix-backend

Hello
Backend monorepo for civfix: a Fastify 5 API, a media worker, and deployment infra. All Phase-1
domains are implemented: auth (Apple/Google/email-OTP), jurisdiction/map, media intake + the sandboxed
media worker, reports, anonymous submit + abuse controls + claim, cleanups, real-time chat over
WebSocket, social (people/follow/profile), and notifications/push. Every external dependency sits
behind one of the 9 `@civfix/shared/interfaces`, selected real-vs-fake in the DI container, so the
whole stack boots offline with no credentials for development and tests.

Deployment is via Docker Compose (per-service multi-stage Dockerfiles) given external Postgres/Redis
in env files. See "Deploy with Docker Compose" below.

Part of a set of independent repos that share one contract:

- `civfix-shared` (the contract: zod schemas, domain types, the 9 vendor-neutral interfaces, fakes,
  design tokens, typed client) - published as `@civfix/shared` to the private registry at
  `repo.civfix.org` and installed here as a normal dependency.
- `civfix-backend` (this repo).
- the web app, the mobile app, and the admin app (separate repos).

## Layout

```
civfix-backend/
  .npmrc                        @civfix:registry=https://repo.civfix.org/ (installs @civfix/shared)
  packages/
    config/                     shared eslint / prettier / tsconfig presets (@civfix/config)
  services/
    api/                        Fastify API (@civfix/api)
    media-worker/               pg-boss media worker (@civfix/media-worker)
  infra/
    compose/                    docker-compose (prod-ish + dev)
    caddy/                      reverse-proxy Caddyfile
    secrets/                    SOPS + age docs and .sops.yaml
    tiles/                      note: map uses OpenStreetMap (CARTO Voyager) raster; no self-hosted tiles
  .github/workflows/ci.yml      lint / typecheck / build / test + integration services
  tsconfig.base.json            strict base TS config
  turbo.json                    turborepo task graph
  pnpm-workspace.yaml
```

## Requirements

- Node >= 22 (see `.nvmrc`)
- pnpm 9.12.0 (this repo is pnpm-only)
- Docker is only needed later for integration tests / running infra; not required to build or test.
  The Docker-gated suites SKIP themselves on a machine with no Docker so `pnpm test` stays green, but
  only there: with `CI` (set by GitHub Actions) or `CIVFIX_REQUIRE_PG=1` in the environment, a failed
  container start FAILS the run instead of silently dropping every integration test from it. Set
  `CIVFIX_ALLOW_PG_SKIP=1` to opt a CI job back into skipping.

## The shared contract (`@civfix/shared` from the private registry)

`@civfix/shared` is consumed as a normal npm dependency from the private Verdaccio registry at
`https://repo.civfix.org`, so the backend always builds against a published, versioned contract.

The repo-root `.npmrc` scopes `@civfix` to the registry
(`@civfix:registry=https://repo.civfix.org/`), and the service `package.json` files depend on a
published version (`^0.1.0` today). The registry allows anonymous read, so no credentials are needed
to install. A fresh clone needs only:

```
git clone <civfix-backend remote>
cd civfix-backend
pnpm install   # fetches @civfix/shared from repo.civfix.org
```

Contract changes are made in `civfix-shared`, published as a new version (push a `vX.Y.Z` tag), and
adopted here by bumping the `@civfix/shared` dependency range and running `pnpm install`.

## Install

```
pnpm install
```

This installs the workspace, including the `shared` package (built via its own tsup on first build).

## Common tasks (run from the repo root; delegated to turbo)

```
pnpm build        # build @civfix/shared, then api + media-worker
pnpm typecheck    # tsc --noEmit across all packages
pnpm lint         # eslint across all packages
pnpm test         # vitest unit tests
pnpm dev          # run services in watch mode (persistent)
pnpm clean        # remove build artifacts
```

## Running the API in dev (offline, no credentials)

Outside production the env loader supplies insecure dev defaults for the signing keys and turns on
every `USE_FAKE_*` seam, so the server boots with no database, Redis, or cloud credentials:

```
pnpm --filter @civfix/api dev
# GET http://localhost:8080/healthz -> { "ok": true, "service": "civfix-api", "version": "0.0.0" }
```

See `services/api/.env.example` for the full, annotated env reference (every var, with [BOOT]/[OPT]
and which `USE_FAKE_*` flag bypasses it). In production every [BOOT] var must be set or the loader
throws an aggregated error listing each missing one.

## Architecture: the seam boundary

All external dependencies (object storage, mail, push, geocoding, chat transport, routing, abuse
checks, background jobs, inbound mail) sit behind the 9 interfaces from `@civfix/shared/interfaces`.
The application code never imports a vendor SDK directly; vendor SDKs are confined to adapter files
under `services/api/src/adapters/`. The DI container (`services/api/src/di.ts`) is the single place
that chooses a REAL adapter or an in-memory FAKE per `USE_FAKE_*` flag.

## Media worker (`services/media-worker`)

The worker consumes the `media.checks` job the API enqueues on finalize and runs the sandboxed,
untrusted-byte pipeline: decode-guard, EXIF/GPS read + strip, ~400px thumbnail, perceptual hash
(dHash), NSFW + near-duplicate seams for images; ffprobe validate + stream-copy metadata-strip remux +
frame-grab thumbnail for video. It also runs two pg-boss crons: `orphan.sweep` (reap never-attached
media, section 11) and `chat.partition.maintenance` (pre-create next month's chat partition,
sections 7/12).

Data layer (single source, no duplication): the worker does NOT re-declare the Drizzle schema, the
postgres-js client, the R2 adapter, or the GlitchTip reporter. It depends on `@civfix/api`
(`workspace:*`) and imports them through SOURCE-pointing package exports added to
`services/api/package.json`:

- `@civfix/api/db` - the schema barrel + `makeDb` + `Db`/`Sql` types.
- `@civfix/api/media-repo` - the Drizzle impl of the richer media-worker persistence seam and
  `ensureNextMonthChatPartition` (so partition bounds/naming have one source shared with the
  migrations).
- `@civfix/api/media-worker-repository`, `@civfix/api/anon-hold-release-repository`,
  `@civfix/api/inbound-retention-repository` - the type-only repository contracts the worker's jobs
  depend on (`MediaWorkerRepository`: find / applyResult / insertAbuseFlag / findOrphans /
  deleteById; `AnonHoldReleaseRepository`; `InboundRetentionRepository`). Their Drizzle impls stay
  on `media-repo`, `anon-hold-repo` and `inbound-retention-repo`.
- `@civfix/api/queue-names` - every pg-boss queue name and the shared queue policy.
- `@civfix/api/time`, `@civfix/api/concurrency`, `@civfix/api/env-parsers`, `@civfix/api/timeout`,
  `@civfix/api/capped-body` - import-free helpers the worker shares with the api (time units,
  `mapWithLimit`, `parseBool`, `settleWithin`, the size-capped stream reader).
- `@civfix/api/adapters/storage`, `@civfix/api/adapters/abuse-checks`, `@civfix/api/errors`,
  `@civfix/api/migrate` - the R2 adapter, the real AbuseChecks adapter, the GlitchTip helper, and the
  migration runner (the last reused only by the Docker-gated worker integration harness).

The worker's `tsup` build inlines `@civfix/api` + `@civfix/shared` source into a self-contained
`dist`, keeping only native/heavy deps external (`sharp`, `ffmpeg-static`, `ffprobe-static`, `execa`,
`exifr`, `pg-boss`, `postgres`, `drizzle-orm`, `@aws-sdk/*`, `@sentry/node`).

Safe failure (Phase-1 done-criterion): `runMediaChecksJob` and the pure `processMedia` core NEVER
throw. Any malformed/oversize/undecodable/unsupported input results in `media_assets.status =
"rejected"` (or `held` for an NSFW policy hold; a near-duplicate is non-blocking, see #43) plus an abuse_flag/log/GlitchTip event,
and the job COMPLETES - a crafted upload can never crash the worker or poison the queue. This is proven
by `services/media-worker/test/unit/media-checks.test.ts` running REAL sharp + REAL ffmpeg/ffprobe
against crafted fixtures.

Sandboxing + limits (`services/media-worker/src/config.ts`, overridable by env): ffprobe/ffmpeg run
via `execa` with an ARGS ARRAY (no shell, no injection), a hard per-tool timeout, `killSignal`
SIGKILL, and a `maxBuffer` output cap; sharp uses `limitInputPixels` + a wrapped wall-clock timeout.
`media.checks` concurrency is capped (default 2; `MEDIA_CHECKS_CONCURRENCY`), per-job budget 60s
(`MEDIA_JOB_TIMEOUT_MS`), download capped at `MAX_VIDEO_BYTES`. The infra compose additionally caps
container CPU.

NSFW seam: `AbuseChecks.nsfwScore` stays behind the seam and defaults to `FakeAbuseChecks` (benign)
under `USE_FAKE_ABUSE_NSFW=1`. The flag-and-hold FLOW is fully implemented and tested against the
fake; wiring a real ONNX/NSFW model is a flag-gated pre-launch follow-up (plan sections 3/20) that
swaps only the adapter behind the seam.

## Adding routes (extension point for later steps)

Register a route plugin in `services/api/src/routes/index.ts` - one line in `registerRoutes`:

```ts
import { registerReportRoutes } from "./reports.routes.js"
// ...inside registerRoutes(app, container):
await registerReportRoutes(app, container)
```

Each plugin has the shape `(app: FastifyInstance, container: Container) => Promise<void>` and reads
its seams from `container` (or `app.container`). Health routes are already registered there.

## Migrations

The canonical, hand-authored DDL lives in `services/api/drizzle/0000..0096.sql` (PostGIS geometry,
GiST indexes, and declarative partitioning that drizzle-kit cannot express). The Drizzle schema under
`services/api/src/db/schema/` mirrors it for type-safe queries. The runner applies every `.sql` file in
lexical order, each in its own transaction, recording applied files in `_civfix_migrations` so re-runs
are a no-op.

```
# Dev (tsx, against a live DATABASE_URL):
pnpm --filter @civfix/api db:migrate

# Production image (no tsx; runs the built runner):
node dist/db/migrate.js        # == pnpm --filter @civfix/api start:migrate
```

The chain starts at `0000_extensions` (PostGIS/citext), `0001_core` (all Phase-1 tables + indexes),
`0002_chat_partitioning` (range-partitioned `chat_messages`), `0003_users_email` (partial-unique citext
email) and currently ends at `0096_cleanup_guests`; a new file takes the next number after the highest
in the directory (`ls services/api/drizzle | tail -1`). The ordering + the canonical file set are
guarded by `test/unit/migrate-files.test.ts` (locally), and the resulting schema shape by
`test/integration/schema.test.ts` (Docker-gated).

### Expand/contract is MANDATORY (blue/green deploys)

The deploy is blue/green: the `migrate` one-shot applies the new DDL, then the NEW api color starts
while the PREVIOUS image is still serving, and the old color keeps serving for the length of its
SIGTERM drain. **The previous release's code therefore runs against the new schema for minutes on
every deploy** (longer if a rollback follows). So:

- **Every migration in a release is ADDITIVE and backward-compatible**: add tables/columns/indexes,
  add nullable or DEFAULTed columns, add constraints only as `NOT VALID` first. The old image must
  keep working untouched against the post-migration schema, including `INSERT`s that never mention
  the new column.
- **Destructive DDL ships ONE RELEASE LATER, never with the code change**: dropping or renaming a
  column/table, `SET NOT NULL` on an existing column, narrowing a type, or removing an enum value
  goes out only after a release whose code no longer reads or writes it is fully deployed. A rename
  is two releases: add the new column + dual-write, then drop the old one.
- A backfill runs in its own migration and must be re-runnable and idempotent; code reading the
  column keeps a fail-closed fallback until the drop-side release (see the `?? new Date(0)` note in
  `src/auth/pg-stores.ts`).

`docs/migrations-expand-contract.md` has the full rule with the failure modes it prevents.

## Deploy (Docker Compose, via the civfix-infra repo)

Deployment is owned by the **civfix-infra** repo (`github.com/civfix/civfix-infra`): the compose files,
the Caddy + Cloudflare Tunnel edge, the local Postgres/Redis services, the SOPS-encrypted secrets, and the
deploy scripts all live there, NOT in this repo. That repo has ONE branch, `main`, serving both
environments: the box picks its environment from a host marker file (`/etc/civfix/env`), which selects
`env/prod.sh` + `secrets/prod/` on the production box (`ssh civfix`) and `env/staging.sh` +
`secrets/staging/` on the staging box (`ssh civfix-dev`). There is no per-environment infra branch.

This repo provides the two service **Dockerfiles** (`services/{api,media-worker}/Dockerfile`) AND the
workflow that builds them. The images are built once per commit by
`.github/workflows/build-images.yml` (natively on arm64, to match the Oracle Ampere boxes) and pushed
to `ghcr.io/civfix/{api,media-worker}` as `sha-<commit>`. The VPS pulls them; it no longer compiles.
The infra compose still carries each image's `build.context`, which is the escape hatch
(`CIVFIX_ALLOW_LOCAL_BUILD=1`) rather than the normal path.

Build contexts are the REPO ROOT (the services are pnpm-workspace packages that need the root
manifests + lockfile + the root `.npmrc`, so the in-image `pnpm install` resolves `@civfix/shared`
from `repo.civfix.org`); each service's `Dockerfile` header documents this.

In normal operation the deploy is CI-driven, and **staging and production are the same artifact**
(issue [civfix/issue-tracker#108](https://github.com/civfix/issue-tracker/issues/108)):

| | trigger | workflow | what runs |
| --- | --- | --- | --- |
| staging | push to `main` | `deploy-staging.yml` | builds + pushes the release images, then deploys them |
| production | a published `v*` release | `deploy.yml` | re-tags **those same digests** and deploys them |

There is no `dev` branch: feature branches PR into `main`, `main` is the staging lane, and cutting a
GitHub release is the production deploy. Both workflows SSH in under a forced command that runs the same
on-box script. The manual equivalent, for infra-only changes and recovery, is a single command on either
box (it pulls civfix-infra + this repo, decrypts secrets, pulls the release images, and brings the stack
up; see civfix-infra/README.md):

```
sudo -u civfix /opt/civfix/infra/ops/deploy.sh
```

DEPLOY SEQUENCE (enforced by `depends_on` in the compose file):

1. The `migrate` one-shot service runs `node dist/db/migrate.js` (it reuses the API image, which carries
   the runner + the `drizzle/*.sql`), applies the whole `0000..0096` chain in lexical order (every
   deploy runs migrations; they are never applied by hand), then exits 0.
2. `api` and `media-worker` start only after `migrate` completes successfully AND `redis` is healthy.

The API exposes `GET /healthz` (liveness, pure, `Cache-Control: no-store`) and `GET /readyz`
(readiness: pings DB + Redis when wired). Both processes install SIGTERM/SIGINT graceful shutdown. The
API drains first (`src/lifecycle.ts`), in three bounded phases:

1. **Drain (`SHUTDOWN_DRAIN_MS`).** `/healthz` answers `503 {"ok":false}` with an
   `x-civfix-draining: 1` response header (a header, so the public body stays a bare `{ok:false}`
   with no deploy state in the JSON clients parse), so Caddy's active health check demotes this
   color while the process keeps serving every request normally. **The paired civfix-infra change
   must set `SHUTDOWN_DRAIN_MS=8000` and Caddy `health_interval 2s` + `health_timeout 1s`
   (demotion inside ~4s); until it lands, the box still runs the older values and the CI
   availability assertion will not hold.** A configured value above the 10s ceiling is clamped and
   logged as a warning, so a stale compose value can never be silently reduced.
2. **Close (bounded by the 15s `requestTimeout`).** Fastify is built with
   `forceCloseConnections: false`; its default (`'idle'`) calls `closeAllConnections()` and DESTROYS
   sockets with a request in flight, which is exactly the dropped request the drain exists to prevent.
   Instead the shutdown closes only IDLE keep-alive sockets, on a 250 ms sweep, while awaiting
   `app.close()`, so parked connections cannot stretch the close and active requests still finish.
   One second before the wait expires anything still open is forced down: WebSocket clients are
   `terminate()`d (a graceful close frame an unresponsive peer never answers would otherwise hold
   `app.close()` for ws's own 30s timeout) and remaining sockets destroyed. The shutdown then moves
   on to teardown regardless, never awaiting a close that cannot settle.
3. **Teardown (15s watchdog).** pg-boss, the chat pub/sub subscriber, Redis and the Postgres pool,
   plus the error-reporting flush, all INSIDE the watchdog so nothing trails the budget, then
   exit. (Open WebSockets are not migrated: they stay on the retiring color and are cut when the
   server closes, then reconnect to the new color.) The worker drains the queue then closes its DB
   pool.

`SHUTDOWN_DRAIN_MS` defaults to **0 (no drain) in every environment, deliberately**: a drain longer
than the container's `stop_grace_period` gets SIGKILLed mid-teardown, which is worse than not draining
at all. The deployed value is set in the civfix-infra compose `api` service `environment:` block, on the
same service that carries `stop_grace_period: 45s`, so the drain and its SIGKILL deadline cannot land in
different deploys; the value this release expects there is **8000**.

The loader AND `makeShutdown` both clamp it to 10s, which makes the whole
shutdown budget explicit and enforced: **drain 10 + close wait 15 + teardown watchdog 15 = 40s, 5s
inside the 45s grace**. `test/unit/shutdown-drain.test.ts` asserts that arithmetic against the named
`COMPOSE_STOP_GRACE_PERIOD_SECONDS = 45` constant, so raising any phase without raising the compose
grace period fails CI. A hard deadline of the same length (drain + close wait + teardown watchdog) is
armed the moment the signal lands, so the process exits inside the grace period even if a phase
somehow outlives its own bound: the guarantee the old single close watchdog provided.

Resource budget (compose `mem_limit`/`cpus`): api 1.5G / 2 cpu, media-worker 2.5G / 1.5 cpu, redis 1G.

### Trusted proxy / client IP (`TRUST_PROXY`)

Every per-IP control (the global rate limiter, the anon per-IP submit cap, the OTP request + verify
caps, and the abuse logs) keys on `request.ip`. Fastify derives `request.ip` from `X-Forwarded-For`,
but ONLY for upstream hops it is told to trust - so it must NOT trust an arbitrary client-supplied
header. `TRUST_PROXY` configures that trust:

- unset (default): the internal loopback + RFC1918 private + IPv6 unique-local ranges. In the deployed
  topology the API only receives connections from Caddy on the internal network, so a forged
  `X-Forwarded-For` from a public client is never honored, while the value Caddy sets for the real
  client IS. Safe in production and convenient in dev (loopback trusted) with no config.
- a bare number (e.g. `TRUST_PROXY=1`): IGNORED - Fastify 5.12.1 removed hop-count trust, so the value
  falls back to the safe default above rather than silently trusting nothing.
- a CIDR/IP comma list (e.g. `TRUST_PROXY=10.0.0.0/8,127.0.0.1`): trust `X-Forwarded-*` only from those
  source addresses.
- `true` / `false`: trust all (UNSAFE; private networks only) / trust none (read the raw socket peer).

This pairs with the Caddyfile in the civfix-infra repo (`edge/caddy/Caddyfile`), which SETS
`X-Forwarded-For` fresh from Cloudflare's `Cf-Connecting-Ip`, so a client cannot pre-seed the header
even for the trusted hop. The two must
ship together: trusting an upstream helps only if Caddy reliably sets the value, and stripping at Caddy
helps only if Fastify is told which sources to trust.

### Building / running a single image by hand

```
# from the repo root (NOT services/api):
docker build -f services/api/Dockerfile -t civfix/api:latest .
docker build -f services/media-worker/Dockerfile -t civfix/media-worker:latest .
```

ffmpeg/sharp in-container: the worker image relies on `ffmpeg-static` + `ffprobe-static` (self-contained
statically-linked linux-x64 binaries downloaded on install - no system ffmpeg needed) and `sharp`'s
prebuilt linux-x64 binaries (glibc, which the Debian bookworm base provides). These are installed INSIDE
the linux image (never copied from the host) so the platform is correct. See the Dockerfile headers.

## Dev flags: USE_FAKE_*

Outside production, the env loader supplies insecure dev defaults for the signing keys and defaults
every `USE_FAKE_*` flag to ON, so the server + worker boot with no database, Redis, or cloud
credentials. In production every flag defaults to OFF and the corresponding [BOOT] credentials are
required (a missing one fails boot with an aggregated error).

| Flag                  | When ON (dev default)             | When OFF (prod default) needs                          |
| --------------------- | --------------------------------- | ------------------------------------------------------ |
| `USE_FAKE_STORAGE`    | in-memory object storage          | `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` |
| `USE_FAKE_MAILER`     | captures emails in memory         | `OCI_EMAIL_SMTP_*`                                      |
| `USE_FAKE_PUSH`       | no-op push sender                 | APNs / FCM / VAPID keys (per platform; optional)       |
| `USE_FAKE_ABUSE_NSFW` | benign NSFW/dedupe scores         | the real abuse adapter (Turnstile secret optional)     |
| `USE_FAKE_CHAT`       | in-process chat fan-out           | `DATABASE_URL` + `REDIS_URL` (Drizzle repo + Redis pub/sub) |
| `USE_FAKE_JOBS`       | in-memory job queue               | `DATABASE_URL` (pg-boss)                               |

### Outbound mail to cities is opt-in

Two flags, both OFF by default in every environment, decide whether civfix ever emails a city without
an operator pressing "Approve & send to jurisdiction" on a report:

| Flag                        | When ON                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `REPORT_AUTOFORWARD_ENABLED` | new reports from report-verified reporters are forwarded at submission, and a citizen `@city` mention in a report discussion forwards the comment |
| `OUTREACH_DIGEST_ENABLED`    | the daily `outreach.digest` cron and the enqueue after saving a jurisdiction's contacts send the per-jurisdiction "reports awaiting your attention" digest |

With both off, the only mail a city receives is the packet an operator sends per report. Enabling either
is a SOPS edit on the box's `api.sops.env` (`OUTREACH_DIGEST_ENABLED` also needs a restart so the cron is
scheduled).

To exercise a real seam locally, run the dev infra from the civfix-infra repo
(`compose/docker-compose.dev.yml` brings up PostGIS + Redis), set `DATABASE_URL` / `REDIS_URL`, and turn
the relevant flag off (e.g. `USE_FAKE_CHAT=0`).

## Reviewer-OTP bypass (App Review)

So App Store / Play reviewers can sign in to a build that is already in review (no new mobile release),
the OTP flow can accept one operator-supplied secret code for the address `reviewer@civfix.org`.

**There is no built-in code.** The code lives only in the deployment's environment, is never committed,
and is per-review and rotated. Three variables gate it, and in production enabling the bypass requires
**all three**: with the switch on and either of the other two missing, the API refuses to boot rather than
silently running a half-configured authentication bypass.

| Variable | Meaning |
| --- | --- |
| `REVIEWER_OTP_BYPASS` | the master switch. Truthy values are `1` / `true` / `yes` / `on` (case-insensitive, trimmed); unset, empty, `false` or anything unrecognised leaves the bypass **off**, which is the default |
| `REVIEWER_OTP_BYPASS_ACK` | **production only:** the explicit second opt-in, same truthy parsing. With `REVIEWER_OTP_BYPASS` on in `NODE_ENV=production` and this not truthy, `loadEnv` throws and **the API refuses to boot** (the error names the variable). Not consulted outside production |
| `REVIEWER_OTP_CODE` | the secret code, **at least 20 characters** (`REVIEWER_OTP_CODE_MIN_LENGTH` in `services/api/src/env.ts`). A non-empty value shorter than that **fails boot in every environment**. Missing entirely: production with the bypass on fails boot; elsewhere the bypass is simply not wired |

Generate one per review, e.g. `openssl rand -base64 24`, set all three variables in the deployment's
sops env, restart, and paste the address + that code into the App Review notes.

**Turning it off again, in this order:** set `REVIEWER_OTP_BYPASS=false` **first**, then remove
`REVIEWER_OTP_CODE`. Removing the code while the switch is still truthy is exactly the production
boot-failure case above.

Behaviour when wired: requesting a code for that address sends **no** email and stores nothing;
verifying with the configured code signs in and, on first use, creates a fully set-up citizen account
(handle `@reviewer`, name "Reviewer Reviewer", `email_verified`, `profile_complete`). The code only
works for this exact address, that address never accepts a mailed code, and a wrong guess spends the
same per-IP verify throttle as any other failed sign-in. `@reviewer` is on the reserved-handle
blocklist so no real user can take it.

## Phase-1 acceptance

`services/api/PHASE1-ACCEPTANCE.md` maps each Phase-1 done-criterion to the endpoint(s)/code that
satisfy it and the test(s) that prove it, and marks which are proven locally vs Docker-gated/CI.

## License

civfix-backend is free software, licensed under the
[GNU Affero General Public License, version 3 only](LICENSE). Every file is
covered by the declaration in [REUSE.toml](REUSE.toml); there are no per-file
license headers. The corresponding source for the API and the media worker is
this repository, <https://github.com/civfix/civfix-backend>; the community web
app and the operator dashboard link to their own repositories at the deployed
commit. Contributions are accepted under
the [Contributor License Agreement](CLA.md); see
[CONTRIBUTING.md](CONTRIBUTING.md). civfix is a project of Reach Out Los Angeles Inc.; the civfix name and
logos are its trademarks and are not covered by the license.
