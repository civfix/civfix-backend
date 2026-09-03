# Account status semantics (`user_moderation.account_status`)

Four values, one meaning each. The console (`POST /v1/admin/users/:id/status`) and the moderation queue
("remove" on a `user`/`profile` subject, which writes `suspended`) are the only writers.

| Status | Effect |
| --- | --- |
| `active` | No restriction. Clears the ban marker and the suspension. |
| `review` | **Flag only.** Nothing is restricted; it exists so operators can triage without acting. |
| `suspended` | **Read-only.** Every session is revoked at the moment the status is set, no new session can be minted, and every state-changing request is refused. Reads stay allowed. |
| `banned` | Unchanged: sessions revoked, per-user ban marker set, no session resolves, sign-in refused. |

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
   `join`, `leave`, `typing` and `ack` stay open. The socket's status is refreshed by the same periodic
   re-validation that checks revocation (60–90 s).

Background jobs (pg-boss) are unaffected: they act on records, not on a request identity.

## Audit

Status changes keep writing `user.status_changed` (or `user.banned`), and the moderation path keeps
writing `moderation.removed`. Nothing about the audit trail changed.
