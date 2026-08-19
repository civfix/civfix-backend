# Account erasure behavior (civfix-backend)

**Audience:** internal (engineering + privacy counsel). Not served publicly.
**Last verified:** 2026-07-27 (service-hours pre-deploy privacy re-audit; previous
pass 2026-06-20).

This documents exactly what happens to a user's data when they delete their
account via `DELETE /me`, so the published privacy policy and any DSAR / erasure
response can be answered truthfully. It is the source of record for the
"published-report erasure" decision flagged P0 in `documents/21-privacy-compliance.md` §7.2.

## The deletion path

`DELETE /me` (`services/api/src/routes/users.routes.ts`, op `deleteAccount`,
`[auth][csrf]`) performs a **soft delete**:

0. An **email-OTP gate**: the caller must re-prove control of the account email
   before any destructive work runs.
1. `UserStore.softDeleteAndAnonymize(userId)` — see
   `services/api/src/auth/pg-stores.ts`. **One transaction**, so a partial erasure
   is not a reachable state:
   - Sets `users.deleted_at = COALESCE(deleted_at, now())` (idempotent — a repeat
     delete keeps the original tombstone time).
   - Sets `users.allow_direct_messages = false`.
   - **Scrubs** the identity columns: `email = NULL`, `email_verified = false`,
     `display_name = 'Deleted User'`, `handle` → a generated placeholder,
     `bio`, `avatar_url`, `avatar_media_id`, `social_links` → `NULL`.
   - **Unlists** the user's `public` reports (→ `hidden`) and **cancels** their
     `upcoming`/`active` events.
   - **Revokes and scrubs their issued service-hours certificates** — see the
     dedicated section below.
   - Keeps every content foreign key intact (the rows survive; the author
     de-links).
   - AFTER the commit, best-effort deletes each revoked certificate's R2 object.
     Failures are logged, never thrown: a completed erasure must not surface to
     the client as "deletion failed".
2. `SessionStore.banUser(userId)` — deletes every durable session row, drops the
   write-through cache entries, and sets the ban/veto marker so any warm session
   that slipped a revoke is rejected on its next request.
3. Clears the session + CSRF cookies on the response.
4. Three independent best-effort cleanups (`allSettled`, each logged on failure):
   unlink the OAuth identities, hard-delete the device push tokens, and write the
   audit-log row (`account.deleted`, actor = the user).

## What is scrubbed vs. kept

| Data | After `DELETE /me` |
|---|---|
| Live sessions / login | **Revoked** — all sessions deleted, ban marker set, cookies cleared. |
| DM reachability | **Off** — `allow_direct_messages = false`. |
| `display_name`, `handle`, `email`, `bio`, `avatar_url`, `avatar_media_id`, `social_links` | **Scrubbed** on the `users` row — nulled, or replaced with the `Deleted User` label / a generated placeholder handle. |
| OAuth identity links | **Deleted** (best-effort, step 4) — otherwise a provider sign-in walks back into the tombstone once the ban marker's TTL lapses. |
| Device push tokens | **Deleted** (best-effort, step 4). |
| Reports the user filed | **Kept** as rows; the user's `public` ones are flipped to `hidden` (see public rendering below). |
| Discussion comments, chat, DMs the user wrote | **Kept** (soft-deleted only where the user deleted them individually). |
| Cleanups organized / joined | **Kept**; the user's `upcoming`/`active` events are `cancelled`. |
| `cleanup_slot_claims` (which signup slot they took, P9) | **Kept**. The row is `(cleanup_id, user_id, slot_id, claimed_at)` — roster data with no free-text PII, held exactly like the `cleanup_members` row it accompanies, and with no `ON DELETE CASCADE` to `users` by design (`drizzle/0063_cleanup_slots.sql`). The attendee/roster read joins `users` with `deleted_at IS NULL`, so a tombstoned claimant disappears from the visible roster; the row still counts toward the slot's `claimed` total. |
| `service_hours_certificates` (issued PDF transcripts, P5) | **Revoked + scrubbed**, rows kept, **R2 objects deleted**. See the next section. |

This is a deliberate **soft delete of the content graph**, not of the identity:
the rows survive so the public record and other people's conversations stay
coherent, while the identity columns are scrubbed and every public surface
de-links the author. There is **no hard purge** of the `users` row, the
public-record reports, or their R2 media. The one artifact that IS hard-deleted
from R2 is the rendered certificate PDF, because it prints the holder's name.

## Service-hours certificates (`service_hours_certificates`)

This is the only table in the product that holds a **frozen copy of the holder's
name** (`holder_name`, `holder_handle`) alongside an **itemised record of where
they volunteered and when** (`snapshot`, the whole rendered transcript model:
per-entry event titles, jurisdictions, occurred-at timestamps and crediting-host
names) — plus a rendered **PDF in R2 that prints all of it**.

Account deletion therefore does three things to it, transactionally with the
tombstone (`softDeleteAndAnonymize`, `services/api/src/auth/pg-stores.ts`):

1. **Revokes** every one of the user's certificates —
   `revoked_at = COALESCE(revoked_at, now())`,
   `revoked_reason = COALESCE(revoked_reason, 'account_closed')`. Rows are
   **not deleted**: `drizzle/0064_service_hours_certificates.sql` makes
   revocation, not deletion, the erasure primitive here, because a code must keep
   answering *"issued, then revoked"* rather than *"no such code"* for whoever is
   holding the paper. `'account_closed'` is exactly the reason the public verify
   projection already reports for a tombstoned holder.
