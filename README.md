# civfix-backend

Backend monorepo for civfix: a Fastify 5 API, a media worker, and deployment infra. This is the
STEP 1 scaffold: a rock-solid skeleton, infrastructure config, full env, complete dependency-
injection wiring, and CI. Domain logic (auth, reports, cleanups, chat, etc.) lands in later steps.

Part of four repos that all publish under the SAME GitHub owner:

- `civfix-shared` (the contract: zod schemas, domain types, the 9 vendor-neutral interfaces, fakes,
  design tokens, typed client) - wired here as a git submodule at `shared/`.
- `civfix-backend` (this repo).
- the web app and the mobile app (separate repos).

## Layout

```
civfix-backend/
  shared/                       git submodule -> civfix-shared (DO NOT edit here)
  packages/
    config/                     shared eslint / prettier / tsconfig presets (@civfix/config)
  services/
    api/                        Fastify API (@civfix/api)
    media-worker/               pg-boss media worker (@civfix/media-worker)
  infra/
    compose/                    docker-compose (prod-ish + dev)
    caddy/                      reverse-proxy Caddyfile
    secrets/                    SOPS + age docs and .sops.yaml
    tiles/                      PMTiles dev docs
  .github/workflows/ci.yml      lint / typecheck / build / test + integration services
  tsconfig.base.json            strict base TS config
  turbo.json                    turborepo task graph
  pnpm-workspace.yaml
```

## Requirements

- Node >= 22 (see `.nvmrc`)
- pnpm 9.12.0 (this repo is pnpm-only)
- git (for the submodule)
- Docker is only needed later for integration tests / running infra; not required to build or test.

## The shared submodule (relative-url publish story)

`@civfix/shared` is consumed as a git submodule mounted at `shared/` and linked into the pnpm
workspace, so the backend always builds against the exact committed contract.

`.gitmodules` records the submodule url as the RELATIVE path `../civfix-shared`. That relative url
resolves correctly once all four repos are published under the same GitHub owner (a sibling repo of
this one). Locally, before any remote exists, the working copy was cloned from the absolute path and
then the url was rewritten to the relative form. To initialize the submodule on a fresh clone:

```
git clone <civfix-backend remote>
cd civfix-backend
git submodule update --init --recursive
```

If you cloned before the sibling `civfix-shared` repo existed at the same owner, point the submodule
at a local path temporarily with `git -c submodule.shared.url=<path> submodule update --init`.

Do NOT edit files under `shared/`; it is a separate repo. Contract changes are made in
`civfix-shared` and pulled in by bumping the submodule pointer.

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
"rejected"` (or `held` for an NSFW/near-duplicate policy hold) plus an abuse_flag/log/GlitchTip event,
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

Drizzle schema lives in `services/api/src/db/schema/` (empty barrel for now). Generate and apply:

```
pnpm --filter @civfix/api db:generate   # writes SQL to services/api/drizzle
pnpm --filter @civfix/api db:migrate    # applies against DATABASE_URL (needs a live Postgres)
```
