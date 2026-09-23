# Account status semantics (`user_moderation.account_status`)

Four values, one meaning each. The console (`POST /v1/admin/users/:id/status`) and the moderation queue
are the only writers: "remove" on a `user`/`profile` subject writes `suspended`, and an appeal decided
`overturn` on such a subject writes `active` (`restoreSubject` in `moderation-repository.drizzle.ts`).

| Status | Effect |
| --- | --- |
| `active` | No restriction. Clears the ban marker and the suspension. |
| `review` | **Flag only.** Nothing is restricted; it exists so operators can triage without acting. |
| `suspended` | **Read-only.** Every session is revoked at the moment the status is set, no new session can be minted, and every state-changing request is refused. Reads stay allowed. |
| `banned` | Unchanged: sessions revoked, per-user ban marker set, no session resolves, sign-in refused. |

`banned` is enforced from **Postgres truth**, not only from the Redis marker: `resolveSessionByHash`
treats a session row (or a cached projection) whose `account_status` is `banned` as dead, deletes it, and
re-sets the ban marker from that read — so a marker lost to a Redis flush or a partially-failed ban
cannot resurrect a banned account.

## Transitions

Every transition runs through `SessionService.applyAccountStatus`, so what an operator gets is exactly:

| From → To | Sessions | Ban marker | Net effect |
| --- | --- | --- | --- |
| any → `banned` | all revoked | set | no session resolves, sign-in refused |
| any → `suspended` | all revoked | cleared | read-only; sign-in refused |
| any → `review` | kept (cache re-read) | **cleared** | no restriction at all |
| any → `active` | kept (cache re-read) | cleared | no restriction |

Two of these are easy to misread, so console copy must say them out loud:

- **`banned → suspended` is a downgrade, not a release.** The ban marker is lifted, but the suspension
  takes effect in the same call (sessions revoked, writes refused, sign-in refused). The account is still
  restricted.
- **`banned → review` fully un-bans the account.** `review` is a triage flag that restricts nothing, so
  moving a banned user to `review` releases them. If the intent is "still restricted while we look at
  it", the correct status is `suspended`.

An **operator** account can never be moved to `suspended` or `banned`: both the console
(`admin-user-service.setStatus`), the moderation "remove" transaction
(`moderation-repository.drizzle.ts`) and `SessionService.applyAccountStatus` itself refuse it through the
shared `assertTargetIsNotOperatorRole` guard (`src/auth/operator-target.ts`). Operator access is governed
by `ADMIN_EMAILS` + Cloudflare Access; removing an operator is an allowlist edit, never a status change.

## How suspension is enforced

1. **Session revocation.** `SessionService.applyAccountStatus(userId, "suspended")` lifts any ban marker
   (a `banned → suspended` transition is a *downgrade* of the restriction, never a removal of it), then
   calls `revokeAllForUser`, which bumps the user's **revocation epoch** before deleting session rows.
   Every cached `sess:<hash>` projection records the epoch it was written under and is treated as a miss
   when the epochs differ, so a failed Redis eviction cannot strand a live session.
2. **Session mint refusal.** `issueSessionForUser` (email OTP, native + web Google/Apple) and the
   Cloudflare-Access operator exchange both refuse a suspended user with `403 FORBIDDEN`, mirroring
   `banned`.
3. **Write denial.** One `onRequest` hook (`src/auth/account-status.ts`, registered once in `server.ts`
   after the auth-context hook) refuses any request whose method is not `GET`/`HEAD`/`OPTIONS` from a
   session whose projection carries `accountStatus: "suspended"`. The account status rides in the session
   projection (the `user_moderation` join in `PgSessionStore.findById`), so this costs no extra query.
   Routes that a suspended user must still reach declare `config: { allowSuspended: true }`:
   `logout`, `deleteAccount` and `otpRequest` (the account-deletion confirmation code).
4. **WebSocket writes.** `ws/frame-handler.ts` refuses the `send` frame with a `FORBIDDEN` error frame;
   `join`, `leave`, `typing` and `ack` stay open. A socket that carries a session hash re-resolves its
   status on each `send` (one cached lookup), so suspension takes effect on the socket as fast as it does
   over HTTP; the 60–90 s periodic re-validation remains the backstop and is what closes a revoked socket.

Background jobs (pg-boss) are unaffected: they act on records, not on a request identity.

## Audit

Status changes keep writing `user.status_changed` (or `user.banned`), the moderation "remove" path
keeps writing `moderation.removed`, and an appeal decision writes `moderation.appeal_decided`. Nothing
about the audit trail changed.
