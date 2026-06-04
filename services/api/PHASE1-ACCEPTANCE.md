# civfix backend - Phase 1 acceptance checklist

Maps each Phase-1 done-criterion to the endpoint(s) / code that satisfy it and the test(s) that prove
it. "Proven" column: LOCAL = runs in the offline unit/route suite (no Docker); DOCKER = Docker-gated
integration test (skipped locally via withPg(), runs in CI); CLIENT/INFRA = a property of the client or
deployment, with the contract support noted.

ASCII only. Paths are relative to the repo root unless noted.

---

## 0. Contract surface is fully wired (boot + route-registration audit)

- All 43 endpoints in the shared registry (`shared/src/client/endpoints.ts`) are REGISTERED and
  reachable against an all-fakes server (no infra). The route plugins are wired in
  `services/api/src/routes/index.ts`.
- The DI container wires all 9 seams (real + fake) and the server boots with NO external services when
  the `USE_FAKE_*` flags default ON (dev/test). Production refuses to boot without the required [BOOT]
  env (single aggregated error).

| Proof | Test | Proven |
| --- | --- | --- |
| Every endpoint registered + offline boot smoke | `test/unit/route-coverage.test.ts` (43 + boot + count + a not-vacuous self-check) | LOCAL |
| All 9 seams selected (fake in dev, real when flag off) + no infra handle created | `test/unit/di.test.ts` | LOCAL |
| `/healthz` liveness with no DB/Redis | `test/unit/health.test.ts` | LOCAL |
| Production aggregated BOOT-env error | `test/unit/env.test.ts` | LOCAL |
| Vendor SDKs confined to adapters/sandbox (no app-code leak) | grep audit (see backend report); enforced by review | LOCAL |

### Full route inventory (method, path, auth, csrf)

```
GET    /healthz                     public    csrf=false   (liveness)
POST   /auth/apple                  public    csrf=false
POST   /auth/google                 public    csrf=false
GET    /auth/google/start           public    csrf=false
GET    /auth/google/callback        public    csrf=false
POST   /auth/otp/request            public    csrf=false
POST   /auth/otp/verify             public    csrf=false
GET    /auth/session                optional  csrf=false
POST   /auth/logout                 required  csrf=true
POST   /reports                     required  csrf=true
GET    /reports/:id                 optional  csrf=false
GET    /reports                     required  csrf=false   (my reports)
GET    /map/reports                 optional  csrf=false   (clustered/pinned)
POST   /reports/:id/follow          required  csrf=true
DELETE /reports/:id/follow          required  csrf=true
GET    /map/tileinfo                optional  csrf=false
POST   /map/resolve-jurisdiction    optional  csrf=false
POST   /map/reverse-label           optional  csrf=false
GET    /map/cleanups                optional  csrf=false
POST   /cleanups                    required  csrf=true
GET    /cleanups                    optional  csrf=false
GET    /cleanups/:id                optional  csrf=false
POST   /cleanups/:id/join           required  csrf=true
POST   /cleanups/:id/leave          required  csrf=true
GET    /cleanups/:id/messages       required  csrf=false   (chat history)
GET    /threads                     required  csrf=false
GET    /people                      optional  csrf=false
POST   /people/:id/follow           required  csrf=true
DELETE /people/:id/follow           required  csrf=true
GET    /people/:id                  optional  csrf=false   (public profile)
GET    /me/profile                  required  csrf=false
GET    /notifications               required  csrf=false
POST   /notifications/read          required  csrf=true
GET    /notifications/prefs         required  csrf=false
PUT    /notifications/prefs         required  csrf=true
POST   /push/register               required  csrf=true
POST   /media/upload                optional  csrf=false
POST   /media/:uploadId/finalize    optional  csrf=false
GET    /media/:id                   optional  csrf=false
POST   /anon/reports                public    csrf=false
GET    /anon/reports/:id/status     public    csrf=false
POST   /claim/report                required  csrf=true
GET    /claim/nudge                 optional  csrf=false
```

