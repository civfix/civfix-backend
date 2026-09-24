# civfix-backend

Backend monorepo for civfix: a Fastify 5 API, a sandboxed media worker, and the Cloudflare Email
Worker for inbound mail. The API covers auth (Apple/Google/email OTP), jurisdictions and the map, media
intake, reports (including anonymous submit, abuse controls and claim), cleanups and events, real-time
chat and direct messages over WebSocket, posts, social (people/follow/profile), volunteer hours and
service-hours certificates, notifications/push, city mail (outbound packets and inbound replies), and
the operator (admin) plane. External services sit behind the 11 seam interfaces from
`@civfix/shared/interfaces` (plus two API-local adapter interfaces, reverse geocoding and jurisdiction
lookup), selected real-vs-fake in the DI container, so the whole stack boots offline with no
credentials for development and tests.

Deployment is Docker Compose, owned by the civfix-infra repo, running the images this repo's CI builds.
See "Deploy (Docker Compose, via the civfix-infra repo)" below.

Part of a set of independent repos that share one contract:

- `civfix-app` (the consumer-plane monorepo: the web and mobile apps, plus the contract in
  `packages/shared`: zod schemas, domain types, the 11 vendor-neutral seam interfaces, fakes, design
  tokens, typed client). The contract is published as `@civfix/shared` to the private registry at
  `repo.civfix.org` and installed here as a normal dependency.
- `civfix-backend` (this repo).
- `civfix-admin` (the operator dashboard) and `civfix-infra` (VPS infra and deploy).

## Layout

```
civfix-backend/
  .npmrc                        @civfix:registry=https://repo.civfix.org/ (installs @civfix/shared)
  packages/
    config/                     shared eslint + prettier presets (@civfix/config)
  services/
    api/                        Fastify API (@civfix/api)
    media-worker/               pg-boss media worker (@civfix/media-worker)
  infra/
    email-worker/               Cloudflare Email Worker for inbound mail (standalone, own wrangler toolchain)
  scripts/                      the CI no-frontend guard + the dynamic-SQL check (pnpm check:sql, a CI gate)
  docs/                         engineering notes (retention, erasure, migrations, operator runbook, ...)
  .github/workflows/            ci.yml (PR checks: lint, format, typecheck, static checks, build, test), build-images.yml, deploy-staging.yml, deploy.yml
  tsconfig.base.json            strict base TS config
  turbo.json                    turborepo task graph
  pnpm-workspace.yaml
```

## Requirements

- Node >= 22 (see `.nvmrc`)
- pnpm 9.12.0 (this repo is pnpm-only)
- Docker is needed only for the integration suites; it is not required to build or test.
  The Docker-gated suites SKIP themselves on a machine with no Docker so `pnpm test` stays green, but
  only there: with `CI` (set by GitHub Actions) or `CIVFIX_REQUIRE_PG=1` in the environment, a failed
  container start FAILS the run instead of silently dropping every integration test from it. Set
  `CIVFIX_ALLOW_PG_SKIP=1` to opt a CI job back into skipping.

## The shared contract (`@civfix/shared` from the private registry)

`@civfix/shared` is consumed as a normal npm dependency from the private Verdaccio registry at
`https://repo.civfix.org`, so the backend always builds against a published, versioned contract.

The repo-root `.npmrc` scopes `@civfix` to the registry
(`@civfix:registry=https://repo.civfix.org/`), and both service `package.json` files
(`services/api`, `services/media-worker`) depend on a published version by caret range (`^0.55.0`
today). The registry allows anonymous read, so no credentials are needed to install. A fresh clone
needs only:

```
git clone <civfix-backend remote>
cd civfix-backend
pnpm install   # fetches @civfix/shared from repo.civfix.org
```

Contract changes are made in `civfix-app` (`packages/shared`), versioned with changesets and published
by that repo's `publish-shared.yml` workflow on a push to its `main` (a `vX.Y.Z` tag publishes nothing).
They are adopted here by bumping the `@civfix/shared` range in BOTH services and refreshing the
lockfile: `pnpm install` after a range edit, `pnpm --filter <service> update @civfix/shared` for an
in-range patch (plain `pnpm install` leaves the lockfile untouched in that case). On `0.x` the caret
pins the minor, so every minor bump needs a range edit.

## Install

```
pnpm install
```

This installs the workspace (both services and `@civfix/config`) and fetches the prebuilt
`@civfix/shared` from the registry; nothing in this repo builds the contract.

## Common tasks (run from the repo root; delegated to turbo)

