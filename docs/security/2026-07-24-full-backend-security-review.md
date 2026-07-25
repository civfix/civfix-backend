# Full backend security review — 2026-07-24

Scope: the entire `civfix-backend` monorepo (`services/api`, `services/media-worker`, `packages/config`, `infra/`) at commit `0adfd1e`, branch `public-home-feed`. Every HTTP endpoint, every WebSocket frame type, the media pipeline, the inbound-mail webhook, the public form intake, and the platform/config layer were read adversarially by eight parallel auditors. Findings below are evidence-based: each cites a file:line that was read, not inferred.

**Headline:** one CRITICAL (a hardcoded, default-on authentication bypass shipped in `README.md`), thirteen HIGH, twenty-two MEDIUM, sixteen LOW. No SQL injection exists anywhere in the codebase — a dedicated sweep enumerated all ~340 raw-SQL construction sites and every one is parameterized or built from a closed TypeScript union.

---

## CRITICAL

### C1. Hardcoded universal login backdoor, ON BY DEFAULT in production

- **Location:** `services/api/src/env.ts:224`, `services/api/src/auth/otp.ts:85-86,224-229`, `services/api/src/auth/auth-services.ts:87-89`, `README.md:279-291`
- `REVIEWER_OTP_BYPASS: parseBool(source.REVIEWER_OTP_BYPASS, true)` — default `true`, no production guard, and the wiring uses `!== false` so a typo'd value leaves it on.
- The credentials `reviewer@civfix.org` / `000000` are string constants in source **and documented in the committed README**.
- The bypass short-circuits *before* every OTP throttle (`otp.ts:224` runs ahead of `verifyThrottleTripped` at `:234`), so it is not even rate-limited beyond the route's 10/min/IP.
- **Attack:** `POST /v1/auth/otp/verify {"email":"reviewer@civfix.org","code":"000000"}` → a real 30-day session for a `profile_complete`, `email_verified` citizen account, auto-created on first use. No mailbox access, no prior `otp/request`, no code interception. With `X-Client: mobile` the raw bearer token is returned in the body.
- Per project memory, `REVIEWER_OTP_BYPASS` default-on is live on `api.civfix.org`.
- **Fix:** default to `false`; hard-fail boot when `true` in production without an explicit second opt-in; remove the fixed code from source and README; replace with a per-review, time-boxed secret.
- **Operational:** set `REVIEWER_OTP_BYPASS=false` in the production sops env and redeploy *today*, then audit the `@reviewer` account's activity — this is exploitable right now by anyone who reads the public repo.

---

## HIGH

### H1. Native Apple/Google sign-in has no replay protection — the nonce is supplied by the same request
`routes/auth.routes.ts:79-93`, `auth/jwks.ts:222-226`. The `nonce` is optional and, when present, is compared against a value taken from the attacker's own request body — a tautology. The server never issues or stores a nonce. Any stolen ID token minted for one of the four accepted audiences (`auth-services.ts:96-110`) grants a full session as the victim for the token's `exp` window.
**Fix:** server-issued single-use nonces in Redis; require `nonce`; compare against the *stored* value.

### H2. Operator authority is a persistent DB role — the CF-Access/`ADMIN_EMAILS` gate is login-time only
`auth/admin-guard.ts:16-19`, `routes/admin/auth.routes.ts:108`, `routes/auth.routes.ts:295`. Once `users.role = 'operator'` is written, **any** auth path mints a session carrying `roles:["operator"]` — including the public citizen OTP/Google/Apple login. Removing an email from `ADMIN_EMAILS` or disabling the Cloudflare Access account never demotes the row. An off-boarded operator signs in through the consumer app and has full console access; with `X-Client: mobile` the bearer transport also skips CSRF.
**Fix:** re-check `isAdminEmail` (or a verified `Cf-Access-Jwt-Assertion`) on every `/admin/*` request; tag operator sessions with their mint origin and reject citizen-flow sessions in `requireOperator`.