Plus `GET /ws` (WebSocket upgrade; not in the HTTP registry) and `GET /readyz` (readiness). The WS
upgrade is dual-auth (session cookie OR `?token=`) and now enforces an Origin allowlist (anti-CSWSH).

---

## 1. Every user-design screen is backed by a validated endpoint

Each request/response is validated against the shared Zod schemas (`shared/src/schemas/*`); the route
plugins `parse(...)` the body/query and throw `AppError.validation` (422) on a mismatch. Screen ->
endpoint map (Phase-1 screens):

| Screen | Endpoint(s) |
| --- | --- |
| Sign in (Apple / Google / email) | `POST /auth/apple`, `POST /auth/google`, `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/otp/request`, `POST /auth/otp/verify` |
| Session bootstrap / sign out | `GET /auth/session`, `POST /auth/logout` |
| Map / explore (basemap + pins) | `GET /map/tileinfo` (advertises the OpenStreetMap/CARTO Voyager raster), `GET /map/reports`, `GET /map/cleanups` |
| Drop a pin -> new report | `POST /map/resolve-jurisdiction`, `POST /map/reverse-label`, `POST /media/upload`, `POST /media/:uploadId/finalize`, `POST /reports` |
| Report detail | `GET /reports/:id`, `GET /media/:id`, `POST` + `DELETE /reports/:id/follow` |
| My reports | `GET /reports` |
| Anonymous submit (logged out) | `POST /anon/reports`, `GET /anon/reports/:id/status`, `GET /claim/nudge`, `POST /claim/report` |
| Cleanups list / map / detail | `GET /cleanups`, `GET /map/cleanups`, `GET /cleanups/:id` |
| Create / join / leave a cleanup | `POST /cleanups`, `POST /cleanups/:id/join`, `POST /cleanups/:id/leave` |
| Cleanup chat | `GET /ws`, `GET /cleanups/:id/messages` |
| Messages / threads list | `GET /threads` |
| People directory / search | `GET /people` |
| Profile (public / own) + follow | `GET /people/:id`, `GET /me/profile`, `POST` + `DELETE /people/:id/follow` |
| Notifications feed + read | `GET /notifications`, `POST /notifications/read` |
| Notification settings | `GET /notifications/prefs`, `PUT /notifications/prefs` |
| Push registration (device) | `POST /push/register` |

| Proof | Test | Proven |
| --- | --- | --- |
| Every endpoint registered (the contract surface above) | `test/unit/route-coverage.test.ts` | LOCAL |
| Per-domain request/response validation (422 on bad input) | each `test/unit/*-routes.test.ts` (auth, report, map, cleanups, anon, social, notification, media, chat) | LOCAL |

---

## 2. Sign-in works all three ways, and the 2nd request is served from Redis (no Postgres read)

- Three sign-in paths: Apple (`POST /auth/apple`), Google (`POST /auth/google` + the web
  start/callback), and email OTP (`POST /auth/otp/request` -> `POST /auth/otp/verify`). Code:
  `services/api/src/auth/*` (oauth.ts, otp.ts, session-service.ts), routes `routes/auth.routes.ts`.
- Section-17 property: a warm session resolve reads ONLY the Redis-backed cache; the Postgres session
  store is NOT queried. Code: `auth/session-service.ts` (resolveSession cache-first), `auth/cache.ts`.

| Proof | Test | Proven |
| --- | --- | --- |
| Apple sign-in mints a session | `test/unit/auth-routes.test.ts` ("POST /auth/apple verifies the identity token and mints a session") | LOCAL |
| Google sign-in (token + web start) mints a session | `test/unit/auth-routes.test.ts` ("POST /auth/google ...", "GET /auth/google/start ...") | LOCAL |
| Email OTP issue + verify mints a session | `test/unit/auth-routes.test.ts` + `test/unit/auth-otp.test.ts` | LOCAL |
| Warm resolve hits cache ONLY, never the store | `test/unit/auth-session.test.ts` ("resolveSession HIT path reads ONLY the cache (never the store)") | LOCAL |
| Same property against REAL Postgres + Redis (2nd resolve does not touch PG) | `test/integration/auth-pg.test.ts` | DOCKER |

