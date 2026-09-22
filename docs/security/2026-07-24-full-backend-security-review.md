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

**Still outstanding from this pass** (all medium/low, none a data-loss or outage risk), re-verified
file-by-file against the tree at the close of the final review pass. Each item names the file and the
mechanism, so a later fix is verifiable from here rather than leaving this list ambiguous:

- **Turnstile hostname/action binding asserts nothing.** `AbuseChecks` accepts `turnstileHostnames`
  (`services/api/src/adapters/abuse-checks.ts:68`, consumed at `:200`), but `di.ts:333` passes only
  `turnstileSecret` and **no `CF_TURNSTILE_HOSTNAMES` variable exists in `env.ts`**, so a token minted on
  another origin is not rejected on that basis and the code emits a once-per-process notice instead.
  Check: `grep -rn CF_TURNSTILE services/api/src`. Enabling it is an env var + `.env.example` + one
  `di.ts` line; deleting the dep and its notice is the alternative.
- **The account-deletion OTP shares the sign-in cooldown.** Deletion re-proves the email through the same
  `POST /auth/otp/request`, so it shares the one `otp:rl:email:<email>` 60s key (`src/auth/otp.ts:245-255`),
  and a user who just signed in is told to wait on a GDPR erasure path (`src/routes/users.routes.ts:210-213`).
  A server-side namespace needs a `purpose` field on `EmailOtpRequestRequestSchema` — now listed under the
  `@civfix/shared` follow-ups below rather than only in a code comment.
- **`openDm` still returns a literal `unread: 0`** (`src/services/dm-service.ts:149`) two lines below the
  real `conversationMutes` lookup this pass wired in, so opening an existing thread with unread peer
  messages renders no badge. Half-done rather than broken; the fix is one more read in the same `Promise.all`.
- **The anon `POST /map/resolve-jurisdiction` write-time fallback is uncached and burns a sequence value
  per call.** The endpoint is `auth:"optional"`, `csrf:false`, IP-keyed at 30/min, and now runs the Census
  lookup, which lazily UPSERTs a NULL-`geom` `jurisdictions` row. Because `JURISDICTION_RESOLVE_SQL` is
  `ST_Contains(geom, …)`, a NULL-geom row never satisfies it, so every repeat call re-fetches from Census
  and re-writes; and `nextval('jurisdiction_code_seq')` sits in the `VALUES` list
  (`src/services/jurisdiction-service.ts:263-276`), so a code is consumed even on the `ON CONFLICT` path.
  This was accepted as A15 on the understanding that the rate limit bounded it; the cost is
  write/fetch amplification per call, not just per new jurisdiction. `jurisdictions.code` is
  `integer UNIQUE` (0030), so exhaustion needs ~2.1B calls — the real issue is the uncached loop.

Four items the earlier draft of this paragraph listed have since been **fixed**, and are recorded here so
nobody re-does them: the attendee-ban race now takes real row locks (`FOR NO KEY UPDATE` on the `cleanups`
row in `cleanup-repository.drizzle.ts:495` vs `FOR SHARE` in `joinCleanupTx:569` — conflicting modes, so an
in-flight join serializes against the removal); the WS typing map is a bounded LRU
(`TYPING_THROTTLE_MAX_ROOMS = 256`, `src/ws/types.ts:20`, eviction at `src/ws/frame-handler.ts:514`); the
false invariant comment in `role-change.ts` is gone and both admin writers do call `applyRoleChange`, with
`provisionOperator` documented as the sole exception; and the README's reviewer-bypass table now documents
all three variables including `REVIEWER_OTP_BYPASS_ACK`. That draft also claimed "five stale comments or
test descriptions" without naming one: the count was never substantiated and is **withdrawn** — the
comment-vs-code drift the final review pass did find was enumerated with `file:line` and routed to the
owning area, not tallied here.

## Operator actions required BEFORE the next deploy

The app now fails closed on several of these — it will **refuse to boot** rather than run insecurely.

0. **`REVIEWER_OTP_BYPASS_ACK`** — enabling the reviewer bypass in production now requires this third variable (`=true`) *in addition to* `REVIEWER_OTP_BYPASS` and a `REVIEWER_OTP_CODE` of >=20 chars. With the bypass on and this missing, `loadEnv` throws and the box does not start. Documented in the README's reviewer-bypass table (all three variables, plus the safe order for turning the bypass back off: switch first, then remove the code).
1. **`REVIEWER_OTP_BYPASS`** — default is now `false`. If the sops env sets it truthy, the box will not start unless **both** `REVIEWER_OTP_BYPASS_ACK=true` and `REVIEWER_OTP_CODE=<≥20 random chars>` are also set. Recommended: set it to `false` and audit the `@reviewer` account's activity — the old credential was public.
2. **`DATABASE_URL` must carry `sslmode=require`** (or `verify-ca`/`verify-full`) in production **for any host that crosses a wire**. Confirm the Postgres endpoint actually accepts TLS first; if it is a same-host container link with no server cert, this breaks connections, not just the boot check.

   **AMENDED 2026-07-25 — this assertion took production down.** As originally shipped it had no exemption, and the deployed stack reaches Postgres as `postgres:5432` over the compose bridge using the stock `postgres:16-bookworm` + PostGIS image, which serves **no certificate**. The `migrate` container calls `loadEnv()` before any SQL, so it exited non-zero within a second and every deploy failed at the migrate step with the API left down — and `sslmode=require` would not have fixed it, because libpq then refuses to connect at all. `loadEnv` now exempts hosts the packets cannot leave the machine to reach (`localhost`, `127.0.0.0/8`, `::1`, or a single-label compose alias); see `isNonRoutableDbHost` in `src/env.ts`. Dotted names and the RFC1918 *addresses* are deliberately NOT exempt — "private IP" has never meant "nobody can see the wire". The residual risk is cleartext on the docker bridge, readable only by something that already has root on the box, at which point the Postgres password in the same env file is already exposed. **To close it properly:** give the postgres service a certificate and `ssl=on`, then put `sslmode=require` back in `DATABASE_URL` — the exemption is written so that needs no code change.
3. **`R2_INBOUND_BUCKET`** is now required whenever `R2_PUBLIC_BASE` is set, and must name a different, non-public bucket than `R2_BUCKET`. Separately: **audit `https://<R2_PUBLIC_BASE>/inbound/…` for already-published `.eml` objects** — the code fix does not retract what is already exposed.
4. **`TRUST_PROXY`** must not be the literal `true` in production.
5. **Redis must be reachable at boot** — `server.ts` now asserts it.
6. **`OAUTH_REQUIRE_NONCE`** — leave unset (off) until a nonce-sending mobile build is the store floor, then flip it to `true`. Turning it on early 422s native sign-in for every older install.
7. **`WS_ALLOW_QUERY_TOKEN` must stay unset.** It is the break-glass switch re-enabling the leaking `?token=` WS path for store-shipped mobile builds that predate the fix.
8. **Reconcile operator accounts against `ADMIN_EMAILS` before deploying.** `ADMIN_EMAILS` is now the sole source of operator truth, re-checked on every admin request (60s cache). Any operator whose `users.email` is absent from it gets 403 on every admin route within a minute of deploy. Run `SELECT email FROM users WHERE role='operator'` and diff. Watch for NULL emails and case/alias mismatches (the check is trim+lowercase exact match, no plus-address normalization). Operators can no longer be created or removed from the console — onboarding is `ADMIN_EMAILS` + Access sign-in.
9. **Migrations shipped with this change set** (CORRECTED 2026-09-04: the deploy DOES apply them — the compose `migrate` one-shot runs `node dist/db/migrate.js` before `seed`/`api`/`media-worker`, all three gated on `service_completed_successfully`, so a failed migration blocks the release rather than letting the new images run on the old schema. There is no manual step; the sections below are the failure-signature reference.) Wave 1 added `drizzle/0052_cleanup_bans.sql` and `drizzle/0053_volunteer_hours_audit.sql`; wave 2 added four more (`0054`–`0057`), one of which the new code HARD-DEPENDS on; wave 3 added `0058_sessions_created_at.sql` (the M3 session backfill) and `0059_users_follow_counters.sql`, a SECOND hard dependency — without it every people-facing read fails on an undefined column. All forward-only, and idempotent on re-apply. The full list, ordering constraints and failure signatures are in the operator runbook at the end of this document.

## Coordinated client releases required

| Change | Client | Breaking? |
|---|---|---|
| Native Apple/Google sign-in now requires a server-issued nonce from `POST /v1/auth/oauth/nonce` | mobile (+ web if it uses native sign-in) | **Yes** — old clients get 401/422 on native sign-in |
| `POST /notifications/push` returns **409** when a token belongs to another account; `deviceId` must be a UUID (non-UUID is silently dropped, registration still succeeds) | mobile | Yes — clients assuming 200 must handle it |
| CSRF token is now session-bound and cookies gain the `__Host-` prefix in production (legacy names still readable for one session lifetime) | web + mobile | Transitional |
| ~~`POST /media/upload` and `/media/:id/finalize` require `X-CSRF-Token` on cookie sessions~~ — **reverted before push**, so there is nothing to do in this release: both routes still carry no `csrfProtect` (`routes/media.routes.ts:22-42,145-159` documents why and the exact re-add recipe). The gate returns only in the release that ships `csrf: true` for both endpoints in `@civfix/shared` — see the shared follow-ups below | web (no change now) | No |
| Drop the `?token=` WS fallback and treat a failed `wsTicket()` as a retryable connect error; handle `{type:"error",code:"UNAUTHORIZED"}` + close 1008 by re-authenticating | mobile | Yes, once `WS_ALLOW_QUERY_TOKEN` is unset |
| Inbound webhook signs `<timestamp>.<body>` with `x-cf-timestamp` (legacy body-only signatures still accepted, with a warn) | Cloudflare Email Worker (`civfix-infra`) | Transitional |

## Follow-ups in `@civfix/shared`

This change set is backend-only, so none of the items below are closed by it — they are the work the
backend cannot do alone. The list is complete on purpose: the review reserved every contract item for this
section, and two of them are user-visible dead ends. Paths are relative to
`civfix-shared/packages/shared/src/`; line numbers are as of 2026-07-25.