### H3. Any operator can mint a permanent operator backdoor
`routes/admin/users.routes.ts:159-165`, `services/admin/admin-user-service.ts:326-331`. `POST /admin/users/:id/role` accepts `role:"operator"` with no allowlist check, no `actor !== target` guard, and no protection of existing operators from demotion or ban. Chained with C1, one call turns the world-readable `reviewer@civfix.org`/`000000` credential into full admin.
**Fix:** refuse `operator` from this endpoint (or require the target's email to be allowlisted); reject self-targeting; block role/status mutations against current operators.

### H4. Rate limiter fails OPEN — a Redis blip disables every HTTP rate limit
`plugins/rate-limit.ts:28` sets `skipOnError: true` globally. When the Redis store errors, every `config.rateLimit` bucket vanishes simultaneously: OTP request (5/min), OTP verify (10/min), OAuth (20/min), anon report create, media presign, data export. It also masks a *misconfigured* `REDIS_URL` — the app boots and silently serves with zero rate limiting.
**Fix:** `skipOnError: false` for the auth/anon/media scopes (register a second fail-closed limiter instance); add a boot-time Redis `PING` assertion in production.

### H5. Session token accepted as a URL query parameter on the WS upgrade
`ws/handshake.ts:38-51`. `wss://…/ws?token=<30-day session>` writes a full-privilege credential into every upstream access log, APM trace, and browser history entry. The API's own pino serializer strips the query (`server.ts:103`), which hides the leak locally while it persists at the edge. A correct single-use `?ticket=` mechanism already exists.
**Fix:** delete the `query.token` branch.

### H6. WS `leave` frame is completely unauthorized — presence injection into any room + broadcast amplification
`ws/frame-handler.ts:206-209`, `:85-103`; `adapters/chat-presence.ts:133-146`. `handleJoin`/`handleSend`/`handleTyping` all call `authorizeRoom`; `handleLeave` calls nothing. And `presence.leave` computes `userGone` from *absence*, so a never-present user always trips the announce branch. Any authenticated user injects `{"type":"leave","roomKind":"dm","cleanupId":"<victim thread>"}` into rooms they have no relationship with. There is no per-frame rate limit, so this is also an unbounded Redis-publish amplifier.
**Fix:** gate on `session.joined.has(roomKey)`; make `presence.leave` return `userGone:false` when the `zrem` removed nothing; add a global per-connection frame bucket.

### H7. Any room member can forge `kind:"system"` messages
`ws/frame-handler.ts:236-252`; the shared `send` frame reuses the full `ChatMessageKind` enum. A member of a public report chat sends `{"kind":"system","body":"Status updated to Resolved by the City of Los Angeles."}` and it persists and broadcasts as a platform/city timeline event. The forged row is then permanently uneditable and unpinnable.
**Fix:** server-side allowlist of client-authorable kinds (`text`, `share_pin`, `task_complete`, `rsvp_change`); reject `system`/`poll` at the gateway and refuse `kind='system'` with a non-null `sender_id` at the repo.

### H8. Post report-attachment bypasses the report visibility gate
`services/post-repository.drizzle.ts:609` (attach) and `:323-345` (read). The attach check validates `visibility` but not `status`; the read-time hydration validates neither. Two consequences: (a) an anonymous submitter attaches their own **`held`** (pre-moderation) report to a public post and its title, exact `lat/lng`, address and photo render in the signed-out public feed; (b) once attached, the owner's later `unlist` is silently ineffective — `loadReports` re-reads the row on every render and never re-checks visibility.
**Fix:** enforce `status='published' AND visibility='public'` in both places, ideally via a shared fragment next to `report-visibility.ts`.

### H9. `GET /media/:id` performs no authorization at all
`routes/media.routes.ts:92-96`, `services/media-intake-service.ts:226-246` — the viewer parameter is named `_viewer` and discarded. The only checks are `status==='ready'` and a single carve-out for `purpose==='verification'`. Anyone holding a media id (no session required) gets a fresh presigned URL for private DM and group-chat attachments, media on held/unlisted reports, and attachments on deleted posts — forever, with no revocation.
**Fix:** resolve the asset's binding (`report_id`/`chat_message_id`/`post_id`) and authorize against that subject's existing visibility rules; 404 for anonymous callers on chat-bound assets.

### H10. Inbound email (raw `.eml` + attachments) is written to the PUBLIC CDN bucket when `R2_INBOUND_BUCKET` is unset
`di.ts:187-194` silently falls back to `env.R2_BUCKET`; `adapters/storage.r2.ts:104-107` returns an unsigned permanent URL whenever `publicBase` is set. Both vars are `[OPT]` with no cross-check. A deploy with `R2_PUBLIC_BASE` set and `R2_INBOUND_BUCKET` unset publishes full citizen↔city correspondence, bounce DSNs, and every emailed attachment at `https://cdn.civfix.org/inbound/failed/<slug>.eml`.
**Fix:** require `R2_INBOUND_BUCKET` at boot whenever `R2_PUBLIC_BASE` is set, assert it differs from `R2_BUCKET`, and never construct `inboundStorage` with a `publicBase`.

### H11. Push-token registration has no proof of device ownership
`routes/notifications.routes.ts:124-129`, `services/notification-repository.drizzle.ts:218-247`. Whoever registers a device token first owns it. An attacker who obtains a victim's Expo/APNs token (client logs, refurbished device, crash report) binds it to their own account and can then push attacker-authored title+body to the victim's lock screen with the app's branding. The victim's subsequent legitimate registration hits the `WHERE` guard, returns `"conflict"` — and `notification-service.ts:293-299` **logs a warning and returns `{ok:true}`**, so the client believes it succeeded and silently never receives push again.
**Fix:** prove possession via a nonce round-trip (silent push → client echo) or device attestation; return a real error on conflict.

### H12. Attacker-chosen `deviceId` drives a mass token revocation
`services/notification-service.ts:303-309`, `notification-repository.drizzle.ts:238-247`. The code comment asserts "device_id is the device's own secret" — the server never verifies this; it is an unconstrained `z.string().optional()` from a JSON body. One request revokes **every active push token on that device belonging to every other user**. A harvested device-id list yields a fleet-wide push blackout.
**Fix:** derive device identity from an attested source, or scope the revoke to rows the same token previously occupied; constrain the field and alert on cross-account revokes.

### H13. Reachable HIGH/CRITICAL dependency advisories in the production tree
`pnpm audit --prod` → 44 vulnerabilities (1 critical, 23 high). Most reachable: `linkify-it@5.0.1` and `nodemailer`/`mailparser` sit directly on the unauthenticated inbound-mail path (quadratic DoS; raw-option bypass of `disableFileAccess` → arbitrary file read + SSRF). `node-apn@3.0.0` is abandoned and pins `node-forge@0.7.6` (seven advisories including RSA/Ed25519 **signature forgery**) and `jsonwebtoken@8.5.1` — unfixable by range bump. Also `websocket-driver@0.7.4` (CRITICAL, via firebase-admin), `find-my-way`/`fast-uri` (via fastify), `sharp@0.34.5` (libvips CVEs), `drizzle-orm@0.36.4` (identifier-escaping SQLi — **verified not reachable**, no `sql.raw`/`sql.identifier` call sites exist).
**Fix:** bump `nodemailer@^8.0.4`, `drizzle-orm@^0.45.2`, `fastify@latest`, `sharp@^0.35.0`; replace `node-apn` or add `pnpm.overrides` forcing `node-forge@^1.4.0` + `jsonwebtoken@^9`; add `pnpm audit --prod --audit-level high` as a CI gate.

---

## MEDIUM

| # | Finding | Location |
|---|---|---|
| M1 | A live WebSocket is never re-authorized — revoked, logged-out and **banned** users keep full chat access until they close the tab | `ws/socket-lifecycle.ts:95-235` |
| M2 | WS ticket redemption is `get`+`del`, not atomic — the same ticket authenticates N concurrent connections; also stored in plaintext in Redis (sessions are hashed) | `auth/ws-ticket.ts:28-35` |
| M3 | No absolute session lifetime — sliding expiry has no ceiling, so one request every ≤15 days keeps a stolen token alive forever on a passwordless product | `auth/session-service.ts:258-274` |
| M4 | `gov-claims` approve calls `setRole` without `revokeAll` — a prior operator keeps operator authority in every live session | `services/admin/gov-claims-service.ts:310-314` |
| M5 | `POST /admin/reports/:id/route` emails a full report packet (reporter name, exact coords, photos) to an operator-supplied **arbitrary** address; the audit write is outside the transaction and swallowed on failure | `routes/admin/reports.routes.ts:160-183` |
| M6 | Admin inbox serves attacker-controlled raw `bodyHtml` from arbitrary inbound senders with no server-side sanitization; the CSRF cookie is JS-readable, so console XSS is a full authz bypass | `services/admin/inbound-processor.ts:247-250` |
| M7 | Forged inbound email can impersonate a jurisdiction: no SPF/DKIM/DMARC check anywhere, and a spoofable `X-Thread-Token` **header** selects the thread. Flips report status, writes attacker text into the public report chat as an official city reply, and pushes "Your report got a response" to the reporter | `adapters/inbound-mail.cf.ts:82-98`, `services/admin/inbound-thread-correlation.ts:46-103` |
| M8 | `/forms/home-turf` is a spam/phishing amplifier — attacker-chosen recipient + attacker-controlled body, DKIM-signed by civfix's own domain. The hourly cap silently disappears when `REDIS_URL` is empty | `routes/forms.routes.ts:166-172,226-242,124-130` |
| M9 | The NSFW moderation gate is inert in production — `useRealNsfw` defaults false and no model is vendored, so `nsfwScore` returns 0 and the entire held/review path is dead code. Unauthenticated anon uploads auto-publish | `adapters/abuse-checks.ts:15-21`, `media-worker/src/seams.ts:186-191` |
| M10 | Presigned uploads are fully unauthenticated — no account, no anon session, no byte quota. 30/min × 50 MB = 90 GB/hour/IP, reclaimed at 200 rows/hour against 43,200 created/day | `routes/media.routes.ts:47-76`, `media-worker/src/config.ts:85` |
| M11 | Block bypass: report-room and group-room notification fan-out never checks blocks (the mention/reply bells do), so a blocked user pushes ~30 notifications/min to their target via a shared public room | `services/report-chat-notifier.ts:39-64`, `group-chat-notifier.ts:64-92` |
| M12 | Group membership requires no consent and the block filter is actor-relative only — a third party can force a blocked pair into the same room, repeatedly | `services/chat-group-service.ts:130-138,216-225` |
| M13 | No per-frame WS rate limit on `join`/`typing`/`ack` — each is a DB + Redis round-trip; 30 concurrent sockets per host | `ws/socket-lifecycle.ts:211-217` |
| M14 | Anonymous caller forces 2000 full report rows + 2000 media presigns per request by sending `zoom=22` with a world bbox; `Cache-Control` defeated by jittering the bbox; no per-route limit | `routes/reports.routes.ts:319-329`, `services/report-clustering.ts:71-73` |
| M15 | Postgres connections do not require TLS — `postgres.js` defaults to `ssl:false` and nothing validates `sslmode` in `DATABASE_URL` | `db/client.ts:31-40` |
| M16 | `appleSignIn`, `googleSignIn` and `checkHandle` have no per-route rate limit — handle enumeration and ID-token grinding at the global 300/min/IP | `routes/auth.routes.ts:79,89,205` |
| M17 | Removing an event attendee is unenforceable: no ban table, `join` is unconditional, and their live socket is never evicted from the room | `services/cleanup-service.ts:396-401,471-506` |
| M18 | Notification bombing via promote/demote — alternating the two legal roles defeats the idempotency check; ~300 lock-screen pushes/min/IP, no per-route limit | `services/cleanup-service.ts:435-469` |
| M19 | The slur filter is not applied to any event field or to the cancellation reason — both are public and both fan out to every attendee | `services/cleanup-service.ts:224-349` |
| M20 | Resource-request cooldown is an in-process `Map` keyed on `cleanupId` — a fresh throwaway event resets it, making the app a relay into municipal inboxes at ~150 emails/min | `services/cleanup-service.ts:62-78,508-568` |
| M21 | Volunteer hours: a verified host credits themselves with no second party; the upsert overwrites in place with no history of prior values | `services/volunteer-hours-service.ts:89-147` |
| M22 | Global limiter keys on IP only — an authenticated attacker escapes by rotating IPs while the *account* is never counted | `plugins/rate-limit.ts:19-30` |

---

## LOW

| # | Finding | Location |
|---|---|---|
| L1 | CSRF missing on the two authenticated media endpoints; CSRF is opt-in per route rather than default-deny | `routes/media.routes.ts:67-90` |
| L2 | OTP per-email failure lockout enables targeted account-lockout DoS (10 wrong codes locks the victim out for 15 min, repeatable) | `auth/otp.ts:54-58,234-236` |
| L3 | CSRF token is unbound to the session (pure double-submit) and auth cookies lack the `__Host-` prefix, so a sibling-subdomain compromise enables shadowing/fixation | `auth/csrf.ts:25-27`, `auth/transport.ts:59-68` |
| L4 | Every admin **read** is unaudited, including `GET /admin/users/:id/messages`, which dumps private DM and chat text (incl. user-deleted messages) | `routes/admin/users.routes.ts:131-136` |
| L5 | The role-change audit is written outside the role-change transaction and after the effect | `services/admin/admin-user-service.ts:326-331` |
| L6 | `setInboxStatus` mutates state with no audit row and no actor | `routes/admin/inbox.routes.ts:89-96` |
| L7 | `formUrl` accepts `javascript:` URIs (Zod `.url()` parses them), stored and re-served to admin and public UIs | shared `PatchJurisdictionRequestSchema` |
| L8 | Private-group 404-vs-403 existence oracle in the HTTP lane, contradicting the WS lane's deliberately uniform 403 | `services/chat-group-service.ts:140-153` |
| L9 | `PUT /conversations/mute` writes an arbitrary `roomId` with no existence/membership check and no rate limit | `routes/conversations.routes.ts:53-62` |
| L10 | DM pin power ignores blocks (every other DM surface re-checks) | `services/chat-room-roles.ts:90-94` |
| L11 | Several state-changing chat routes carry no route-level rate limit (delete/join/leave/role/mute family) | `routes/chat.routes.ts:167`, `report-chat.routes.ts:107,166,179`, `chat-groups.routes.ts:133,171,179,210` |
| L12 | 403-vs-404 discrepancy on report mutations is an existence oracle for held and unlisted reports | `services/report-repository.drizzle.ts:336-360` |
| L13 | Follower/following lists ignore blocks (`suggestFollows` and search do filter them) | `services/social-repository.drizzle.ts:295-307` |
| L14 | The declared `sha256` is shape-checked but never verified or persisted; two stale comments claim keys are content-addressed when they are not | `services/media-intake-service.ts:127-130`, `media-worker/src/jobs/orphan-sweep.ts:94` |
| L15 | Image format allowlist is enforced *after* `metadata()`, so libvips' SVG/PDF/TIFF header loaders are reached with untrusted bytes | `media-worker/src/sandbox/image.ts:167-180` |
| L16 | Turnstile verification ignores `hostname` and `action` in the siteverify response | `adapters/abuse-checks.ts:153` |
| L17 | Inbound-mail webhook signature has no replay window (bounded by message-id idempotency) | `routes/webhooks/inbound-mail.routes.ts:133-150` |
| L18 | Report media claim does not exclude assets already bound to a post or chat message (the post path has the stricter guard) | `services/report-repository.drizzle.ts:148-154` |
| L19 | `/readyz` is unauthenticated, rate-limit-exempt, and does real DB+Redis I/O per hit; `/healthz` discloses the build version | `plugins/rate-limit.ts:7`, `routes/health.routes.ts:34-73` |
| L20 | `TRUST_PROXY` parser accepts `true`, which would trust any client `X-Forwarded-For` and defeat every per-IP control. Default is correct (RFC1918+loopback CIDRs); the footgun is that nothing rejects `true` in production | `env/parsers.ts:105` |
| L21 | HSTS is set without `preload` and with a 180-day max-age | `plugins/helmet.ts:32` |
| L22 | Admin jurisdictions directory accepts an unbounded `OFFSET` (lower-clamped only) | `services/admin/pagination.ts:60-66` |
| L23 | Unbounded arrays in `entries` (volunteer hours) and `bring` (events) — capped only by the 256 KB body limit | shared `LogEventHoursRequestSchema`, `CreateCleanupRequestSchema` |
| L24 | Event-cancellation notifications bypass the notification pipeline (no prefs, no quiet hours, no localization) | `services/cleanup-repository.drizzle.ts:539-544` |
| L25 | Attendee roster is enumerable by any user via join → read → leave | `services/cleanup-service.ts:414-433` |
| L26 | Pagination cursors are opaque but unauthenticated (no authorization data encoded, so defense-in-depth only) | `db/cursor-helpers.ts:24-79` |

---

## Verified clean

These were specifically probed and found sound. Listed so the next reviewer knows the coverage.

**Injection.** No SQL injection exists. A dedicated sweep enumerated every raw-SQL site: zero `sql.raw`/`sql.identifier` call sites; three `sql.unsafe` sites, all on module constants or filesystem-read migration text; every `${sql(x)}` identifier interpolation resolves to a closed TypeScript union; every `ORDER BY` is a compile-time literal or a switch over enum-validated values; `LIMIT`/`OFFSET` always bound and clamped; all 25 `ILIKE` sites pair `escapeLike` with `ESCAPE '\\'`; no `to_tsquery` anywhere; PostGIS envelopes and `make_interval` use bind params. Also clean: no `eval`/`new Function`/`child_process` string concatenation, no dynamic `import()` with user input, no Redis `KEYS`/`SCAN`, no log injection, no ReDoS in the slur matcher, and a custom `scripts/check-dynamic-sql.mjs` CI gate enforcing the `sql.unsafe` allowlist.

**Command injection & SSRF in the media pipeline.** `execa` with `shell:false` and a fixed argv array everywhere; binaries from `ffmpeg-static`/`ffprobe-static`. `-protocol_whitelist file` precedes `-i`. The worker fetches exactly one URL — a presign over a key read from the database, additionally validated by `isSafeR2Key`. Web-push targets are DNS-resolved with *all* addresses required to be public and the connection pinned to the validated address, closing the rebinding TOCTOU.

**Media hardening.** Server-generated UUID R2 keys (no traversal, no user-controlled key); content-type and content-length cryptographically bound into the signed PUT; `text/html` and `image/svg+xml` unsignable; magic-byte validation, not extension or client MIME; EXIF/GPS stripped on re-encode and video metadata dropped via `-map_metadata -1`; pixel-flood guarded twice; per-stage timeouts with `SIGKILL`; no transcode (stream-copy only); `mkdtemp` scratch dirs with sanitized names and boot-time sweep.

**Auth primitives.** OTP codes use `randomBytes` with rejection sampling, argon2id-hashed at rest, constant-time compare, single-use, 5-min TTL, TOCTOU-safe attempt counter, identical responses for registered and unregistered addresses. Session tokens are 256-bit and stored only as SHA-256; fixation impossible; `setRole` revokes all sessions; the banned-user veto runs before expiry sliding; the auth hook fails **closed** on store errors. JWKS pins RS256 with a required `kid`, validates `iss`/`aud`/`exp`/`nbf`, uses `redirect:"error"`, and rate-floors force-refresh. CF Access does a real `jwtVerify` — the header cannot be spoofed. `ADMIN_EMAILS` empty ⇒ nobody can log in (fail-closed). OAuth web flow has signed-cookie state, PKCE, and a validated redirect allowlist; email-based account linking requires `emailVerified`.

**Anonymous reporting.** Anon tokens are HMAC'd with constant-time compare; the 5-report cap is enforced transactionally; claim codes are 256-bit, per-report, single-use, atomic, with no enumeration; prod boot refuses the dev signing key. Held anon reports carry `reporter_user_id NULL` — there is no identity to recover. Map pins, search, and clusters all project through `selectPublicPins`, which hard-codes the visibility predicate (the sole leak is H8).

**Messaging authorization.** No handler anywhere trusts a body/query-supplied `userId` for authorization. Every HTTP chat/DM/group/report endpoint and every WS frame except `leave` re-verifies membership against the session identity; edit/delete/pin/react check ownership *and* room scope; pagination cursors are re-anchored inside the target room so a foreign cursor cannot seek across rooms; broadcast channels are per-room-key; the group role matrix (owner un-removable, admins removable only by owner, actor-power checked before target lookup) is correct; WS handshake checks Origin *before* auth and requires an allowlisted Origin for cookie-bearing upgrades (correct CSWSH defense).

**Platform.** CORS is exact-match `Set.has`, never reflects with `credentials:true`, and fails closed in prod. CSP is `default-src 'none'` with `frame-ancestors 'none'`. 500s and 404s are stealth in production. pino redacts authorization/cookie/set-cookie/csrf/password/token/otp/email and strips query strings; GlitchTip deep-redacts including PII. No hardcoded secrets, no committed `.env`, no fallback secret reachable in production; the env Proxy's `toJSON` is redacted; boot fails on any missing required secret. Both Dockerfiles run as `USER node` with no secrets in layers. Body limit 256 KB, `requestTimeout` 15s, `connectionTimeout` 10s — slowloris bounded. `x-request-id` is charset-validated before echo. The migration runner is a separate CLI, never mounted.

**Email.** Envelope addresses are *rejected* (not sanitized) on CR/LF/NUL; subjects and custom headers stripped and length-clamped; every interpolated HTML block escapes. The inbound webhook HMACs the exact raw bytes with a constant-time compare, fails closed when unconfigured, constrains the object key by regex, and forces attachments to `application/octet-stream`.

**Admin surface.** All 78 admin endpoints were inventoried; the `requireOperatorPreHandler` hook's Fastify encapsulation scope was verified to cover all 14 data routers — zero routes escape the guard. Path params are UUID-validated before SQL; no mass assignment (path id spread last, explicit Zod schemas); no admin endpoint returns user email/phone/IP/tokens; no outbound `fetch` exists in the admin domain (no SSRF); hard deletes are narrow and audited in-transaction.

---

---

# Remediation status (as of 2026-07-24)

**Everything above is fixed in the working tree** except the deferrals listed at the end. 137 files changed, ~6.9k insertions. Verification: `pnpm typecheck` 5/5 tasks, `pnpm lint` 3/3, `pnpm test` **2043 passed / 0 failed** (350 skipped are the Docker-gated integration suites), `node scripts/check-dynamic-sql.mjs` clean, `pnpm audit --prod --audit-level high` exit 0 with no suppressions. Nothing is committed — the changes are uncommitted on branch `public-home-feed`.

Dependency posture went from **44 vulnerabilities (1 critical, 23 high)** to **5 moderate**, all transitive under `firebase-admin`/`@sentry/node` with no fix available upstream.

## Pre-push audit of the change set itself

Before any of this was committed, a second adversarial pass read the whole diff through six independent lenses (secrets, availability/outage risk, migrations, test quality, cross-agent coherence, and whether any fix introduced a *new* vulnerability), with skeptics attempting to refute each blocker. It found **23 further findings: 1 blocker and 4 highs**. The green build had proved none of them — several reproduce only when `isProd()` is true, and one was actively masked by a test fake that copied the bug.

This is the part worth internalizing: six agents each did competent work inside their own file list, and the defects clustered exactly at the seams between them, and in the *new* code the fixes introduced.

**Blocker — the orphan sweep would have destroyed user data on the first run after deploy.** `findOrphans` defined an orphan as `report_id IS NULL` alone, but `media_assets` has three binding columns plus a reverse binding for avatars, and every non-report lane leaves `report_id` NULL. Avatars, social-post photos and chat/DM attachments all matched the predicate. The predicate was pre-existing; what this change set added was the amplification — a 24h→6h TTL and a 200-row cap replaced by a drain loop of up to 50,000 rows per hourly run — turning a latent bug into fleet-wide irreversible deletion of rows *and* their R2 objects, with `avatar_media_id` silently NULLed by an `ON DELETE SET NULL` FK. The in-memory test fake reproduced the same broken predicate, which is why the suite was green. Fixed: the predicate now means "bound to nothing, in either direction", and the fake mirrors it.

**Highs, all of which would have broken production on deploy:**
- CSRF was added to `/media/upload` and `/media/:id/finalize`, but the published `@civfix/shared` client declares `csrf: false` for both, so it never sends the header — every signed-in web photo upload would have 403'd. Reverted, since the finding it addressed was LOW and the browser attack is already blocked by the CORS preflight; re-add it in the same release that ships the contract change.
- The mandatory OAuth nonce would have 422'd native Apple/Google sign-in for every installed mobile build, recoverable only by an App Store release. Now gated behind `OAUTH_REQUIRE_NONCE` (default off) — a presented nonce is always validated, so updated clients are protected immediately; the old same-request tautology is not reachable under any setting.
- The admin session route still read the pre-rename CSRF cookie, so in production the reuse branch never fired and every session bootstrap rotated the token out from under the tab holding it. Both admin mint sites now derive the session-bound token, which also closes the admin legacy-fallback gap.
- The new hand-written HTML sanitizer passed through **any tag whose name contains an underscore** — `<div_ onmouseover=…>` survived byte-identical, and browsers honour event handlers on `HTMLUnknownElement`, so with a JS-readable CSRF cookie that is a full admin authorization bypass. It also deleted the entire remainder of the document on any void drop-tag, so `<meta charset>` — present in essentially every real email — reduced the stored body to `""`. Both fixed, and while fixing them a **quadratic blowup was found in the replacement regex** (7.6s on a 512 KB body, on an unauthenticated path); the pass is now a linear scan.

Three claims were investigated and **refuted**, and are recorded here so this document does not overstate: that the new code hard-fails against the old schema during the manual-migration window; that the H9 authorizer has no test; and that the `javascript:` URI gate was missed on the public writer.

Fixed before pushing: the blocker, all four highs, and six mediums (rate-limit prefix coverage, the identity-vs-IP keying regression, the poll fan-out block gate, the cleanup pin-rail presigner, and both sanitizer defects). One of those — the rate-limit key — was a regression this change set introduced: keying on identity *instead of* IP meant one host with N accounts got N × every budget, weaker than what it replaced. The global bucket is IP-keyed again, with identity counted as an additional dimension on the sensitive bucket.

**Still outstanding from this pass** (all medium/low, none a data-loss or outage risk): the attendee-ban race in `removeMember` (a plain `SELECT` probe locks nothing, so an in-flight join can re-create membership past the ban — needs an advisory lock); the WS typing throttle's now-unbounded per-connection map; the Turnstile hostname/action binding, which is wired but never passed a config in `di.ts` and so asserts nothing; the README omitting `REVIEWER_OTP_BYPASS_ACK`, which would make a production boot fail; a false invariant comment in `role-change.ts`; and five stale comments or test descriptions that claim behavior the code no longer has.

## Operator actions required BEFORE the next deploy

The app now fails closed on several of these — it will **refuse to boot** rather than run insecurely.

0. **`REVIEWER_OTP_BYPASS_ACK`** — enabling the reviewer bypass in production now requires this third variable (`=true`) *in addition to* `REVIEWER_OTP_BYPASS` and a `REVIEWER_OTP_CODE` of >=20 chars. With the bypass on and this missing, `loadEnv` throws and the box does not start. (The README table still omits it — see the outstanding list above.)
1. **`REVIEWER_OTP_BYPASS`** — default is now `false`. If the sops env sets it truthy, the box will not start unless **both** `REVIEWER_OTP_BYPASS_ACK=true` and `REVIEWER_OTP_CODE=<≥20 random chars>` are also set. Recommended: set it to `false` and audit the `@reviewer` account's activity — the old credential was public.
2. **`DATABASE_URL` must carry `sslmode=require`** (or `verify-ca`/`verify-full`) in production. Confirm the Postgres endpoint actually accepts TLS first; if it is a same-host container link with no server cert, this breaks connections, not just the boot check.
3. **`R2_INBOUND_BUCKET`** is now required whenever `R2_PUBLIC_BASE` is set, and must name a different, non-public bucket than `R2_BUCKET`. Separately: **audit `https://<R2_PUBLIC_BASE>/inbound/…` for already-published `.eml` objects** — the code fix does not retract what is already exposed.
4. **`TRUST_PROXY`** must not be the literal `true` in production.
5. **Redis must be reachable at boot** — `server.ts` now asserts it.
6. **`OAUTH_REQUIRE_NONCE`** — leave unset (off) until a nonce-sending mobile build is the store floor, then flip it to `true`. Turning it on early 422s native sign-in for every older install.
7. **`WS_ALLOW_QUERY_TOKEN` must stay unset.** It is the break-glass switch re-enabling the leaking `?token=` WS path for store-shipped mobile builds that predate the fix.
8. **Reconcile operator accounts against `ADMIN_EMAILS` before deploying.** `ADMIN_EMAILS` is now the sole source of operator truth, re-checked on every admin request (60s cache). Any operator whose `users.email` is absent from it gets 403 on every admin route within a minute of deploy. Run `SELECT email FROM users WHERE role='operator'` and diff. Watch for NULL emails and case/alias mismatches (the check is trim+lowercase exact match, no plus-address normalization). Operators can no longer be created or removed from the console — onboarding is `ADMIN_EMAILS` + Access sign-in.
9. **Two migrations to apply manually on the box** (deploy does not auto-migrate): `drizzle/0052_cleanup_bans.sql`, `drizzle/0053_volunteer_hours_audit.sql`. Both forward-only and `IF NOT EXISTS`.

## Coordinated client releases required

| Change | Client | Breaking? |
|---|---|---|
| Native Apple/Google sign-in now requires a server-issued nonce from `POST /v1/auth/oauth/nonce` | mobile (+ web if it uses native sign-in) | **Yes** — old clients get 401/422 on native sign-in |
| `POST /notifications/push` returns **409** when a token belongs to another account; `deviceId` must be a UUID (non-UUID is silently dropped, registration still succeeds) | mobile | Yes — clients assuming 200 must handle it |
| CSRF token is now session-bound and cookies gain the `__Host-` prefix in production (legacy names still readable for one session lifetime) | web + mobile | Transitional |
| `POST /media/upload` and `/media/:id/finalize` now require `X-CSRF-Token` on cookie sessions | web (already sends it for `createReport`) | Verify only |
| Drop the `?token=` WS fallback and treat a failed `wsTicket()` as a retryable connect error; handle `{type:"error",code:"UNAUTHORIZED"}` + close 1008 by re-authenticating | mobile | Yes, once `WS_ALLOW_QUERY_TOKEN` is unset |
| Inbound webhook signs `<timestamp>.<body>` with `x-cf-timestamp` (legacy body-only signatures still accepted, with a warn) | Cloudflare Email Worker (`civfix-infra`) | Transitional |

## Follow-ups in `@civfix/shared`

Server-side enforcement is in place for all of these; the contract fixes are defense in depth.

- Narrow `WsClientMessageSchema`'s `send.kind` to the client-authorable subset (`text | share_pin | task_complete | rsvp_change`).
- Replace `.url()` with a scheme-checked refinement on `formUrl` in `PatchJurisdictionRequestSchema` / `SaveContactsRequestSchema` / `SaveDraftRequestSchema`.
- Add `.max()` to `LogEventHoursRequestSchema.entries` and `CreateCleanupRequestSchema.bring` (+ the update variant).
- Drop `X-Thread-Token` from `FakeInboundMail.extractThreadToken` — the real adapter no longer honors it.

## Deliberately deferred

| Item | Why | What it needs |
|---|---|---|
| H2 session-origin tagging (the stronger control) | The shipped fix is the `ADMIN_EMAILS` re-check, which closes the hole; origin tagging makes a citizen-flow session *structurally* incapable of operator authority | An `origin` column on `sessions` + migration, threaded through `SessionService`/`CachedSession` |
| M12 full pending-invite consent | Shipped: invitees blocked either-way with any existing member are filtered out | New `chat_group_invites` table + shared schemas + endpoints + client release |
| M10 requiring a session for presign | Not implementable as stated — the anon token is only issued by `POST /anon/reports`, which happens *after* upload; requiring it would break first-time anonymous reporting. Shipped instead: a 512 MB/subject/day byte quota, a looping orphan sweep, 6h orphan TTL | A separate anon-session bootstrap endpoint |
| M9 NSFW default is `flag`, not `hold` | With no model vendored, `hold` holds 100% of all media and the anon hold-release path gates report publication on media readiness — defaulting to `hold` would take anonymous reporting offline. `flag` publishes but raises the abuse flag so every unscored asset reaches the moderation queue; `MEDIA_UNSCORED_POLICY=hold` is one env var away | A real NSFW scorer before public launch |
| L14 sha256 persist + verify | Stale "content-addressed" comments deleted and the shape-check relabelled; keys are random UUIDs so the described attack never applied | A `media_assets.sha256` column + worker-side re-hash |
| M17 socket eviction on attendee removal | Ban table and join rejection shipped; a removed attendee can no longer re-join. Their *already-open* socket still receives broadcasts until it closes | A revocation publish on the room channel consumed by `ws/socket-lifecycle.ts` |
| L24 localization of cancellation bells | Prefs and quiet hours now honored (routed through `NotificationService`); title/body are still English literals | Four `notification.cleanup_cancelled.*` keys in `i18n/messages/{en,es,de,ko}.ts` |
| `onEventReply` sender gate | Same missing check as `onJurisdictionReply`, but now standing behind the new DMARC gate | Apply `isJurisdictionSender` there too |