---

## 3. A dropped pin has correct geom / geom_source=device / jurisdiction / thumbnail (EXIF stripped); a duplicate idempotency key returns the original (no duplicate, no orphan)

- Create: `POST /reports` (auth + CSRF) resolves jurisdiction, computes h3_cell, persists geom from the
  device lat/lng with `geom_source = device`, writes the timeline, and is idempotent on
  `idempotency_key`. Code: `services/api/src/services/report-service.ts`,
  `services/api/src/services/report-repository.drizzle.ts` (PostGIS geom via the raw sql tag).
- Thumbnail + EXIF strip: the media worker's `processImage` reads EXIF GPS only to STRIP it, re-encodes
  metadata-free, and produces a bounded thumbnail. Code: `services/media-worker/src/sandbox/image.ts`,
  `services/media-worker/src/jobs/media-checks.ts`. The original GPS fix is NOT persisted (privacy; see
  section 8 EXIF deferral).
- Idempotency: a duplicate key returns the ORIGINAL report snapshot, inserts no second row, and leaves
  no orphan media. Code: `report-service.ts` (idempotency_keys scope), `media-intake-service.ts`.

| Proof | Test | Proven |
| --- | --- | --- |
| Create returns geom_source/jurisdiction/h3/timeline, mine=true | `test/unit/report-service.test.ts` ("creates a published+public report with geom_source, jurisdiction, h3, timeline, mine=true") | LOCAL |
| Duplicate idempotency key returns SAME id, no second row (route) | `test/unit/report-routes.test.ts` ("a duplicate idempotency key returns the SAME report id (no second row)") | LOCAL |
| Duplicate key returns original snapshot, no second insert (service) | `test/unit/report-service.test.ts` ("returns the ORIGINAL stored snapshot for a duplicate key ...") | LOCAL |
| Valid JPEG -> ready, EXIF/GPS stripped, thumbnail written, dims/phash set | `test/unit/media-checks.test.ts` ("valid JPEG -> ready, EXIF/GPS stripped, thumbnail written, width/height/phash set") | LOCAL |
| Image wrapper reads EXIF GPS then strips it (output + thumb carry none) | `test/unit/sandbox.test.ts` ("reads EXIF GPS from the crafted input, then strips it on output") | LOCAL |
| Real PostGIS geom round-trip (ST_X/ST_Y), geom_source=device, jurisdiction, idempotency, no orphan | `test/integration/reports-pg.test.ts`, `test/integration/media-pg.test.ts` | DOCKER |
| Schema: UNIQUE(idempotency_key) actually rejects duplicates | `test/integration/schema.test.ts` | DOCKER |

---

## 4. tiles p95 and 60fps

This is a CLIENT/INFRA probe (render performance + tile-server latency), not a backend unit assertion.
The backend supports it via:
- `GET /map/tileinfo` advertises the OpenStreetMap (CARTO Voyager) raster basemap URL + zoom range +
  bounds. The clients render that raster basemap directly from the public CARTO CDN (plan override; the
  platform does NOT host its own pmtiles, and this is not on the API hot path). Code:
  `routes/map.routes.ts`, `env.ts` (optional TILES_RASTER_URL override + safe defaults).
- `GET /map/reports` does SERVER-SIDE clustering below a zoom threshold so the pin count (and render
  cost) stays bounded at wide zooms, keeping the client at 60fps; at/above the threshold it returns
  individual pins. Candidate points are capped (MAP_REPORTS_CANDIDATE_CAP = 2000). Code:
  `services/api/src/services/report-service.ts` (clusterPoints / clusterCellSizeDeg / CLUSTER_ZOOM_THRESHOLD).

