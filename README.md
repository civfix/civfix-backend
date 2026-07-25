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
  The Docker-gated suites SKIP themselves on a machine with no Docker so `pnpm test` stays green — but
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
- `@civfix/api/media-repo` - the richer media-worker persistence seam (`MediaWorkerRepo`:
  find / applyResult / insertAbuseFlag / findOrphans / deleteById), its Drizzle impl, the
  `MEDIA_CHECKS_JOB` name, and `ensureNextMonthChatPartition` (so partition bounds/naming have one
  source shared with the migrations).
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

The canonical, hand-authored DDL lives in `services/api/drizzle/0000..0005.sql` (PostGIS geometry,
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

Migration files in play: `0000_extensions` (PostGIS/citext), `0001_core` (all Phase-1 tables +
indexes), `0002_chat_partitioning` (range-partitioned `chat_messages`), `0003_users_email`
(partial-unique citext email), `0004_cleanup_address`. The ordering + the canonical file set are
guarded by `test/unit/migrate-files.test.ts` (locally), and the resulting schema shape by
`test/integration/schema.test.ts` (Docker-gated).

## Deploy (Docker Compose, via the civfix-infra repo)

Deployment is owned by the **civfix-infra** repo (`github.com/civfix/civfix-infra`): the compose files,
the Caddy + Cloudflare Tunnel edge, the local Postgres/Redis services, the SOPS-encrypted secrets, and the
deploy scripts all live there — NOT in this repo. This repo provides only the two service **Dockerfiles**
(`services/{api,media-worker}/Dockerfile`); the infra compose sets each image's `build.context` to a
checkout of this repo and builds the images ON the VPS.

Build contexts are the REPO ROOT (the services are pnpm-workspace packages that need the root
manifests + lockfile + the root `.npmrc`, so the in-image `pnpm install` resolves `@civfix/shared`
from `repo.civfix.org`); each service's `Dockerfile` header documents this.

Deploy is a single command on the box (it pulls civfix-infra + this repo, decrypts secrets, builds,
and brings the stack up — see civfix-infra/README.md):

```
sudo -u civfix /opt/civfix/infra/ops/deploy.sh
```

DEPLOY SEQUENCE (enforced by `depends_on` in the compose file):

1. The `migrate` one-shot service runs `node dist/db/migrate.js` (it reuses the API image, which carries
   the runner + the `drizzle/*.sql`), applies `0000..0005`, then exits 0.
2. `api` and `media-worker` start only after `migrate` completes successfully AND `redis` is healthy.

The API exposes `GET /healthz` (liveness, pure) and `GET /readyz` (readiness: pings DB + Redis when
wired). Both processes install SIGTERM/SIGINT graceful shutdown: the API drains in-flight HTTP, closes
all WebSocket connections, then tears down pg-boss, the chat pub/sub subscriber, Redis, and the Postgres
pool; the worker drains the queue then closes its DB pool.

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
- a hop count (e.g. `TRUST_PROXY=1`): trust exactly N hops (use `1` when only Caddy fronts the API).
- a CIDR/IP comma list (e.g. `TRUST_PROXY=10.0.0.0/8,127.0.0.1`): trust `X-Forwarded-*` only from those
  source addresses.
- `true` / `false`: trust all (UNSAFE; private networks only) / trust none (read the raw socket peer).

This pairs with the Caddyfile in the civfix-infra repo (`edge/caddy/Caddyfile`), which SETS
`X-Forwarded-For` fresh from Cloudflare's `Cf-Connecting-Ip`, so a client cannot pre-seed the header
even for the trusted hop. The two must
ship together: trusting a hop count helps only if Caddy reliably sets the value, and stripping at Caddy
helps only if Fastify is told which hops to trust.

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
