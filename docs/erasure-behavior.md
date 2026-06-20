# Account erasure behavior (civfix-backend)

**Audience:** internal (engineering + privacy counsel). Not served publicly.
**Last verified:** 2026-06-20 (privacy/backend-hardening review).

This documents exactly what happens to a user's data when they delete their
account via `DELETE /me`, so the published privacy policy and any DSAR / erasure
response can be answered truthfully. It is the source of record for the
"published-report erasure" decision flagged P0 in `documents/21-privacy-compliance.md` §7.2.

## The deletion path

`DELETE /me` (`services/api/src/routes/users.routes.ts`, op `deleteAccount`,
`[auth][csrf]`) performs a **soft delete**:

1. `UserStore.softDeleteAndAnonymize(userId)` — see
   `services/api/src/auth/pg-stores.ts`:
   - Sets `users.deleted_at = COALESCE(deleted_at, now())` (idempotent — a repeat
     delete keeps the original tombstone time).
   - Sets `users.allow_direct_messages = false`.
   - **Keeps** `display_name`, `handle`, `email`, `avatar_url`, `bio`, OAuth
     identity links, and every content foreign key intact.
2. `SessionStore.banUser(userId)` — deletes every durable session row, drops the
   write-through cache entries, and sets the ban/veto marker so any warm session
   that slipped a revoke is rejected on its next request.
3. Clears the session + CSRF cookies on the response.
4. Writes an audit-log row (`account.deleted`, actor = the user).

## What is scrubbed vs. kept

| Data | After `DELETE /me` |
|---|---|
| Live sessions / login | **Revoked** — all sessions deleted, ban marker set, cookies cleared. |
| DM reachability | **Off** — `allow_direct_messages = false`. |
| `display_name`, `handle`, `email`, `avatar_url`, `bio` | **Kept** on the `users` row (so the admin panel retains the real identity — operator truth). |
| OAuth identity links | **Kept** (admin truth). |
| Reports the user filed | **Kept** (the rows survive; see public rendering below). |
| Discussion comments, chat, DMs the user wrote | **Kept** (soft-deleted only where the user deleted them individually). |
| Cleanups organized / joined | **Kept**. |

This is a deliberate **soft delete**: the durable PII survives so operators keep
the real identity for moderation/abuse/legal continuity, while every *public*
surface de-links the author. There is **no hard purge** of the `users` row, the
public-record reports, or the R2 media on account deletion.

## How deleted authors render on public surfaces (de-linking)

The `users` row survives, but its `deleted_at` tombstone drives a consistent
"Deleted User" projection everywhere a name/handle/avatar would otherwise be
exposed. Single source of truth:
`services/api/src/services/public-author.ts` (`publicAuthorIdentity`), which
renders `DELETED_USER_LABEL` with **no handle, no avatar URL, `deleted: true`**
(clients drop the profile link) whenever `deleted_at` is non-null.

Verified call sites (all public projections):

| Surface | File | Behavior for a deleted author |
|---|---|---|
| Public **reports** (detail / list / map pins / search) | `services/api/src/services/report-service.ts` (`ReportDTO`, `ReportPinDTO`) | The public report DTO **carries no reporter identity at all** — there is no reporter name/handle/avatar field on `ReportDTO`/`ReportPinDTO`. So a surviving public report exposes zero author PII regardless of deletion. (Reporter identity exists only on the admin `AdminReportDTO`.) |
| Report **discussion** comments | `services/api/src/services/discussion-service.ts` (`toAuthorDTO`) | Renders "Deleted User", no handle, `deleted: true`. |
| Cleanup group **chat** | `services/api/src/services/chat-repository.drizzle.ts` (`toMessageDTO`) | Renders "Deleted User", no handle/avatar, bio nulled, `deleted: true`. |
| **Direct messages** | `services/api/src/services/dm-repository.drizzle.ts` | Uses `publicAuthorIdentity` — "Deleted User". |
| **Profiles / people directory / follow lists** | `services/api/src/services/social-repository.drizzle.ts` | Soft-deleted users are **excluded** (`deleted_at IS NULL`): the profile read returns *not found*, and they never appear in the directory, follower/following lists, search, or @-mention pickers. |
| @-mention resolution | `services/api/src/services/social-repository.drizzle.ts` | Excludes soft-deleted users. |
| Cleanup report galleries | `services/api/src/services/cleanup-repository.drizzle.ts` | Joins exclude `deleted_at IS NOT NULL` rows. |

**Conclusion:** after account deletion, a user's PUBLISHED reports and discussion
comments survive but render the author as "Deleted User" (reports expose no author
at all); their profile, directory presence, and mention-ability are removed. Real
identity is retained only for the admin panel. The de-link is complete on every
public surface — no further author-anonymization work was required by this review.

## Open product/counsel DECISIONS (not implemented here)

These are policy choices, not engineering gaps. They are deliberately **not**
implemented as code in this pass:

1. **Hard purge of public-record content.** Account deletion does NOT hard-delete
   the user's published reports, their discussion comments, the `users` row, or
   the associated R2 media. Keeping public-record civic reports after the author
   leaves (rendered authorless) is a defensible free-expression / public-record
   stance, but it must be a **written, disclosed decision**. If counsel decides an
   erasure request should instead trigger a true hard purge across DB + R2 +
   backups, that is a separate, larger workstream — do not infer it from this soft
   delete. ⚖️ DECISION REQUIRED.
2. **Reports already forwarded to a city** persist in external municipal systems
   outside civfix's control; account deletion cannot reach them. This must be
   disclosed. ⚖️ DECISION REQUIRED.
3. **Per-report takedown** (an owner asking to remove one specific published report
   without deleting their account) is handled via the content-report / moderation
   path — see `docs/report-takedown.md`.