| Proof | Test | Proven |
| --- | --- | --- |
| Clustering at low zoom, pins at high zoom; category filter; candidate cap | `test/unit/report-service.test.ts` + `test/unit/report-routes.test.ts` ("returns clusters at low zoom and pins at high zoom ...") | LOCAL |
| tileinfo degrades to documented defaults when TILES_* unset | `test/unit/map-routes.test.ts` | LOCAL |
| Actual p95 latency + 60fps | client/infra performance probe (out of backend test scope) | CLIENT/INFRA |

---

## 5. Anonymous submit is abuse-controlled and held items stay hidden

- `POST /anon/reports` runs the full abuse stack: honeypot, per-IP hourly cap (IPv6 reduced to /64),
  per-H3-cell hourly cap (anon-only; H3 res 10 ~130 m across), Turnstile seam, and a submit-time IP-geo
  GPS sanity. The report is created status `held` and stays HIDDEN (absent from `GET /map/reports`, 404
  on `GET /reports/:id`) until the worker's hold-release gate publishes it. Status is visible only via
  `GET /anon/reports/:id/status` with the claim code (no enumeration). Code:
  `services/api/src/services/anon-service.ts`, `src/abuse/*` (honeypot, ip-rate-limit, h3-cap,
  gps-sanity), `src/services/anon-hold-release.ts`.

| Proof | Test | Proven |
| --- | --- | --- |
| Honeypot trips on real content only | `test/unit/abuse.test.ts` ("trips on real content, not on empty/whitespace/absent") | LOCAL |
| Per-IP cap: allow up to cap, reject (cap+1); IPv6 /64 not evadable; window TTL | `test/unit/abuse.test.ts` (IP rate-limit cases) | LOCAL |
| Per-H3-cell cap: stable cell, anon-only exemption, cap + reject | `test/unit/abuse.test.ts` (H3 cell cap cases) | LOCAL |
| Held report is absent from map + 404s by id, status visible only with the code | `test/unit/anon-routes.test.ts` ("is absent from GET /map/reports, 404s on GET /reports/:id, but its status is visible with the code") | LOCAL |
| Wrong claim code 404s (no enumeration) | `test/unit/anon-routes.test.ts` ("GET /anon/reports/:id/status 404s a wrong claim code (no enumeration)") | LOCAL |
| Hold-release gate publishes only when media ready + no open flags + GPS plausible | `test/unit/anon-hold-release.test.ts` (api) + `services/media-worker/test/unit/anon-hold-release.test.ts` | LOCAL |
| Held visibility + release against real Postgres | `test/integration/anon-pg.test.ts` | DOCKER |

---

## 6. A crafted upload fails safely in the worker

- The media.checks pipeline NEVER throws: any malformed/oversize/undecodable/unsupported input yields
  `media_assets.status = rejected` (or `held` for an NSFW/near-duplicate policy hold) plus an
  abuse_flag/log/GlitchTip event, and the job COMPLETES - a crafted upload cannot crash the worker or
  poison the queue. Code: `services/media-worker/src/jobs/media-checks.ts` (processMedia + the
  orchestrator), `src/sandbox/*` (execa args-array, hard timeouts, SIGKILL, maxBuffer; sharp
  limitInputPixels + wrapped wall clock).

| Proof | Test | Proven |
| --- | --- | --- |
| Every crafted bad input -> rejected, never throws | `test/unit/media-checks.test.ts` ("never throws and returns rejected for every crafted bad input"; "each crafted bad image -> rejected row, no throw, GlitchTip notified") | LOCAL |
| Oversize object rejected at download (size cap, no decode) | `test/unit/media-checks.test.ts` ("oversize object is rejected at download (size cap) without decoding") | LOCAL |
| Non-video labeled video / audio-only -> rejected (real ffprobe) | `test/unit/media-checks.test.ts` ("non-video bytes labeled video -> ffprobe fails -> rejected"; "audio-only MP4 ... rejected") | LOCAL |
| Persist failure on a good image falls back to rejected + reports | `test/unit/media-checks.test.ts` ("persist failure on a good image falls back to rejected (and reports)") | LOCAL |
| Sandbox hardening (decode-bomb guard, remux strip, timeouts) | `test/unit/sandbox.test.ts` | LOCAL |
| Full pipeline against a real DB (rows + flags persisted) | `services/media-worker/test/integration/media-checks-pg.test.ts` | DOCKER |