```
pnpm build        # tsup build of api + media-worker
pnpm typecheck    # tsc --noEmit in both services
pnpm lint         # eslint in both services
pnpm test         # vitest in both services: unit + the Docker-gated integration suites
pnpm format:check # prettier --check (Markdown is excluded, see .prettierignore)
pnpm check:sql    # dynamic-SQL guard: unsafe/raw allowlist, Drizzle $client, parameter IS NULL tests
pnpm knip         # unused files, exports and dependencies (knip.jsonc)
pnpm dup:check    # copy-paste duplication over the service sources (.jscpd.json threshold)
pnpm dev          # run both services in watch mode (persistent)
pnpm clean        # remove build artifacts
pnpm check:sql    # dynamic-SQL guard (manual; not run by CI)
```

CI runs every command above except `dev` and `clean`. The Cloudflare email worker in
`infra/email-worker` is not a workspace package and keeps its own lockfile, so it installs and tests
in isolation:

```
pnpm --dir infra/email-worker install --frozen-lockfile --ignore-workspace
pnpm --dir infra/email-worker test
```

## Running the API in dev (offline, no credentials)

Outside production the env loader supplies insecure dev defaults for the signing keys and turns on
every `USE_FAKE_*` seam, so the server boots with no database, Redis, or cloud credentials:

```
pnpm --filter @civfix/api dev
# GET http://localhost:8080/healthz -> { "ok": true, "service": "civfix-api" }
```

See `services/api/.env.example` for the full, annotated env reference (every var, with [BOOT]/[OPT]
and which `USE_FAKE_*` flag bypasses it). In production every [BOOT] var must be set or the loader
throws an aggregated error listing each missing one.

## Architecture: the seam boundary

External dependencies (object storage, mail, inbound mail, geocoding, chat transport, the per-user
realtime channel, push, routing, abuse checks, background jobs, SMS) sit behind the 11 interfaces from
`@civfix/shared/interfaces`. The API's application code never imports a vendor SDK directly; vendor
SDKs are confined to adapter files under `services/api/src/adapters/`. The DI container
(`services/api/src/di.ts`) is the single place that chooses a REAL adapter or an in-memory FAKE, per
`USE_FAKE_*` flag (InboundMail and RoutingProvider switch on `NODE_ENV` instead, and
`LOCAL_STORAGE_DIR` selects the development-only local-disk store). The media worker is the
deliberate exception: decoding untrusted bytes with sharp/exifr/ffmpeg and running pg-boss's work side
is its job, and it has its own two-seam picker (`services/media-worker/src/seams.ts`).

## Media worker (`services/media-worker`)

The worker consumes the `media.checks` job the API enqueues on finalize and runs the sandboxed,
untrusted-byte pipeline: decode-guard, EXIF/GPS read + strip, ~400px thumbnail, perceptual hash
(dHash), NSFW + near-duplicate seams for images; ffprobe validate + stream-copy metadata-strip remux +
frame-grab thumbnail for video. It also works the `anon.hold.release` and `media.upload.reap` queues
and runs five pg-boss crons (`services/media-worker/src/worker.ts`): `orphan.sweep` (reap
never-attached media), `chat.partition.maintenance` (keep the chat and DM monthly partitions created
two months ahead), `anon.hold.release.sweep` (backstop for held anonymous reports), `retention.sweep`
(the retention TTLs in `docs/retention-cleanup.md`) and `media.stuck.sweep` (terminalize media stuck in
`validating`).

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
`exifr`, `pg-boss`, `postgres`, `drizzle-orm`, `@sentry/node`, `undici`, `https-proxy-agent`,
`@smithy/node-http-handler`, `@aws-sdk/*`).

Safe failure: `runMediaChecksJob` and the pure `processMedia` core never throw on untrusted input. Any
malformed/oversize/undecodable/unsupported input results in `media_assets.status = "rejected"` (or
`held` for an NSFW policy hold; a near-duplicate is non-blocking) plus an abuse_flag/log/GlitchTip
event, and the job COMPLETES - a crafted upload can never crash the worker or poison the queue. The only
error that leaves the job is `MediaInfraError`, a retryable infrastructure failure (load, download,
timeout, persist, sandbox spawn, among others) raised deliberately so pg-boss retries it;
`processMedia` rethrows `SandboxSpawnError`, which `media-checks.ts` converts into
`MediaInfraError("sandbox-spawn")`. This is
proven by `services/media-worker/test/unit/media-checks.test.ts` running REAL sharp + REAL
ffmpeg/ffprobe against crafted fixtures.

