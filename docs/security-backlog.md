# Security backlog: accepted risks and open follow-ups

The open items and deliberately accepted residual risks carried over from the 2026-07-24 full backend
security review (retired; it is in git history), each re-checked against the code. A fixed item leaves
this file in the change that fixes it. IDs are the review's own (H = high, M = medium, L = low,
F = `@civfix/shared` follow-up).

## Operator rules that stay in force

- `WS_ALLOW_QUERY_TOKEN` must stay unset in every environment. It re-enables `?token=` on the WebSocket
  upgrade, which puts a 30-day session token into edge logs (H5).
- `OAUTH_REQUIRE_NONCE` stays `false` until a mobile build that sends a nonce is the oldest one in the
  stores (H1); then set it to `true` in staging, then production.
- `MEDIA_UNSCORED_POLICY` decides what happens to media nobody could score for NSFW. No scorer is wired
  today, so every photo is unscored: `flag` publishes it, `hold` sends it to moderation (M9).

## Open

| ID | Risk | Where it stands |
| --- | --- | --- |
| H1 | A captured Google/Apple id_token can be replayed until it expires, because the nonce is optional | Server issues and checks nonces; no client sends one; the nonce endpoint is not in the shared registry yet |
| H2 | Operator sessions are not tagged with the login that minted them, so the operator guard cannot tell a Cloudflare Access session from a consumer one | No `origin` on sessions; the guard re-checks `ADMIN_EMAILS` per request, which limits the impact |
| H5 | The mobile app still falls back to `?token=<bearer>` when a WebSocket ticket cannot be fetched | Client fix needed; the server refuses the query token unless the break-glass flag above is set |
| H7 | A client can ask to send a `system` message kind; only the gateway allowlist stops it | No database check; the shared send-frame schema still lists every kind |
| H11 | A push token binds to whoever registers it first, with no proof the device is theirs | Conflicts answer 409; possession proof (a silent push echo) is not built |
| M9 | Photos are published unscored, because no NSFW model is wired | See `MEDIA_UNSCORED_POLICY` above |
| M10 | Uploads can be presigned anonymously | Accepted: per-host rate limit, a daily byte quota per subject, and a 6-hour orphan reaper bound it |
| M12 | Group chats add members without their consent; the block check scans only the first 200 members | Consent needs an invite table and client work |
| M15 | API to Postgres traffic on the compose bridge is not encrypted | The API refuses a non-TLS `DATABASE_URL` except for the compose alias; Postgres has no certificate |
| L1 | Media upload and finalize are cookie mutations without CSRF | Web and admin do not send the CSRF header on these calls yet; both sides must move together |
| L3 | The legacy, non-`__Host-` session cookie name is still accepted | Remove about 90 days after the first production release that shipped the rename |
| L7 | Some contract URL fields accept any scheme | Admin writers are checked server-side; the public contact suggestion stores it as text only |
| L14 | The upload's declared sha256 is only shape-checked | No stored hash and no worker re-hash |
| L17 | The inbound-mail webhook still accepts the legacy body-only signature | Turn it off once the deployed email worker is confirmed to send timestamps |
| L25 | Any member of an event sees the full attendee list | Product decision |
| L26 | Pagination cursors are unsigned | Accepted: cursors carry no authority |

## Contract follow-ups (`@civfix/shared`)

| ID | Gap |
| --- | --- |
| F1 | Logout requires auth, so a client with a dead session cannot clear its cookies |
| F3 | Admin activity and list filters are plain strings; an unknown value degrades silently instead of a 422 |
| F5 | Finalizing an upload always answers `validating`, so a rejected upload looks pending forever |
| F6 | Inbox attachment lists are cut at 50 with no truncation flag |
| F7 | The mailer seam's `sendOtp` has no locale parameter the backend relies on |
| F8 | The storage seam's presign has no `forceSigned` option the backend relies on |
| F9 | The inbound-mail fake still honors a thread-token header production ignores |
| F10 | The chat seam's broadcast has no `excludeConnId` option the backend relies on |
| F11 | Held videos are queued for moderation as images; the moderation kind has no `video` |