**Group 1 — hardening the server already enforces (contract change is defense in depth).**

- Narrow `WsClientMessageSchema`'s `send.kind` (`types/ws.ts:32`, today the full `ChatMessageKindSchema`) to the client-authorable subset (`text | share_pin | task_complete | rsvp_change`).
- Replace `.url()` with a scheme-checked refinement on `formUrl` — `PatchJurisdictionRequestSchema` / `SaveContactsRequestSchema` (`schemas/admin/jurisdictions.ts:27,187`), `SaveDraftRequestSchema` (`schemas/admin/discovery.ts:169`) and the citizen `schemas/map.ts:106`. `z.string().url()` accepts `javascript:`.
- Add `.max()` to `LogEventHoursRequestSchema.entries` (`schemas/volunteer.ts:74` — `.min(1)` with no ceiling) and `CreateCleanupRequestSchema.bring` + the update variant (`schemas/cleanups.ts:33,61`).

**Group 2 — contract gaps the server cannot close.** All eleven items the wave-2 worklist reserved for
reporting, plus the deletion-OTP purpose field and the media-CSRF declaration:

| # | Contract item | What it needs | What it costs today |
|---|---|---|---|
| F1 | `endpoints.logout` is `auth:"required"` (`client/endpoints.ts:419`) | `auth:"optional"` + idempotent semantics | A caller holding a dead/absent credential gets 401 and its cookies are never cleared. The handler is already idempotent; the contract — and `test/unit/auth-routes.test.ts:406` ("logout while unauthenticated is 401") — is what pins the 401 |
| F2 | `ListThreadsResponseSchema` advertises `nextCursor` (`schemas/chat.ts:83`) | **Nothing — closed server-side.** `ThreadsService.list` implements keyset paging and the route forwards the cursor verbatim | The legacy `listThreads(userId, limit)` form still returns `nextCursor: null`, but it is internal/test-only. Recorded so it is not re-raised |
| F3 | `ActivityListQuerySchema.filter` / `AdminListQuerySchema.sort` are free-form `z.string()` (`schemas/admin/activity.ts:37`, `schemas/admin/common.ts:30-36`) | Narrow to enums (`ActivityKind \| "all"`, `"newest" \| "oldest"`) | `q`/`filter`/`sort`/`cursor` are now really implemented (`services/admin/activity-service.ts`), but an unrecognised value silently degrades to `all` / `newest` instead of 422 — the console cannot tell a typo from an empty page |
| F4 | `QuietHoursSchema` is `{start,end}` with no timezone (`schemas/notifications.ts:59`) | A `tz` field (IANA name) + a `notification_prefs` migration + `Intl.DateTimeFormat` evaluation | Quiet hours are evaluated against the SERVER's offset (`services/notification-helpers.ts isWithinQuietHours`), so any user outside it gets bells inside their quiet window and silence outside it. There is **no safe server-side fix** — defining the wire format as UTC is the alternative, and it breaks twice a year |
| F5 | `FinalizeMediaResponseSchema.status` is `z.ZodLiteral<"validating">` (`schemas/media.ts:53`) | Widen to `MediaStatus` | **User-visible dead end.** A rejected upload answers `validating` from finalize (`services/media-intake-service.ts:285-292` documents the forced lie) and 404 from `GET /media/:id` (the H9 non-oracle control) — forever. The client can never distinguish "still scanning" from "rejected" and shows a spinner that never resolves |
| F6 | `InboundEmailDTOSchema` is `.strict()` with no truncation flag (`schemas/admin/inbox.ts:72`) | An additive `attachmentsTruncated` (or a count) | `routes/admin/inbox.routes.ts:91-99` slices to `MAX_INBOX_ATTACHMENTS = 50` and can only log a warn; the operator console shows 50 of N with no indication anything was elided |
| F7 | `Mailer.sendOtp(to, code)` has no locale slot (`interfaces/mailer.ts:40`) | An optional third `locale` parameter | Passcode emails DO localize today — `auth/otp.ts` passes `account?.locale` through a locally widened `LocaleAwareMailer` and `OciMailer.sendOtp` accepts it — but the shared type is why that widening exists at all |
| F8 | `Storage.presignGet(key, ttlSec)` has no `forceSigned` (`interfaces/storage.ts:40`) | A `forceSigned` option | `R2Storage.presignGet` returns the UNSIGNED CDN URL whenever `publicBase` is set. The media-worker fix was to stop passing `publicBase` — a wiring convention, not a structural guarantee, so the next construction site can re-introduce public URLs for private objects |
| F9 | `FakeInboundMail.extractThreadToken` still honors `X-Thread-Token` (`fakes/inbound-mail.fake.ts:80-86`) | Drop the header arm | The real adapter no longer honors it, so the **fake is more permissive than production**: a spoofable-header attack path passes in tests and fails in prod (or the reverse, for a regression test) |
| F10 | `ChatService.broadcast` takes no `excludeConnId` (`interfaces/chat-service.ts:33`; fake at `fakes/chat-service.fake.ts:49`), while `broadcastEvent` does | Add the same optional `opts` to `broadcast` | The WS path really does pass it — `ws/frame-handler.ts:374` calls `deps.chat.broadcast(roomKey, message, { excludeConnId: conn.id })` through a locally widened `GatewayChatService` (`ws/types.ts:179-183`). The shared fake silently drops the third argument, so the all-fakes dev path and every fake-backed test echo a message frame back to its own sender — behavior production does not have |
| F11 | `ModerationKindSchema` has no `video` member (`schemas/admin/common.ts:170`) | A new enum member + widening `0007_admin_phase2.sql`'s CHECK + a console label | Held **videos** are enqueued as `kind:"image"` with the real kind carried in the reason string (`media-worker/src/jobs/media-checks.ts:253-262` documents the limit and why it is not a one-line worker fix). Answers the worklist's open question: `"video"` is **not** an accepted value today |
| — | `EmailOtpRequestRequestSchema` has no `purpose` field | Add `purpose` (e.g. `signin \| account_deletion`) | The account-deletion OTP therefore shares the sign-in `otp:rl:email:` 60s cooldown and 429s a user who just signed in, on a GDPR erasure path (`auth/otp.ts:245-255`, `routes/users.routes.ts:210-213`). The server cannot namespace the key without knowing the caller's purpose |
| — | `createMediaUpload` / `finalizeMedia` declare `csrf: false` (`client/endpoints.ts:1344-1359`) | Flip both to `csrf: true` in the same release that re-adds the server-side gate | This is why the CSRF preHandler added to `/media/upload` and `/media/:id/finalize` had to be reverted (see the pre-push audit above): the published client never sends the header, so every signed-in web photo upload would 403. Server and contract must move together |

F9 and F10 are shipped *fakes*, not wire schemas, so they additionally bound what the backend's own suite
can prove: a test written against either one is asserting behavior production does not have.

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

---

# Operator runbook

Everything an operator has to do by hand, in order, plus the two infra facts and the local-verification recipe that the change set assumes. Read this together with "Operator actions required BEFORE the next deploy" above — that section covers env vars, this one covers schema, infra and verification.

## 1. Migrations, in this order, applied BEFORE the new images run

`src/db/migrate.ts` sorts `drizzle/*.sql` **lexically** and records applied files in `_civfix_migrations`; there is no journal file, so a filename alone enrolls a migration.

**CORRECTED 2026-09-04 — the production deploy runs this automatically.** The compose `migrate` one-shot (`civfix-infra` `compose/docker-compose.yml`) runs the command below on every deploy, and `seed`, `api` and `media-worker` all declare `depends_on: migrate: { condition: service_completed_successfully }`, so a migration failure aborts the release with the previous images still in place. The original text here said the deploy did not run migrations and that they had to be applied by hand; that was wrong. The manual invocation survives only as a re-run / recovery lever:

```sh
# on the box, as the civfix user, with DATABASE_URL exported (re-run only; the deploy already did this)
node dist/db/migrate.js        # == pnpm --filter @civfix/api db:migrate
```

`drizzle/` holds **158 files**, `0000_extensions.sql` … `0175_forward_template_settings.sql`. The nine rows
below are exactly what this change set adds — `0052`–`0060`, contiguous, no gaps — and everything from
`0000` through `0051_social_posts.sql` predates it. (`0060` arrived later than the rest, with the feed
redesign; it is listed here because this table is the single operator runbook. `0061`–`0064` arrived
later still, with the service-hours feature set, and have their own table in §1a below; `0065` and `0066`
are DATA migrations and have §1b and §1c to themselves. `0067`–`0095` arrived later still, with the
production-readiness fix change set, and have their own table in §1d below. `0105`–`0153` arrived
last, with the event host platform — organizations, ticketing, broadcasts and donations — and have their
own table in §1e below; the number ranges there are RESERVED per domain, so the gaps `0112`–`0114`,
`0121`–`0129`, `0138`–`0144` and `0154`–`0159` are deliberate and not missing files.) Both backfills live **inside** their own migration file
(`0058`'s `sessions.created_at`, `0059`'s follow counters; §2 and §6 below), so there is no separate
backfill step to remember: the three `db:backfill*` scripts in `services/api/package.json` (report
jurisdiction geoids, reference codes, ACS population) are boundary/ingest tooling and are not part of this
deploy.