Sandboxing + limits (`services/media-worker/src/config.ts`, overridable by env): ffprobe/ffmpeg run
via `execa` with an ARGS ARRAY (no shell, no injection), a hard per-tool timeout, `killSignal`
SIGKILL, and a `maxBuffer` output cap; sharp uses `limitInputPixels` + a wrapped wall-clock timeout.
`media.checks` concurrency is capped (default 2; `MEDIA_CHECKS_CONCURRENCY`), per-job budget 90s
(`MEDIA_JOB_TIMEOUT_MS`), download capped at `MEDIA_MAX_DOWNLOAD_BYTES` (default: the contract's
`MAX_VIDEO_BYTES`). The infra compose additionally caps container CPU.

NSFW seam: `AbuseChecks.nsfwScore` stays behind the seam and defaults to `FakeAbuseChecks` (benign)
outside production (`USE_FAKE_ABUSE_NSFW` defaults on there). The real adapter has no NSFW model wired:
it returns no verdict, and `MEDIA_UNSCORED_POLICY` decides what unscored media does (`flag`, the
default, publishes it with a note; `hold` holds it for review). A model over threshold
(`MEDIA_NSFW_HOLD_THRESHOLD`, default 0.8) holds the media. The flag-and-hold FLOW is implemented and
tested; wiring a real model is gated by `USE_REAL_NSFW` and swaps only the adapter behind the seam.

## Adding routes

Register a route plugin in `services/api/src/routes/index.ts` - one line in `registerRoutes`:

```ts
import { registerReportRoutes } from "./reports.routes.js"
// ...inside registerRoutes(app, container):
await registerReportRoutes(app, container)
```

Each plugin has the shape `(app: FastifyInstance, container: Container) => Promise<void>` and reads
its seams from `container` (or `app.container`). Health routes are already registered there.
Handlers register through `route(app, "<endpointName>", ...)` (`src/versioning/route.ts`), which takes
the method and versioned path from the shared `endpoints` registry; `test/unit/route-coverage.test.ts`
fails until a new registry entry has test wiring.

## Migrations

The canonical, hand-authored DDL lives in `services/api/drizzle/NNNN_*.sql` (PostGIS geometry,
GiST indexes, and declarative partitioning that drizzle-kit cannot express). The Drizzle schema under
`services/api/src/db/schema/` mirrors it for type-safe queries. The runner applies every `.sql` file in
lexical order under a Postgres advisory lock, each in its own transaction, recording applied files in
`_civfix_migrations` so re-runs are a no-op. There are no down migrations.

```
# Dev (tsx, against a live DATABASE_URL):
pnpm --filter @civfix/api db:migrate

# Production image (no tsx; runs the built runner):
node dist/db/migrate.js        # == pnpm --filter @civfix/api start:migrate
```

The chain starts at `0000_extensions` (PostGIS/pgcrypto/citext), `0001_core` (the original
non-partitioned tables + indexes), `0002_chat_partitioning` (range-partitioned `chat_messages`),
`0003_users_email` (partial-unique citext email). The numbering has gaps, so a new file takes the
highest number in the directory plus one (`ls services/api/drizzle | tail -1`). The lexical ordering
and the fixed head of the chain are guarded by `test/unit/migrate-files.test.ts` (locally), and the
resulting schema shape by `test/integration/schema.test.ts` (Docker-gated).

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
   the runner + the `drizzle/*.sql`) and applies every pending file in lexical order (every deploy runs
   migrations; they are never applied by hand), then runs the idempotent
   `node dist/db/backfill-served-key.js` and exits 0. A `seed` one-shot (jurisdiction seed, same image)
   follows it.
2. The api colors start only after `migrate` and `seed` complete successfully and Postgres + Redis are
   healthy; `media-worker` waits on `migrate` and healthy Postgres + Redis (and its egress proxy).

The API exposes `GET /healthz` (liveness, pure, `Cache-Control: no-store`) and `GET /readyz`
(readiness: pings DB + Redis when wired). Both processes install SIGTERM/SIGINT graceful shutdown. The
API drains first (`src/lifecycle.ts`), in three bounded phases:

1. **Drain (`SHUTDOWN_DRAIN_MS`).** `/healthz` answers `503 {"ok":false}` with an
   `x-civfix-draining: 1` response header (a header, so the public body stays a bare `{ok:false}`
   with no deploy state in the JSON clients parse), so Caddy's active health check demotes this
   color while the process keeps serving every request normally. civfix-infra pairs this with
   `SHUTDOWN_DRAIN_MS=8000` on the api service and Caddy `health_interval 2s` + `health_timeout 1s`
   (demotion inside ~4s); the CI availability assertion depends on both. A configured value above the
   10s ceiling is clamped and logged as a warning, so an oversized compose value is never silently
   reduced.
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
different deploys; the value set there is **8000**.