---

## 7. Two devices chat in real time

- The WS gateway drives `handleClientFrame` over the REAL `WsChatService` + pub/sub fan-out: A and B
  (members) join a room, A sends, B receives the broadcast `{type:"message"}`, A gets an `{type:"ack"}`
  with its clientId + the persisted message, and the message is persisted (history returns it). A
  non-member is rejected on join and send (membership gate == cleanup membership). Code:
  `services/api/src/ws/gateway.ts`, `src/adapters/chat-service.ws.ts`, `src/adapters/chat-pubsub.ts`,
  `routes/chat.routes.ts`; history at `GET /cleanups/:id/messages`, thread list at `GET /threads`.
- The handshake is dual-auth (cookie OR `?token=`) and now Origin-allowlisted (anti-CSWSH): a cross-site
  upgrade Origin is rejected with a policy-violation close BEFORE the cookie is consulted.

| Proof | Test | Proven |
| --- | --- | --- |
| A -> B delivery + ack + persistence (real service over in-proc pub/sub) | `test/unit/chat-realtime.test.ts` ("delivers A's message to B, acks A, and persists it") | LOCAL |
| Non-member rejected on join and send (membership gate) | `test/unit/chat-realtime.test.ts` ("rejects a NON-member on join and on send") | LOCAL |
| Redis pub/sub fan-out + unsubscribe semantics | `test/unit/chat-pubsub-redis.test.ts` (ioredis-mock) | LOCAL |
| Dual-auth handshake (cookie / ?token / reject) | `test/unit/chat-routes.test.ts` (resolveWsUser cases) | LOCAL |
| Origin allowlist (anti-CSWSH): cross-site rejected before cookie, allowed origin proceeds | `test/unit/chat-routes.test.ts` (isAllowedWsOrigin + checkWsHandshake cases) | LOCAL |
| Real partitioned chat_messages persistence + history | `test/integration/cleanups-chat-pg.test.ts` | DOCKER |

---

## Deployment readiness (Docker)

| Item | Where | Proven |
| --- | --- | --- |
| Per-service multi-stage Dockerfiles (build context = repo root) | `services/api/Dockerfile`, `services/media-worker/Dockerfile` | reviewable (Docker not installed here; build commands + `pnpm deploy --prod` layout verified locally) |
| ffmpeg/ffprobe via static linux binaries; sharp prebuilt linux binaries | worker Dockerfile header + `src/sandbox/*` | reviewable |
| `.dockerignore` at repo root (node_modules, dist, .turbo, .git, tests, secrets) | `.dockerignore` | reviewable |
| Compose builds + migrate init service gating api/worker; mem/cpu budget | `infra/compose/docker-compose.yml` | YAML-validated |
| Migrate runner applies 0000..0005 in order, invokable as a script | `src/db/migrate.ts` (dev: `pnpm db:migrate`; prod: `node dist/db/migrate.js`) | LOCAL (ordering: `test/unit/migrate-files.test.ts`) / DOCKER (shape: `test/integration/schema.test.ts`) |
| Graceful shutdown closes WS + chat pub/sub subscriber + Redis + DB pool + pg-boss | `src/server.ts` shutdown, `di.ts` Container.close, `adapters/chat-service.ws.ts` close | LOCAL (`test/unit/chat-realtime.test.ts` close() case; `test/unit/di.test.ts`) |