| File | What it does | If skipped |
|---|---|---|
| `0052_cleanup_bans.sql` | attendee ban table (M17) | Re-join after removal stays possible; ban writes fail |
| `0053_volunteer_hours_audit.sql` | append-only hours journal (M21) | Hours upserts fail (the service writes the audit row in the same tx) |
| `0054_media_purpose_post.sql` | widens the `media_assets.purpose` CHECK to include `'post'` | **Every post-with-media insert fails** (23514); the missing enum value is what shipped the bug |
| `0055_posts_thread_root_idx.sql` | index on `posts.thread_root_id` | Slow cascades on post deletes only (no correctness impact) |
| `0056_abuse_flags_worker_open_unique.sql` | collapses duplicate OPEN worker abuse flags, then a partial unique index on `(subject_type, subject_id, reason) WHERE resolved_at IS NULL AND source='worker'` | **HARD DEPENDENCY of the new media-worker** — see below |
| `0057_media_reap_tombstones.sql` | `media_reap_tombstones`: R2 keys the orphan sweep failed to delete, retried by later sweeps | Orphan-sweep leaks are logged/reported but not retried (the pre-wave-2 behavior). One extra error per sweep; no data loss |
| `0058_sessions_created_at.sql` | backfills NULL `sessions.created_at` from `last_seen_at`, then `SET NOT NULL` (M3) | Every legacy NULL-`created_at` session keeps failing closed, i.e. one forced re-login each — see below |
| `0059_users_follow_counters.sql` | adds `users.follower_count` / `users.following_count` (`int NOT NULL DEFAULT 0`) and backfills both from `follows_people` | **Every people surface fails** (42703, undefined column): profiles, people search, the follower/following rosters, follow suggestions and every post author card read these columns — see below |
| `0060_moderation_subject_post.sql` | widens the `moderation_items.subject_type` CHECK to include `'post'`, so a reported feed post can be queued | **Every "Report post" fails** (23514): the row is rejected by the CHECK, the request 500s, and the post stays unreportable. Widening only — no existing row can violate it |

**0056 is order-critical in BOTH directions — apply it, then deploy the worker:**

- **New worker, migration missing:** `MediaWorkerRepo.insertAbuseFlag` now ends in `ON CONFLICT (subject_type, subject_id, reason) WHERE … DO NOTHING`. Postgres resolves the arbiter at plan time, so with no matching index every insert raises `42P10` ("no unique or exclusion constraint matching the ON CONFLICT specification"). That is the `persist` phase of `media.checks` → `MediaInfraError` → 5 retries → the job dies and the asset is stuck `validating`, which also leaves anonymous reports stuck `held`. This is the one wave-2 change that hard-fails against the old schema.
- **Old worker, migration applied:** a *retried* job re-inserting the same open flag now raises `23505` instead of quietly duplicating. Bounded (it only happens to a job whose persist already failed once) and it self-heals the moment the new image lands.

The migration is safe to apply on a live DB: the collapse `DELETE` only touches OPEN rows with `source='worker'` (admin/API flags are untouched — the discovery "start task" path inserts `('report', …, 'manual', 'api')` with no guard and must keep working), and the index is built inside the migration's transaction, so `abuse_flags` is briefly write-locked. Executed against a throwaway `postgis/postgis:16-3.4` (both files applied and re-applied in one transaction each, then the real `makeDrizzleMediaWorkerRepo` driven against them): the collapse removes timestamped *and* `NULL`-`created_at` duplicates while leaving resolved rows, `source='api'` duplicates and other reasons alone; `insertAbuseFlag`'s arbiter is inferred (the retry is a no-op, an `'api'` flag still duplicates freely, and a moderator-cleared flag can be re-raised); and the `media_reap_tombstones` round trip (record → bump → list-under-cap → clear) behaves as documented. The one other ON CONFLICT the worker uses — `enqueueHeldModerationItem` against `0038_moderation_open_unique.sql` — was checked by inspection only: same target columns, same `WHERE status = 'open'` predicate.

## 1a. Service-hours feature set (`0061`–`0064`)