The loader AND `makeShutdown` both clamp it to 10s, which makes the whole
shutdown budget explicit and enforced: **drain 10 + close wait 15 + teardown watchdog 15 = 40s, 5s
inside the 45s grace**. `test/unit/shutdown-drain.test.ts` asserts that arithmetic against the named
`COMPOSE_STOP_GRACE_PERIOD_SECONDS = 45` constant, so raising any phase without raising the compose
grace period fails CI. A hard deadline of the same length (drain + close wait + teardown watchdog) is
armed the moment the signal lands, so the process exits inside the grace period even if a phase
somehow outlives its own bound: the guarantee the old single close watchdog provided.

Resource budget (prod compose `mem_limit`/`cpus`): api 1.5G / 2 cpu per color, media-worker 2.5G /
1.5 cpu, redis 1G / 1 cpu. The staging overlay trims these.

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
- `true` / `false`: trust all (UNSAFE; private networks only, and the loader refuses it in production)
  / trust none (read the raw socket peer).

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

ffmpeg/sharp in-container: the worker image downloads ONE pinned, SHA-256-verified FFmpeg release per
CPU architecture (selected by BuildKit's `TARGETARCH`; the boxes are arm64) and exports
`FFMPEG_PATH`/`FFPROBE_PATH`, which the worker requires in production. The npm `ffmpeg-static` /
`ffprobe-static` packages are devDependencies used only by local runs and tests, and are pruned out of
the image. `sharp` uses its prebuilt linux binaries for the target architecture (glibc, which the
Debian bookworm base provides). Everything is installed INSIDE the linux image (never copied from the
host) so the platform is correct. See the Dockerfile headers.

## Dev flags: USE_FAKE_*

Outside production, the env loader supplies insecure dev defaults for the signing keys and defaults
every `USE_FAKE_*` flag to ON, so the server + worker boot with no database, Redis, or cloud
credentials. In production every flag defaults to OFF, setting any of them ON fails boot, and the
corresponding [BOOT] credentials are required (a missing one fails boot with an aggregated error). The
full list, each with its written consequence, is `FAKE_SEAM_FLAGS` in `services/api/src/env.ts`.

| Flag                  | When ON (dev default)             | When OFF (prod default) needs                          |
| --------------------- | --------------------------------- | ------------------------------------------------------ |
| `USE_FAKE_STORAGE`    | in-memory object storage          | `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` |
| `USE_FAKE_MAILER`     | captures emails in memory         | `OCI_EMAIL_SMTP_*`                                      |
| `USE_FAKE_PUSH`       | no-op push sender                 | APNs / FCM / VAPID keys (per platform; optional)       |
| `USE_FAKE_ABUSE_NSFW` | benign NSFW/dedupe scores         | the real abuse adapter (Turnstile secret optional)     |
| `USE_FAKE_CHAT`       | in-process chat fan-out           | `DATABASE_URL` + `REDIS_URL` (Drizzle repo + Redis pub/sub) |
| `USE_FAKE_JOBS`       | in-memory job queue               | `DATABASE_URL` (pg-boss)                               |
| `USE_FAKE_USER_CHANNEL` | in-process per-user realtime signals | `REDIS_URL` (Redis pub/sub)                        |
| `USE_FAKE_GEOCODER`   | labels every point "Los Angeles, CA" | `DATABASE_URL` (TIGER lookup over the jurisdictions PostGIS table) |
| `USE_FAKE_SMS`        | swallows guest-RSVP texts         | `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` when `SMS_GUEST_ENABLED` is on |

### Outbound mail to cities is opt-in

Two flags, both OFF by default in every environment, decide whether civfix ever emails a city without
an operator pressing "Send to city" (or "Verify and send to city") on a report in the admin dashboard:

| Flag                        | When ON                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `REPORT_AUTOFORWARD_ENABLED` | new reports from report-verified reporters are forwarded at submission, and a citizen `@city` mention in a report discussion forwards the comment |
| `OUTREACH_DIGEST_ENABLED`    | the daily `outreach.digest` cron and the enqueue after saving a jurisdiction's contacts send the per-jurisdiction "reports awaiting your attention" digest |

With both off, the only mail a city receives is the packet an operator sends per report. Enabling either
is a SOPS edit to that environment's `secrets/<env>/api.sops.env` in civfix-infra followed by a deploy
(both flags are read at boot; `OUTREACH_DIGEST_ENABLED` is also what schedules the cron).

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