2. **Blanks the identity columns**: `holder_name` → the `Deleted User` label (the
   column is `NOT NULL`), `holder_handle` → `NULL`, `snapshot` → `{}`. What
   survives is only what `verify` needs to keep answering — `code`, `issued_at`,
   `total_hours`, `entry_count`, the period bounds and `document_sha256`.
3. **Best-effort deletes the R2 object** for each row, after the commit. Same
   primitive the holder's own `revoke()` uses. Wired in production through
   `buildAuthServicesFromContainer`; if the object store is not wired the row
   scrub still happens and the skipped object is logged.

Already-revoked rows are included in the scrub: their PII is no less PII, and
their object may still exist if the best-effort delete at revoke time failed.

Public effect: a verifier who checks a code afterwards is told the document was
issued and is now revoked because the account was closed, with **no name**, and
the download link is dead. `test/integration/account-deletion-cascade-pg.test.ts`
holds this behavior.

**DSAR:** the table IS included in the data export
(`services/api/src/services/data-export-service.ts`, `certificates` section) —
every column except `snapshot` (a ~200 KB TOASTed copy of what the PDF already
prints, and what the ledger already holds) and `r2_key` (an internal object key,
never disclosed anywhere).

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
| **Direct messages** | `services/api/src/services/dm-repository.drizzle.ts` | Uses `publicAuthorIdentity` — "Deleted User". The surviving party KEEPS the thread in their inbox (the thread list no longer filters the peer on `deleted_at IS NULL`), with the peer rendered as "Deleted User", no handle/avatar/bio, `deleted: true`. |
| **Profiles / people directory / follow lists** | `services/api/src/services/social-repository.drizzle.ts` | Soft-deleted users are **excluded** (`deleted_at IS NULL`): the profile read returns *not found*, and they never appear in the directory, follower/following lists, search, or @-mention pickers. |
| @-mention resolution | `services/api/src/services/social-repository.drizzle.ts` | Excludes soft-deleted users. |
| Cleanup report galleries | `services/api/src/services/cleanup-repository.drizzle.ts` | Joins exclude `deleted_at IS NOT NULL` rows. |

**Conclusion:** after account deletion, a user's PUBLISHED reports and discussion
comments survive but render the author as "Deleted User" (reports expose no author
at all); their profile, directory presence, and mention-ability are removed. The
identity columns on the `users` row are themselves scrubbed, so the admin panel
no longer holds the real name or email either. The de-link is complete on every
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
   delete. The rendered service-hours PDFs are the one hard-deleted artifact (see
   that section for why). ⚖️ DECISION REQUIRED.
2. **Reports already forwarded to a city** persist in external municipal systems
   outside civfix's control; account deletion cannot reach them. This must be
   disclosed. ⚖️ DECISION REQUIRED.
3. **Per-report takedown** (an owner asking to remove one specific published report
   without deleting their account) is handled via the content-report / moderation
   path — see `docs/report-takedown.md`.

---

## Batch-2 appended sections (usersverify — merge into prose)

### F137 — deletion decoupled from having an email

`DELETE /me` no longer requires the account to have an email address. Behaviour:
- **Email on file** → the email-OTP gate still runs (re-prove control of the
  account email before any destructive work). Unchanged.
- **No email on file** (Apple hide-my-email, OTP-less, anon-claimed) → the OTP
  gate is skipped; the authenticated session + CSRF are the proof of control, and
  the soft-delete + anonymize proceeds. This closes a GDPR Art.17 gap where
  email-less accounts could never erase themselves. No add-email flow was built
  (deferred feature); the misleading "add and verify an email first" copy is gone.

`POST /me/data-export` still requires an email (it is the only delivery channel).
When none is on file it now returns an **accurate** 422 that points the user at the
support/DSAR contact (`support@{MAIL_REPLY_DOMAIN}`, a monitored catch-all inbox)
instead of telling them to use an add-email flow that does not exist.

### F088 (delete half) — notifications purged on account deletion

The `DELETE /me` post-revocation cleanup fan-out gained a
`DELETE FROM notifications WHERE user_id = $1` step (alongside oauth-unlink,
push-token purge, and the audit row). Notification rows are private to the deleted
user (they can hold verbatim chat/DM previews) and are not civic record, so they
are erased. Add this table to the "scrubbed on deletion" list. (The time-based
retention sweep for notifications is the media-worker half of F088.)

### F139 — DSAR export completeness + truncation remedy

`POST /me/data-export` now includes two previously-omitted personal-data stores:
`posts` (user-authored feed content) and the `volunteer_hours` ledger. The
truncation remedy copy no longer says "reply to this email" (the export is sent
From the no-reply mailbox); it now directs the user to the monitored support/DSAR
address. Excluded/redacted as before: push-token secrets (`[REDACTED]`),
certificate `snapshot`/`r2_key`, and all OTP/session/OAuth secrets.

### F018 — bounded, off-request-path export assembly

Export assembly moved off the request path into a `data.export` pg-boss job
(API-side work loop). The OOM/undeliverable-mail fix is a hard **byte budget**
(`DATA_EXPORT_BYTE_BUDGET`, 8 MB) applied while assembling: free-text sections
(chat/DM/posts) are additionally capped at `DATA_EXPORT_FREE_TEXT_MAX_ROWS`
(5,000), and any section clipped by rows or bytes is listed under `truncated`.
Email delivery is unchanged (a download-link endpoint would be a contract change).