A later change set than the `0052`–`0060` block above; listed here because this table is the single
operator runbook. All four are **additive-only** — `ADD COLUMN` (nullable, no default), `CREATE TABLE
IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. No rename, no drop, no narrowed CHECK, no `NOT NULL`
without a default, and **no backfill `UPDATE`** — so the old code keeps serving correctly against the new
schema and the order relative to the image is free.

| File | What it does | If skipped |
|---|---|---|
| `0061_users_show_volunteer_hours.sql` | adds `users.show_volunteer_hours boolean` — a **nullable tri-state**, deliberately not `NOT NULL DEFAULT true` (NULL = never chosen ⇒ aggregate visible, itemised ledger empty; TRUE = itemised opted in; FALSE = hidden) | The privacy toggle and both hours projections fail (42703, undefined column) |
| `0062_volunteer_hours_user_created_idx.sql` | index `volunteer_hours (user_id, created_at DESC, id DESC)` for the new keyset ledger reads | Correct but unindexed: every transcript page sorts the user's whole ledger |
| `0063_cleanup_slots.sql` | `cleanup_slots` + `cleanup_slot_claims` (P9 signup slots). The `(cleanup_id, user_id)` PK **is** the one-slot-per-person rule; the composite FK `(slot_id, cleanup_id)` makes cross-event claims structurally impossible | Every slot read/write fails (42P01, undefined table) |
| `0064_service_hours_certificates.sql` | `service_hours_certificates`: issued PDF transcripts, `code` = the public verification capability, plus the partial unique on `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL` that gives issue idempotency | Issue/list/revoke/verify all fail (42P01); without the partial unique specifically, a double-tap mints two documents |

## 1b. Report volunteer-hours void (`0065`)

Unlike every migration above, this one **changes data**, and it changes data that is PUBLIC: the
per-jurisdiction leaderboard, the "Total volunteer hours" number on every profile, and the ledger that
signed PDF service transcripts are built from.

| File | What it does | If skipped |
|---|---|---|
| `0065_void_report_volunteer_hours.sql` | (1) sets `voided_at` + an explanatory `note` on every `volunteer_hours` row with `source='report'`; (2) RECOMPUTES `user_jurisdiction_hours.total_hours` as the SUM of each `(user, jurisdiction)`'s non-voided ledger rows | The code stops crediting new report filings, but every historical 0.1h-per-filing credit stays on the public leaderboard, in every profile total and in every newly issued transcript's source ledger |

- **ORDER MATTERS, unlike `0061`–`0064`.** Ship the migration and the image **together**. If the migration
  lands while the old image is still serving, `createReport` mints fresh `source='report'` rows seconds
  after the void and the correction is silently undone.
- **Expect the public numbers to DROP.** Report filings were the only hours most users could accrue (event
  hours require a verified organizer/cohost to log them, and a host cannot self-credit), so most
  jurisdiction leaderboards go thin or empty and many profiles fall to 0. That is the correction.
- **The rollup recompute is AUTHORITATIVE**: any `total_hours` with no backing non-voided ledger row is
  erased. Safe because `logEventHours` is the only remaining writer of either table and there is no
  `source='manual'` writer anywhere — but if you have ever hand-run an `UPDATE user_jurisdiction_hours`,
  it will be lost. Re-applying is a no-op (statement 1 matches nothing; statement 2 is a pure recompute).
- **Statement 0 takes `LOCK TABLE volunteer_hours, user_jurisdiction_hours IN SHARE ROW EXCLUSIVE MODE`,
  and it is load-bearing.** The runner's transaction is READ COMMITTED, so without it the recompute's
  correlated `SUM` cannot see a ledger row a live `logEventHours` committed after the statement began, and
  the migration would overwrite that attendee's rollup with a total the new credit is missing from — a
  silent, permanent lost update (the rollup is maintained by delta and `0065` never re-runs). The lock
  makes concurrent writers queue instead; plain `SELECT`s are unaffected. **Keep the two tables in that
  order** — it matches the order `logEventHours` takes them, and reversing it can deadlock the migration
  mid-deploy. If the lock ever appears to hang, something is holding a long write transaction on those
  tables; find it rather than dropping the lock.
- **Already-issued certificates are NOT corrected and cannot be**: `service_hours_certificates` rows are
  immutable snapshots and `verify()` reports them verbatim. After applying, list any live certificate that
  itemised a report row (query below), revoke each one with
  `pnpm --filter @civfix/api db:certificate:revoke <code>` (add `--dry-run` first; it needs `DATABASE_URL`,
  plus `R2_*` if it should also delete the stored PDF), then notify the holder and let them re-issue —
  never hand-edit `snapshot`, `total_hours` or `document_sha256`.

  **Do not reach for the product's revoke endpoint.** `POST /service-hours/certificates/:code/revoke` is
  `requireAuth`-gated, scopes its UPDATE by the *session's* `user_id` and hardcodes the reason `holder`, so
  an operator cannot call it and, if they had the holder call it, `verify()` would publicly report that the
  *volunteer withdrew their own record* rather than that civfix corrected the ledger.
  `scripts/revoke-certificate.ts` is the operator seam: same repository call, reason `ledger_corrected`
  (or `issued_in_error`), plus the same best-effort R2 delete the holder path performs. It is idempotent —
  `revoked_reason = COALESCE(revoked_reason, …)` never rewrites an earlier revocation.

  ```sql
  SELECT id, code, user_id, issued_at, total_hours
  FROM service_hours_certificates
  WHERE revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot->'rows') r
      WHERE r->>'source' = 'report'
    );
  ```

  The window is small: `0064` shipped 2026-07-28.

## 1c. Post reply-count reconciliation (`0066`)

Like `0065`, this **changes data**: it rebuilds `posts.reply_count` from the actual direct replies. The
write path used to increment the counter only when `kind='reply'`, but `PostComposeInputSchema` defaults
`kind` to `'post'` and carries `replyToId` through regardless, so a `{body, replyToId}` post created a real
reply (non-null `reply_to_id`, returned by `listReplies`) that never bumped the parent — while the delete
path already decremented by `reply_to_id`. The code now keys the increment on `reply_to_id`, matching the
delete path and the reads; this migration repairs the rows that already drifted.

| File | What it does | If skipped |
|---|---|---|
| `0066_backfill_post_reply_counts.sql` | (1) sets `posts.reply_count` to the exact count of each post's non-deleted direct replies; (2) zeroes any leftover counter with no live direct reply | Every parent that received a `{body, replyToId}` reply keeps understating its reply count until it is next replied to or one of its replies is deleted |

- **Order does not matter and re-applying is a no-op.** It is a pure reconciliation: statement 1 only
  rewrites parents whose stored count already disagrees with their live children, statement 2 only touches
  posts carrying a stale non-zero counter. The old image keeps serving correctly against the corrected data.
- The recompute is viewer-independent (all non-deleted direct children), exactly like `like_count` /
  `save_count`; per-viewer block filtering stays a read concern and never enters the stored counter.

**No file in `drizzle/` may contain `BEGIN;` / `COMMIT;` / `ROLLBACK;`.** `src/db/migrate.ts:83-97` wraps
every file in its own transaction on a reserved connection, together with the `_civfix_migrations`
bookkeeping INSERT. A file that opens its own ends the runner's mid-flight: the bookkeeping row commits
separately, the runner's trailing `commit` only warns, and the catch branch's `rollback` becomes a no-op —
a half-applied file recorded as applied, with no error anywhere.
`test/unit/migrations-transaction-control.test.ts` asserts this over the real directory.

## 1d. Production-readiness fix change set (`0067`–`0095`)

The 29 migrations this change set adds, in lexical (apply) order. Several are **hard dependencies** of the
new images (a new column, table or constraint the code now reads or writes on every request); the rest are
index-only (a query path that gets slow, never wrong) or one-shot DATA recoveries. All forward-only and
idempotent on re-apply. The `CHECK`/`FK` pairs (`0072`+`0073`, `0076`+`0077`) add the constraint `NOT VALID`
first, then `VALIDATE` in a separate file so the validation scan never blocks writes on the hot table.

| File | What it does | If skipped |
|---|---|---|
| `0067_chat_partition_window.sql` | creates the current + next-two monthly partitions for the RANGE-partitioned `chat_messages` / `dm_messages` (F001) | **HARD** — once wall-clock passes the newest existing partition bound, every chat/DM insert fails (no partition for range); the worker cron keeps the window open thereafter |
| `0068_resolve_unscored_nsfw_flags.sql` | DATA recovery: resolves media abuse flags left `unscored` by the pre-fix pipeline (F076) | Assets stuck in the dead "unscored" state stay held/mis-flagged; no new damage, but the backlog never clears itself |
| `0069_posts_repost_unique_softdelete.sql` | makes unrepost a SOFT delete + partial unique on a live repost `(actor, original) WHERE deleted_at IS NULL` (F003/F148/F054) | **HARD** — repost/unrepost/re-repost double-counts or 500s on the unique the new code assumes |
| `0070_posts_reply_to_fk_idx.sql` | index on the `posts.reply_to_id` self-FK (F151) | Slow reply-cascade deletes only; no correctness impact |
| `0071_posts_toplevel_recent_idx.sql` | partial index for the top-level (replies-excluded) feed page (F013) | Home/public feed pages sequential-scan; slow, correct |
| `0072_posts_media_fk_swap.sql` | swaps the posts self-FKs and `media_assets→posts` FK to explicit `RESTRICT`/`SET NULL`, added `NOT VALID` (F148) | **HARD** — deletes cascade the wrong way (orphaned or over-deleted rows) versus what the new code expects |
| `0073_posts_media_fk_validate.sql` | `VALIDATE`s the four constraints `0072` added (F148) | The FKs stay unvalidated — enforced for new rows, but existing violations go undetected |
| `0074_repost_count_reconcile.sql` | DATA: recomputes `posts.repost_count` from live reposts (F054) | Denormalized repost counters keep any pre-fix drift until next mutated |
| `0075_media_chat_created_at.sql` | adds `media_assets.chat_created_at` (F072) | **HARD** — the chat/DM media-stamp path writes this column; absent → 42703 on those inserts |
| `0076_media_single_claim_check.sql` | `media_single_claim_chk`: an asset binds at most ONE subject, added `NOT VALID` (F017/F049) | **HARD** — the single-claim invariant the attach path relies on is unenforced; double-claims slip through |
| `0077_media_single_claim_validate.sql` | `VALIDATE`s `0076` (F017/F049) | Constraint enforced for new rows only; existing double-claims undetected |
| `0078_idempotency_owner_unique.sql` | partial unique on `(COALESCE(owner…), key)` for per-owner idempotency (F028) | **HARD** — with `0079`, the per-owner idempotency the new code assumes; a shared key collides across users |
| `0079_idempotency_drop_key_pk.sql` | drops the old key-ONLY primary key on `idempotency_keys` (F028) | **HARD** — the global key PK keeps two users' same idempotency key colliding |
| `0080_chat_group_bans.sql` | `chat_group_bans` table (F044) | **HARD** — the group ban/unban path reads/writes this table; absent → 42P01 |
| `0081_mail_messages_dedupe.sql` | DATA: collapses duplicate inbound `mail_messages` by Message-ID (F102) | Pre-existing inbound duplicates remain; `0082`'s unique index would fail to build until deduped |
| `0082_mail_messages_message_id_uk.sql` | unique on the RFC `Message-ID` so a re-delivered webhook can't double-insert (F102) | **HARD** — inbound-mail dedup relies on this; a retried webhook re-inserts a reply |
| `0083_jurisdiction_contacts_email_lower_idx.sql` | `lower(email)` index for case-insensitive contact/routing lookup (F111) | Reply routing and the contacts directory sequential-scan; slow |
| `0084_notifications_feed_idx.sql` | index for the notifications feed (inbox-surfaced kinds excluded) (F089) | Notification feed reads sequential-scan; slow |
| `0085_user_blocks_blocker_created_idx.sql` | `(blocker_id, created_at)` index for the paginated block list (F014) | `GET /me/blocks` sequential-scans the block table; slow |
| `0086_notification_prefs_tz.sql` | adds `notification_prefs.tz` for timezone-aware quiet hours (F086) | **HARD** — quiet-hours evaluation reads this column; absent → 42703 |
| `0087_media_finalized_at.sql` | adds `media_assets.finalized_at` for idempotent finalize (F071) | **HARD** — the finalize path stamps/guards on this column; absent → 42703 |
| `0088_reports_hold_release_checked_at.sql` | adds `reports.hold_release_checked_at` so the held-anon sweep can cursor forward (F019) | **HARD** — the release sweep updates this column; absent → 42703 and a stalled sweep |
| `0089_reports_reporter_created_idx.sql` | `(reporter_id, created_at)` index for "my reports" (F026) | The signed-in user's own-reports list sequential-scans; slow |
| `0090_chat_groups_avatar_media_idx.sql` | index on `chat_groups.avatar_media_id` FK (F002) | Slow avatar-media reference checks only; no correctness impact |
| `0091_report_claim_code_hash.sql` | adds `reports.claim_code_hash` (the claim secret stored hashed) (F150) | **HARD** — the claim path writes/verifies the hash; absent → 42703 |
| `0092_anon_tokens_claim_code_null.sql` | makes the dead plaintext `anon_tokens.claim_code` nullable so the code stops writing it (F150) | Insert of a new anon token with a non-null-constrained dead column fails once the code stops populating it |
| `0093_follows_people_pagination_idx.sql` | index for the outbound-follows ("following") pagination (F158) | The following list sequential-scans; slow |
| `0094_notifications_created_idx.sql` | bare `created_at` index backing the retention sweep's notifications lane (every other index on the table is `user_id`-leading) | The nightly sweep sequential-scans the whole notifications table once per page; slow, correct |
| `0095_media_stuck_sweep_rotation.sql` | `media_assets.stuck_checked_at` + `stuck_check_count` (rotation watermark + give-up counter for `media.stuck.sweep`, F087b, same pattern as `0088`), the partial index `media_assets_stuck_sweep_idx` serving that sweep's claim query, and a scoped backfill adopting BOUND rows still stuck at `validating` with no `finalized_at` (the set no sweep could reach) | The stuck sweep re-picks the same permanent residents every 15 min — genuinely stuck media starve behind them and hopeless rows are re-enqueued forever |
| `0102_users_last_activity.sql` | adds `users.last_activity_geom` + `users.last_activity_at` (audit H18): the materialized "most recent locatable public act" the bounded follow-suggestions candidate scan reads. Catalog-only `ADD COLUMN` (nullable, no default) on a hot table, so no rewrite. **Two follow-up steps, both post-deploy:** build `users_last_activity_gist` + `users_last_activity_at_idx` out of band with `CREATE INDEX CONCURRENTLY` (`docs/out-of-band-indexes.md`), then run `node dist/db/backfill-user-activity.js` | Suggestions still work but rank only on freshly-written activity, and without the indexes the candidate pools sequential-scan `users` |
| `0103_cleanups_completed_at.sql` | adds `cleanups.completed_at` (audit H9): the completion instant that bounds how many volunteer hours may be credited per attendee (`completed_at - scheduled_at` + 1 h grace, capped at `MAX_EVENT_HOURS`). Catalog-only `ADD COLUMN` (nullable, no default) on a small table; NO backfill by design, so events completed before it keep the old ceiling | Every completed event looks window-less, so hours fall back to the flat 24 h ceiling and the minimum-duration rule cannot be evaluated |
| `0104_conversation_hides.sql` | new `conversation_hides` table (per-user, per-conversation hide watermark behind the inbox row's "Delete"): composite PK `(user_id, room_kind, room_id)` + `hidden_at`, room_id deliberately un-FK'd exactly like `conversation_mutes` (0042). Brand-new empty table; no existing table touched, no index beyond the PK | `PUT /v1/conversations/hidden` 500s on a missing relation and the threads list stops filtering hidden rows |

### §1e. Event host platform (`0105`–`0153`)

One change set, four reserved ranges: organizations + event model `0105`–`0114`, ticketing and
registration `0115`–`0129`, communications and analytics `0130`–`0144`, donations `0145`–`0159`.
Every file is idempotent and carries the full lock order in its banner. `0115`–`0119` must apply
AFTER `0105`–`0114` (they read `cleanups` columns `0107` adds), and every payments table has a
foreign key into `organizations` from `0105`.

| File | What it does | If skipped |
|---|---|---|
| `0105_organizations.sql` | new `organizations` + `organization_members`: the host identity a person can act on behalf of. Partial unique **one owner per org**, slug unique among live rows, verification-queue index. Brand-new empty tables | Every `/v1/orgs*` endpoint 500s and the whole host capability model collapses to event roles |
| `0106_org_verifications.sql` | new `org_verifications`: write-only `ein_number` + `documents` jsonb, `ein_scrubbed_at`, partial unique one OPEN application per org | Organizations can never be verified, so no organization can ever take a donation |
| `0107_cleanups_host_columns.sql` | 13 host columns on `cleanups` (`ends_at`, `timezone`, `visibility`, `cover_media_id`, `gallery_media_ids`, `donation_url`, `page_slug`, registration window, `organization_id`, `reminder_offsets_min`, `host_reply_to`), 6 `NOT VALID` CHECKs and 5 indexes incl. a GIN on `gallery_media_ids`. Catalog-only `ADD COLUMN`s (nullable, no default) on a small table | Event visibility is unenforceable, the signup page has no slug, and every host write 500s on the missing columns |
| `0108_event_consents.sql` | new `event_consents`: the server-side artifact that a person accepted a named terms + disclosure version at registration. Never scrubbed, deleted only with its event | Registration cannot record consent — a compliance gap, not just a 500 |
| `0109_cleanup_team_invites.sql` | new `cleanup_team_invites`: hashed invite tokens, `invited_email` written only when the host typed an address, `email_scrubbed_at` for the 7-day scrub | Cohost / staff invitations 500 |
| `0110_media_purpose_event_expand.sql` | adds `media_assets_purpose_expanded` as a **NOT VALID** CHECK carrying the widened purpose set (`event_cover`, `event_gallery`, `org_logo`). Expand half of an expand/contract pair | Event covers, galleries and organization logos are refused by the old CHECK |
| `0111_media_purpose_drop_old_check.sql` | drops the narrow `media_assets_purpose_check` from `0054`. Contract half; must apply AFTER `0110` | The old CHECK still rejects every new purpose, so `0110` buys nothing |
| `0115_cleanup_ticket_types.sql` | new `cleanup_ticket_types`: free ticket types with the atomic `reserved_seats` capacity gate, the oversell-backstop CHECK, unique `(cleanup_id, lower(name))` and the composite-FK target `(id, cleanup_id)`. Brand-new empty table | Every ticket-type and registration endpoint 500s on a missing relation |
| `0116_cleanup_registrations.sql` | new `cleanup_registrations` + `cleanup_registration_seats`: one row per party and one per person, with the globally unique `ticket_token_hash`, the check-in pairing/exclusivity CHECKs and the retention partial indexes. Brand-new empty tables | Registration, ticket reads and the whole check-in surface 500 |
| `0117_cleanup_waitlist.sql` | new `cleanup_waitlist`: per-ticket-type FIFO queue whose offers RESERVE seats; FIFO + expiry partial indexes and one-live-entry-per-person partial uniques. Brand-new empty table | Waitlist endpoints 500 and `waitlist.promote` / `waitlist.expire.sweep` fail every run |
| `0118_cleanup_questions.sql` | new `cleanup_questions` + `cleanup_answers`: archive-never-delete question definitions and their answers, with the 30-day scrub partial index. Brand-new empty tables | Question endpoints 500; registration answers cannot be stored or scrubbed |
| `0119_cleanup_pages.sql` | new `cleanup_pages`: one signup page per event as a jsonb block document (≤24 blocks), theme accent, publish + operator-flag state and the `view_count` counter. Brand-new empty table | `/v1/pages/:slug` and the page builder 500 |
| `0120_cleanup_pages_admin_idx.sql` | expression index `cleanup_pages ((COALESCE(published_at, updated_at)) DESC, id DESC)` — `0119`'s two indexes are PARTIAL (`status = 'published'`, `flagged_at IS NOT NULL`), so neither can serve the operator queue, which deliberately spans every status | `GET /v1/admin/pages` full-scans and sorts `cleanup_pages` on every operator page |
| `0121_event_consents_registration_fk.sql` | adds the FK `0108` promised: `event_consents.registration_id` → `cleanup_registrations(id)` `ON DELETE SET NULL` (the consent record outlives the registration it was captured with). Constraint added and validated in one step on a brand-new empty table | A consent row can point at a registration id that no longer exists |
| `0122_cleanup_waitlist_user_idx.sql` | partial index `cleanup_waitlist (user_id, created_at DESC) WHERE user_id IS NOT NULL` — `0117` indexes the FIFO/expiry paths and the two ACTIVE-only partial uniques, none of which serve `leaveWaitlist` or the account-erasure release sweep | Leaving a waitlist and the erasure sweep scan every waitlist row on the platform |
| `0123_cleanup_page_media.sql` | new `cleanup_page_media (cleanup_id, media_id)`: the explicit binding between an event and the images its signup page embeds. `cleanup_pages.blocks` is jsonb, so before this table an image referenced only from a block was indistinguishable from an abandoned upload and the media-worker orphan sweep deleted it (row + R2 objects) six hours after upload. Brand-new empty table, both FKs `ON DELETE CASCADE` | Every page-block image is reaped by the hourly `orphan.sweep`, and `savePage` rejects any block image that is not already the event cover |
| `0130_broadcasts.sql` | new `broadcasts`, `broadcast_deliveries`, `cleanup_broadcast_mutes`: the host-messaging relay, its per-recipient delivery ledger and the per-event mute. Brand-new empty tables | Every broadcast endpoint 500s and the `broadcast.*` jobs fail every run |
| `0131_broadcast_optouts.sql` | new `broadcast_unsubscribes` + `email_suppressions`: the one-click unsubscribe record and the hard-bounce/complaint suppression list, both kept indefinitely by design | One-click unsubscribe 500s — an unsubscribable mail stream is a CAN-SPAM problem, not just an outage |
| `0132_event_metrics_daily.sql` | new `event_metrics_daily`: the per-event daily aggregate every analytics envelope reads. No identifier of any kind | Host analytics return nothing and `event.metrics.rollup` fails every hour |
| `0133_host_exports.sql` | new `host_exports`: queued/ready/expired roster, answer, check-in and donation exports, scoped to a cleanup OR an organization | Export requests 500 and `host.export` / `host.export.reap` fail |
| `0134_host_messaging_switches.sql` | adds `user_moderation.host_messaging_suspended` (+ partial index) and `notification_prefs.host_broadcasts`. Catalog-only `ADD COLUMN`s | The operator kill switch has nowhere to write and a person cannot opt out of host broadcasts |
| `0135_cleanups_reminder_sweep_idx.sql` | `cleanups_reminder_sweep_idx (scheduled_at) WHERE status = 'upcoming'`, the predicate the 10-minute reminder sweep runs | The reminder sweep sequential-scans `cleanups` every 10 minutes |
| `0136_monitoring_grants.sql` | role-guarded GRANTs for the `monitoring` role (`DO $$ … IF EXISTS pg_roles`), with `broadcasts` granted at COLUMN level so the exporter can never read a subject or a body. No-op where the role does not exist (staging, local, testcontainers) | The postgres-exporter's host-platform gauges return permission errors; nothing else breaks |
| `0137_host_exports_org_idx.sql` | partial index `host_exports (organization_id, requested_at DESC, id DESC) WHERE organization_id IS NOT NULL` — `0133` indexed only `cleanup_id` and `requested_by`, and the `donations` kind is org-scoped with `cleanup_id IS NULL` | `GET /v1/orgs/:id/donations/exports` scans every export on the platform and sorts |
| `0145_org_stripe_accounts.sql` | new `org_stripe_accounts`: the connected account behind an organization, `organizations` RESTRICT so an account can never be orphaned | Stripe onboarding 500s |
| `0146_org_donation_settings.sql` | new `org_donation_settings` + `org_donation_agreement_changes`: the organization's donation configuration and the versioned §318 agreement acceptances | Donation settings 500 and no agreement acceptance can be recorded |
| `0147_org_eligibility.sql` | new `org_eligibility`, `org_eligibility_checks` (**append-only** evidence rows with per-row `retention_until`) and `eligibility_source_revisions` | Eligibility can never be evaluated, so every organization stays `unknown` and donations stay off |
| `0148_donations.sql` | new `donations`: the ledger. Amounts, fees, net, status, dispute state, pseudonymous `donor_key`, `profile_unlinked_at`, UNIQUE `(idempotency_owner, idempotency_key)`. Brand-new empty table | Checkout 500s; no charge can be recorded |
| `0149_donation_refunds_disputes.sql` | new `donation_refunds` + `donation_disputes` | Refund and dispute webhooks cannot be recorded, so totals silently drift |
| `0150_stripe_events.sql` | new `stripe_events`: the webhook inbox that makes processing idempotent and replay-safe, deleted at `received_at + 400d` | Every webhook is processed on every retry; double fulfillment |
| `0151_legal_documents_consents.sql` | new `legal_documents` (SEEDED from `@civfix/shared/legal`) + `consent_records`. The seed is asserted by `test/unit/payments/legal-seed.test.ts`, so it fails loudly on drift | `getLegalVersions` serves nothing and no consent can cite the exact text accepted |
| `0152_donation_reconciliation_runs.sql` | new `donation_reconciliation_runs`: the nightly ledger-vs-Stripe comparison whose `divergences` count drives a page-immediately alert | `payments.reconcile` fails every night and a money divergence goes unnoticed |
| `0153_payments_monitoring_grant.sql` | role-guarded, COLUMN-level GRANTs for the `monitoring` role over the payments tables. No-op where the role does not exist | The payments gauges return permission errors; nothing else breaks |
| `0154_donations_user_created_idx.sql` | adds `donations_user_created_idx` so the donor "my donations" list can page on `(created_at, id)`: a failed or expired checkout has a NULL `charged_at`, and the old `(charged_at, id)` keyset silently truncated every page after such a row. Index only, brand-new empty table | `GET /v1/me/donations` still answers, on a sequential scan |
| `0156_org_eligibility_ein_provenance.sql` | adds `ein_source` (CHECK `org_verification`/`operator`), `ein_set_at`, `ein_set_by` to `org_eligibility`: where the EIN an organization is screened under came from, written when an operator approves a nonprofit verification or corrects the EIN. `ADD COLUMN IF NOT EXISTS` only, no data rewrite, brand-new empty table | The verification-approval bootstrap and the admin set-EIN action fail on an undefined column, so no organization can be screened |
| `0157_delivery_suppression_cancelled.sql` | rewrites `broadcast_deliveries_suppression_reason_check` to add `'cancelled'`, so a host cancelling their own broadcast no longer records the remaining rows as the platform's `'kill_switch'` verdict. Table is empty at this point in the change set | Host cancel raises a CHECK violation and the remaining delivery rows stay `pending` forever |
| `0158_broadcasts_cancellation_uidx.sql` | adds the partial unique index `broadcasts_cancellation_uidx (cleanup_id) WHERE kind = 'event_cancelled'`, the cancellation twin of `broadcasts_reminder_uidx`. The cancel fan-out job deliberately rethrows when an SMS guest cannot be reached, so pg-boss redelivers it; without this index the lane created a SECOND `event_cancelled` broadcast and every registrant was mailed the cancellation twice. The lane now inserts `ON CONFLICT DO NOTHING`. Index only, table empty at this point in the change set | A retried cancel fan-out mails the cancellation twice |
| `0159_host_exports_run_token.sql` | adds `host_exports.run_token`, stamped by every `claimForRun` and required by `markReady`. An export run that outlives its job visibility timeout is redelivered, the retry reclaims the stale row, and whichever run finished last used to overwrite `r2_key` - orphaning the other run's object in the bucket permanently, since reaping reads `r2_key` from the row. The losing run now writes nothing and deletes the object it uploaded. `ADD COLUMN IF NOT EXISTS`, no rewrite, table empty at this point in the change set | A slow export plus its retry leaves an unreferenced, never-reaped CSV in R2 |
| `0160_donation_refunds_failed_after.sql` | rewrites `donation_refunds_app_fee_refund_state_check` to add `'failed_after'`: the terminal state for a refund whose proportional application fee civfix already returned and which Stripe then marked `failed`. Stripe cannot un-refund an application fee, so the row is flagged and alerted on rather than retried. Table is empty at this point in the change set | The refund sweep raises a CHECK violation whenever a pending refund later fails, and the fee discrepancy is never surfaced |
| `0161_org_stripe_accounts_reconnect.sql` | adds `reconnect_attempts` and `previous_stripe_account_ids` to `org_stripe_accounts`: the attempt counter that gives each reconnect its own Stripe idempotency key (`acct:<org>:v2:<n>`) and the audit trail of accounts an organization has been relinked away from. `ADD COLUMN IF NOT EXISTS` with catalog defaults, no rewrite | Connecting a payout account after a deauthorization fails on an undefined column, so a deauthorized organization stays a dead end |
| `0162_org_suspension_and_invites.sql` | adds `organizations.suspended_at` / `suspended_reason` / `suspended_by` (the reversible operator suspension flag behind `adminSetOrgSuspended`, independent of `verified_status` and `deleted_at`) and creates `organization_invites`: the pending record behind an email invite to an address with no account, storing only the SHA-256 of the single-use accept token, with a partial unique `(organization_id, email) WHERE status = 'pending'`. Three nullable column adds, no rewrite; brand-new empty table | Every `/admin/orgs` list/suspend read fails on an undefined column, and an email invite to a non-user is still the silent no-op it was in 0.40.0 |
| `0163_event_team_tiers.sql` | widens the `cleanup_team_invites` role CHECK to `('cohost','staff','coordinator')` and the status CHECK to include `'declined'`, adds the partial index `cleanup_team_invites_invitee_pending_idx (invited_user_id, created_at DESC, id DESC) WHERE status = 'pending' AND invited_user_id IS NOT NULL` that backs `GET /me/event-invites`, and re-COMMENTs `cleanup_members.role` with the widened value set. Two named DROP/ADD constraint pairs plus one index on a small cold table; no rewrite, no backfill | Inviting a `coordinator` raises a CHECK violation, declining an invite raises another, and the invitee inbox seq-scans every invite in the table |
| `0164_org_affiliation.sql` | adds `users.primary_organization_id` (nullable, FK to `organizations` added **NOT VALID**, `ON DELETE SET NULL`) - the pin that chooses which membership shows as a person's affiliation badge - and `posts.organization_id` (nullable, FK added **NOT VALID** too, `ON DELETE SET NULL`) with the partial index `posts_organization_created_idx (organization_id, created_at DESC) WHERE organization_id IS NOT NULL AND deleted_at IS NULL`. Two catalog-only nullable column adds (PG11+ , no rewrite); `posts` is not a hot table so its index builds inline | "Post as organization" writes to an undefined column, the settings write that pins an affiliation 500s, and the affiliation read joins a column that is not there |
| `0165_org_invite_declined.sql` | widens the `organization_invites` status CHECK to include `'declined'` and adds the partial indexes `organization_invites_invitee_pending_idx (user_id, created_at DESC, id DESC) WHERE status = 'pending' AND user_id IS NOT NULL` and `organization_invites_invitee_email_pending_idx (email, created_at DESC, id DESC) WHERE status = 'pending' AND email IS NOT NULL` that back the two branches of `GET /me/org-invites` (an invite names an account or carries a verified address). One named DROP/ADD constraint pair plus two indexes on a small cold table; no rewrite, no backfill. The paired `org_invite` notification type needs no DDL - `notifications.type` has no DB CHECK by convention | Declining an org invite raises a CHECK violation and the invitee inbox seq-scans every invite in the table |
| `0166_org_payouts.sql` | creates `org_payouts`, the audit mirror of the Stripe Payout objects on an organization's connected account (0.43.0, DECISIONS §34). `bigint` minor units + `char(3) CHECK 'USD'` like `donations`, a status CHECK over `('pending','in_transit','paid','failed','canceled')`, `organization_id` RESTRICT, `requested_by` nullable SET NULL (a payout made from the org's own Stripe dashboard arrives only through the `payout.*` connect webhook and has no civfix actor), a partial unique on `stripe_payout_id` and a partial unique on `(organization_id, idempotency_key)` that is what makes a retried payout replay instead of paying twice. Brand-new empty table; no existing table touched | `GET /v1/orgs/:id/payments/balance` and both payout routes 500 on a missing relation, and every `payout.*` connect webhook dead-letters |
| `0167_cleanup_slot_windows.sql` | adds `cleanup_slots.starts_at` / `ends_at` (issue #109, contract 0.45.0): the optional time window a signup slot occupies inside its event, with both columns NULL meaning a role that spans the whole event - which every slot written before this migration is. `cleanup_slots_window_chk` enforces both-or-neither and `ends_at > starts_at`; "inside the event's own window" is cross-table and stays a service check (`cleanup-service` `toDesiredSlots`). Uniqueness moves from `cleanup_slots_cleanup_title_uidx` to `cleanup_slots_cleanup_title_window_uidx (cleanup_id, lower(title), COALESCE(starts_at, '-infinity'), COALESCE(ends_at, 'infinity'))`, so two same-titled shifts at different times coexist while two untimed ones are still rejected. Two catalog-only nullable column adds (no rewrite), one CHECK, one index swap; `cleanup_slots` is not a hot table (`docs/out-of-band-indexes.md`), so the index builds inline. Requires `0063_cleanup_slots.sql` | Every slot read selects the two missing columns, so `GET /v1/cleanups/:id` and the whole host slot surface 500 with `column s.starts_at does not exist` - event detail and the host console render "Event unavailable" - and no shift can be created or claimed |
| `0168_cleanups_ends_at_required.sql` | makes `cleanups.ends_at` **NOT NULL** (0.46.0, DECISIONS §40/§41): the public event status is now DERIVED on read from `scheduled_at`/`ends_at` (`active` = start <= now < end, `done` = now >= end) and `cancelled` is the only stored decision, so every list filter, the portfolio split, the hours cap and the no-show sweep range-scan `ends_at` against `now()`. Rows that never had an end are backfilled with `scheduled_at + interval '4 hours'` (the client's `DEFAULT_EVENT_DURATION_MS`, the same default `createCleanup` now applies) - the UPDATE touches ONLY `ends_at IS NULL` rows and never overwrites a host's own value. Adds `cleanups_ends_at_idx (ends_at)`, and replaces 0135's `cleanups_reminder_sweep_idx ... WHERE status = 'upcoming'` with `cleanups_reminder_sweep_v2_idx ... WHERE status <> 'cancelled'` because `'upcoming'` is no longer the only live stored value (a legacy `'active'` row with a future `scheduled_at` was silently skipped by the old index AND the old sweep predicate). Backfill + `SET NOT NULL` (validate only, no rewrite) + two non-CONCURRENT builds in one transaction: `cleanups` is small and cold by the standards of the hot set, the same justification 0135 made. `cleanups_ends_after_start_chk` and `cleanups_status_idx` both stay | `createCleanup` inserts a non-null `ends_at` the column still accepts, so writes survive - but every read that derives status compares against a NULL and the whole event plane reads `upcoming`: nothing ever becomes `done`, the Past lists empty out, `POST /v1/cleanups/:id/hours` refuses every event as "not ended", and the no-show sweep marks nobody |
| `0169_default_event_slot.sql` | DATA backfill, no DDL (the Drizzle mirror is unchanged): gives every OPEN event a default signup slot so the slot-first event page has something to sign up to. For each `cleanups` row with `status <> 'cancelled' AND ends_at > now()` and no rows in `cleanup_slots`, inserts ONE untimed slot - `title 'General volunteers'`, `description NULL`, `capacity` copied from `cleanups.capacity` (mapped to NULL when a legacy row holds a non-positive value, which `cleanup_slots_capacity_positive` would reject), `sort_order 0`, `starts_at`/`ends_at` NULL - and, off that INSERT's RETURNING in the same data-modifying CTE, a `cleanup_slot_claims` row for every existing `cleanup_members` row on those events, `ON CONFLICT (cleanup_id, user_id) DO NOTHING`, so `going` and "holds a claim" agree from day one. Ended and cancelled events are SKIPPED on purpose: `cleanup-service` already refuses every slot edit once an event has ended because credited volunteer hours were attested against exactly that roster, and a backfill is a slot edit like any other - those events keep `slots: []` and the clients keep a slot-less rendering for them. The untimed row's key under 0167's `cleanup_slots_cleanup_title_window_uidx (cleanup_id, lower(title), COALESCE(starts_at, '-infinity'), COALESCE(ends_at, 'infinity'))` collapses to `(cleanup_id, 'general volunteers', -inf, inf)`, and the NOT EXISTS guard means the event had no slot to collide with. Idempotent by construction - on a re-run the CTE selects no event and the outer INSERT writes nothing. Bounded by the count of open events; `cleanup_slots` and `cleanup_slot_claims` are cold tables, so one transaction is fine and no index is built | Every legacy open event stays slot-less while the clients render the board as the only way to sign up, so those events become un-joinable: no slot to claim, the roster shows nobody, and the broadcast `slots` segment reaches none of their existing members |

| `0170_donation_links.sql` | adds `organizations.donation_url` and `users.donation_url`, both nullable `text` with a `LIKE 'https://%'` CHECK added NOT VALID, copying `0107`'s `cleanups_donation_url_https_chk` exactly. The platform stopped processing donations in this change set, so a donation link is now only an outbound pointer, and the three subjects people ask on behalf of - an event, an organization, a person - each carry one. Two catalog-only column adds and two NOT VALID constraints: no table rewrite and no scan, which matters because `users` is a hot table. Every row that existed before this file has NULL in both columns, so both constraints hold by construction and every later write is checked. Leaves `VALIDATE CONSTRAINT` for a later out-of-band run (named in the file header). Does NOT touch the donation, payout, eligibility or stripe tables: their code paths are gone, their rows are financial records the organization keeps | An org or a person who saves a donation link gets `column "donation_url" does not exist` - `PATCH /v1/orgs/:id` and `PATCH /v1/me/profile` 500 on every save, not only the ones carrying a link, because the UPDATE names the column unconditionally once the patch includes it; the org page and the profile also 500 on read, since both SELECTs list the column |

| `0171_legal_documents_2026_09_16.sql` | DATA only, no DDL (the Drizzle mirror is unchanged): INSERTs the four `2026-09-16` `legal_documents` rows - `terms`, `privacy`, `cookies`, `subprocessors` - mirroring `LEGAL_DOCUMENTS` in `@civfix/shared` 0.48.1 byte for byte. Removing platform-processed donations rewrote all four public documents (payment/refund/application-fee sections out of the terms, Stripe out of the privacy notice and the subprocessor list, checkout entries out of the cookie notice), and different text is a different document, so each gets a new version and a new sha256 and every person is asked to accept again. `ON CONFLICT (type, version) DO NOTHING`, so a re-run writes nothing. The `2026-09-06` rows are left in place exactly as 0151's header requires - publishing is an INSERT, never an UPDATE, because `consent_records_document_fk` points every consent already collected at them - and the three retired types (`donations`, `org_donation_agreement`, `donation_disclosure`) are deliberately not re-versioned: nothing renders them any more and the type CHECK still accepts their existing rows. Four rows into a cold table: no index build, no lock of consequence | Registration and onboarding 500 on every consent: `assertConsentVersionsCurrent` demands `2026-09-16` from the shared package, the client sends it, and the `consent_records` INSERT then violates `consent_records_document_fk` because no `legal_documents` row carries that version. Nobody can create an account on the new image |
| `0172_legal_documents_2026_09_21.sql` | DATA only, no DDL (the Drizzle mirror is unchanged): INSERTs the `2026-09-21` `terms` and `privacy` `legal_documents` rows, mirroring `LEGAL_DOCUMENTS` in `@civfix/shared` 0.48.2 byte for byte. The Terms now state that the civfix software is AGPL-3.0 free software (section 11 replaced the proprietary-software clause) and both documents name the operator by its legal name, Reach Out Los Angeles Inc.; different text is a different document, so each gets a new version and a new sha256. `cookies` and `subprocessors` did not change and keep `2026-09-16`. `ON CONFLICT (type, version) DO NOTHING`, so a re-run writes nothing; the `2026-09-16` rows stay because `consent_records_document_fk` points existing consents at them. Two rows into a cold table: no index build, no lock of consequence | Event registration and host signup 500 on every consent: `assertConsentVersionsCurrent` demands `2026-09-21` from the shared package, the client sends it, and the `consent_records` INSERT then violates `consent_records_document_fk` because no `legal_documents` row carries that version |
| `0173_reports_status_check.sql` | adds `reports_status_chk`, a CHECK pinning `reports.status` to the seven contract values (`submitted`, `held`, `published`, `acknowledged`, `in_progress`, `resolved`, `rejected`), added **NOT VALID** because `reports` is a hot table (`docs/out-of-band-indexes.md`) and the runner is one-transaction-per-file: NOT VALID takes its lock briefly and still enforces the set on every later INSERT/UPDATE, while the existing rows are already inside it (the enum has not moved since contract 0.20.0). The transition GRAPH stays in code - the shared `canTransitionReportStatus`, enforced by `admin-report-service.setStatus` - because only the service knows the actor and the reason. `ALTER TABLE reports VALIDATE CONSTRAINT reports_status_chk;` is an OPTIONAL out-of-band step, named in the file header, never a deploy step | Nothing breaks and nothing 500s: the column keeps accepting any text, so a future writer with a typo'd status can park a report on a value the admin buckets, the map filter and the timeline icon mapper all silently drop |
| `0174_mail_messages_outbound_snapshot.sql` | adds `mail_messages.html` and `mail_messages.kind`, both nullable `text`, with `ADD COLUMN IF NOT EXISTS` and nothing else: no CHECK, no index, no backfill, so it is catalog-only on a cold table and takes no scan. `html` stores the exact HTML part handed to the mailer so a resend replays the message the city actually received instead of a bare-text, 64KB-truncated copy; `kind` records what an outbound row is (`packet` | `discussion` | `followup` | `digest` | `compose` | `reply` | `resend`) and is NULL on every inbound row and on every row written before this file. No CHECK is deliberate and matches the other free-text discriminators on this table: a value the code stops writing must never turn an old row un-readable. The operator send gate reads `COALESCE(kind, 'packet') = 'packet'`: a NULL kind — every row written before this file — counts AS a packet, deliberately, so every report routed before the deploy keeps its "already routed" gate, while a citizen's `@city` discussion forward (written as `discussion`) stops counting as one | Routing a report 500s on `column "html" does not exist` — the outbound INSERT names both columns unconditionally — so Approve & send, operator replies, resends and the outreach digest all fail; the packet gate itself still refuses correctly, because a missing `kind` column errors before it can misread |
| `0175_forward_template_settings.sql` | new `forward_template_settings`, the singleton row (`id smallint PRIMARY KEY CHECK (id = 1)`) holding the platform-wide default forwarding email template. It sits between a jurisdiction's own `forward_*_template` (0050) and the built-in default in `@civfix/shared`, so a packet resolves jurisdiction → this row → built-in. Both template columns are nullable (NULL = fall through) and `updated_by` is deliberately not a FK to `users`, since the authoritative trail is the `mail.forward_template_set` audit row written in the same transaction. `CREATE TABLE IF NOT EXISTS` on a table with no rows: no lock of consequence | The operator Mail page 500s on its default-template read and save (`relation "forward_template_settings" does not exist`), and every report forwarded to a jurisdiction without its own template 500s too, because the packet builder reads the row before it renders |

**Deferred to the NEXT release** (expand/contract, `docs/migrations-expand-contract.md`): 0.43.0
stops every code path from reading `user_verification` but does NOT drop it — a `DROP TABLE` in the
same release would make the previous api color raise `relation does not exist` on the feed, the
roster, the profile and the admin Users page for the whole migrate-to-cutover window, and for good
after a `CIVFIX_REF=<sha>` rollback. Once the 0.43.0 image is running everywhere, ship
`DROP TABLE IF EXISTS user_verification` as its own migration, and run the inventory query below in
EVERY environment first (expected: zero rows — the in-app application flow that wrote `documents`
was removed long ago, and after the DROP the object keys are unrecoverable):

```sql
SELECT m.id, m.r2_key, m.served_key, m.thumb_key
FROM media_assets m
WHERE m.purpose = 'verification'
  AND m.id IN (
    SELECT (doc->>'mediaId')::uuid
    FROM user_verification uv, jsonb_array_elements(uv.documents) AS doc
    WHERE doc->>'mediaId' IS NOT NULL
  );
```

Any rows it returns are identity documents: delete the objects from R2 and the rows from
`media_assets` by hand before the drop ships. `media_assets.purpose = 'verification'` itself STAYS
either way — `org_verifications` documents are claimed with it.

**Deferred to a later release, out of band** (record them in the expand/contract ledger): the six
`NOT VALID` CHECKs `0107` adds on `cleanups` and `0110`'s `media_assets_purpose_expanded` still need
`ALTER TABLE … VALIDATE CONSTRAINT`, and so do `0164`'s
`users_primary_organization_fk` and `posts_organization_fk`. They are correct as `NOT VALID` — the
constraint is enforced for every new row — and validating takes a scan that does not belong in a
deploy transaction.
| `0096_cleanup_guests.sql` | guest event RSVP (contract 0.38.0): `cleanup_guests` (event-scoped, contact-bearing attendance rows; SHA-256 manage-token hash only; partial unique on the active `(cleanup_id, contact_key)`), `guest_otps` (event-scoped one-time codes, hash only), `sms_opt_outs` (STOP suppression list, kept indefinitely). Three brand-new empty tables; no existing table touched | `POST /v1/cleanups/:id/guest-rsvp/*` and `GET /v1/cleanups/:id/guests` 500 on a missing relation, and `going` cannot include guests |
| `0097_media_assets_served_key.sql` | adds `media_assets.served_key` (audit C1): the worker-owned key the processed object is published to, so the client-writable upload key is never served after `ready`. Catalog-only nullable `ADD COLUMN` on a hot table. **Post-deploy:** run `node dist/db/backfill-served-key.js` immediately and again ~20 min later; pre-existing `ready` media reads as not-found until it completes | Every existing photo 404s until the backfill runs; new uploads work |
| `0098_sweep_predicate_indexes.sql` | idempotent guard that warns while `media_assets_orphan_sweep_idx` is missing (hot table; build it out of band with `CREATE INDEX CONCURRENTLY`, see `docs/out-of-band-indexes.md`) plus two small inline `email_otps` indexes (`expires_at`, partial `consumed_at`) backing the OTP retention lane (audit H13/M) | Both sweeps sequential-scan; correctness unaffected |
| `0100_mail_messages_affiliation_effects.sql` | adds `mail_messages.unaffiliated` (sender domain not aligned with the thread's jurisdiction contact; such messages drive no public side effects, audit H5) and `mail_messages.effects_applied_at` + partial pending index (idempotent re-drive of inbound side effects by the sweep, audit M). Small operator-plane table | Inbound mail processing 500s on the missing columns; operator inbox unusable |
| `0101_inbound_emails_archived_at.sql` | adds `inbound_emails.archived_at` (backfilled from `received_at` for rows already archived) + partial index; drives the 180-days-after-archive retention lane (audit H10) | Archive transitions 500 and the retention lane never deletes anything |

## 2. `sessions.created_at` backfill (`0058`, shipped in wave 3)

`sessions.created_at` was nullable (`0001_core.sql` declares it `timestamptz DEFAULT now()` with no `NOT NULL`, so rows predating the column read back NULL) and the absolute 90-day session ceiling is measured FROM it. `PgSessionStore.findById` reads a NULL as the **epoch** — i.e. already past the ceiling, fail closed — because the old `last_seen_at` fallback made the ceiling unreachable (every sliding-expiry write bumped `last_seen_at`, so an active legacy session never expired: the unbounded-sliding hole M3 closes).

Consequence until the backfill is applied: **every session row with a NULL `created_at` forces exactly one re-login.** Expected and harmless, but it is the reason for a login spike right after deploy.

`drizzle/0058_sessions_created_at.sql` closes it:

```sql
UPDATE sessions
   SET created_at = COALESCE(created_at, last_seen_at, now())
 WHERE created_at IS NULL;

ALTER TABLE sessions ALTER COLUMN created_at SET NOT NULL;
```

Operator notes:

- **Order is load-bearing and already baked into the file:** `SET NOT NULL` before the `UPDATE` aborts with `23502` on the first legacy row and rolls the file back. `last_seen_at` is itself `NOT NULL DEFAULT now()`, so the `now()` arm is unreachable belt-and-braces, and `last_seen_at` is a LATE (never early) estimate of creation — the ceiling it yields is generous to the holder by at most one sliding window.
- **It briefly write-locks `sessions`.** `SET NOT NULL` takes `ACCESS EXCLUSIVE` and, with no pre-validated `CHECK` to reuse, scans the table to prove no NULLs remain; logins and sliding-expiry writes block for that scan. Fine at this table's size (self-pruning via the ceiling + the expiry sweep); if that changes, add a `NOT VALID` CHECK and `VALIDATE` it out-of-band first.
- Re-applying is a no-op: the `UPDATE` matches nothing and `SET NOT NULL` on an already-`NOT NULL` column succeeds silently.
- Nothing hard-depends on it (unlike `0056`), so the deploy order is free — the only cost of skipping it is the recurring re-login above.
- The `?? new Date(0)` fallback in `src/auth/pg-stores.ts` is **deliberately kept** even though the Drizzle mirror (`src/db/schema/sessions.ts`) now types `createdAt` as non-nullable: it fails closed against any row the backfill has not reached, and the blue/green overlap means the PREVIOUS image serves briefly against the new schema on every deploy. Its comment says so.

## 3. media-worker `stop_grace_period` (civfix-infra, different repo)

`MEDIA_JOB_TIMEOUT_MS` (default 60s) is charged **per phase**, not per job: `jobs/media-checks.ts` wraps the download in one budget and `processMedia` in a second, so one job can legitimately run ~2x it before the persist writes. The worker therefore derives its graceful-stop timeout as `2 x jobTimeoutMs + 5s` (`stopGraceMsFor` in `services/media-worker/src/jobs.ts`) = **125s at the default**, and passes it to `boss.stop({ graceful: true, wait: true, timeout })`.

**The container's `stop_grace_period` in the civfix-infra compose file must exceed that** — set it to ~150s for the media-worker service. Docker's default is 10s, so without this the runtime SIGKILLs the process mid-job and the derivation buys nothing: the asset is left `validating` until a sweep reconciles it. Raising `MEDIA_JOB_TIMEOUT_MS` raises this requirement with it (`.env.example` says so at the knob).

## 4. Boundary refresh prunes only federal/tribal fixtures

`services/api/scripts/refresh-boundaries.ts` → `pruneNonAuthoritative()` deletes legacy dev-seed rows by geoid prefix, and **only for the federal and tribal layers** (`layer='federal' AND geoid NOT LIKE 'PADUS-%'`, `layer='tribal' AND geoid NOT LIKE 'AIANNH-%'`). There is deliberately **no equivalent for stale place / county / state rows**, because those layers use real TIGER geoids that the refresh re-upserts — nothing distinguishes a stale fixture from a live row, and nothing prunes them.

Two consequences to keep in mind:

- A place/county/state row that stops existing upstream (a dissolved municipality, a re-coded place) stays in `jurisdictions` forever with its contacts attached. Removing one is a manual, FK-aware operation modelled on `pruneNonAuthoritative`.
- It is why the dev-seed fix clears **placeholder contact emails** instead of using fake geoids: the seed genuinely upserts real geoids (`06`, `06037`, `0644000`), so the geoids must stay, and clearing `example.*` addresses on conflict also heals rows already damaged in an environment that was seeded over.

## 5. Running the Docker-gated integration suites locally (macOS / Apple silicon)

~350 of the suite's tests are `withPg()`-gated and skip without a Docker daemon. On this machine the daemon is colima (`aarch64`, 4 CPU / 6 GiB, `vz` + virtiofs, socket `unix://$HOME/.colima/default/docker.sock`, active docker context `colima`).

```sh
colima start                                    # if not already running
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock   # path INSIDE the VM
export TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1
export TESTCONTAINERS_RYUK_DISABLED=true        # Ryuk cannot bind-mount colima's socket

pnpm --filter @civfix/api exec vitest run test/integration --no-file-parallelism
pnpm --filter @civfix/media-worker exec vitest run test/integration
```

Notes that cost time to rediscover:

- `--no-file-parallelism` is not optional on a 4-CPU VM: with vitest `isolate:true` every file boots its own postgis container, and running them in parallel starves the VM into health-check timeouts.
- Ryuk disabled means containers **leak between runs**. Reap them: `docker rm -f $(docker ps -aq --filter ancestor=postgis/postgis:16-3.4)`.
- `postgis/postgis:16-3.4` has a native arm64 image, so **Rosetta is not needed** for it. Only reach for `colima start --vm-type=vz --vz-rosetta` if some other image is amd64-only; emulated Postgres is slow enough to cause spurious timeouts.
- `colima stop` when done — the VM holds 6 GiB.

## 6. Denormalized follow counters (`0059`) — apply BEFORE the API image

`drizzle/0059_users_follow_counters.sql` adds `users.follower_count` / `users.following_count`, backfills both from `follows_people`, and the new code reads them everywhere a person's totals are rendered (`findPersonById`/`ByHandle`, `listPeople`, `listFollowers`/`listFollowing`, `suggestFollows`, `followerCount` in `social-repository.drizzle.ts`, and `loadAuthors` in `post-repository.drizzle.ts`). It replaces the correlated `count(*)` subqueries that walked a popular account's whole edge list on every render.

**Order matters in both directions:**

- **New API, migration missing:** every one of those reads raises `42703` (undefined column) — profiles, people search, both connection rosters, follow suggestions, the follow/unfollow response and every post author card. Alongside `0056` this is the second wave-2 file that hard-fails against the old schema; unlike `0056` the failure is instant and total rather than queued.
- **Old API, migration applied:** harmless to serve, but the old image writes `follows_people` rows without bumping the counters, so the numbers drift low for as long as it runs. The file is safe to re-run (see below) — if the gap is more than a moment, **re-apply it after the new image is up** to re-sync.

Maintenance is application-side, in the same transaction as the edge write (`addFollow` / `removeFollow`), gated on the `INSERT … ON CONFLICT DO NOTHING RETURNING` / `DELETE … RETURNING` actually having changed a row — an idempotent re-follow must not double count. It mirrors the `posts.like_count` pattern from `0051`. There is deliberately **no trigger**, which has one operational consequence: *anything that writes `follows_people` outside those two methods* (a psql session, a data fix, a future bulk import) must bump the counters too, or leave drift behind. Drift detector, safe to run on the live DB:

```sql
SELECT u.id, u.handle,
       u.follower_count,  (SELECT count(*) FROM follows_people f WHERE f.followee_id = u.id) AS actual_followers,
       u.following_count, (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id) AS actual_following
FROM users u
WHERE u.follower_count  <> (SELECT count(*) FROM follows_people f WHERE f.followee_id = u.id)
   OR u.following_count <> (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id);
```

Re-running the migration file is the repair: its backfill `UPDATE` is guarded by exactly that inequality, so it rewrites only the drifted rows and is a true no-op on a healthy database.

**Semantics to know before reading a number:** edges to and from **soft-deleted** users COUNT, because that is what the aggregates being replaced did (they never joined `users`) and because account deletion is a tombstone that leaves `follows_people` intact. So `follower_count` can legitimately exceed the length of the visible followers roster, which filters `deleted_at IS NULL`. Preserved deliberately rather than changed under a performance refactor — changing it would silently restate every profile's numbers.

Verified against a throwaway `postgis/postgis:16-3.4` with all 60 migration files (`0000`–`0059`) applied (37 assertions, all green): the backfill reproduces the aggregate including both tombstone directions; a second and third apply of the file rewrite nothing; `addFollow` twice moves each counter exactly once and `removeFollow` twice moves it back; a follow of a tombstoned user is refused with the counters untouched; a reciprocal follow-back and a repo-level self-follow (the case a two-statement bump would get wrong) both stay consistent; and every read path above — plus the extracted literal text of `loadAuthors` — returns the maintained values with zero drift at the end. The Docker-gated `test/integration/social-notifications-pg.test.ts` "follow/unfollow: idempotent, created flag, follower counts" case is the standing regression guard.

