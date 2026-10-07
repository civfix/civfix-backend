# Per-report takedown request path (civfix-backend)

**Audience:** internal (engineering + support + privacy counsel). Not served publicly.
**Last updated:** 2026-09-23 (checked against the code; first written 2026-06-20).

Backs the privacy item "report takedown / removal request path". `DELETE /me`
soft-deletes and anonymizes the *account* and unlists every report the user filed
(`visibility = 'hidden'` in `softDeleteAndAnonymize`, `auth/pg-stores.ts`; the
rows are kept, see `docs/erasure-behavior.md`). This documents how a user requests
removal of one specific published report **without** deleting their account.

## How a user requests takedown of their OWN report

There is **no separate endpoint** (adding one would require a coordinated
`@civfix/shared` endpoint-registry release, out of scope here). Instead the
existing content-report channel carries it:

    POST /v1/content-reports
    { "subjectType": "report", "subjectId": "<their report id>", "reason": "...", "details": "..." }

Route: `services/api/src/routes/report-content.routes.ts` (op `reportContent`,
auth + csrf, rate-limited per identity at 20/min). The handler:

1. Checks the caller can see the subject (`assertReportable`,
   `services/content-report-subject.ts`); a report the caller cannot read is a
   404. With no `DATABASE_URL` the gate allows everything.
2. **Detects ownership server-side** (`isReportOwnedBy`, `services/report-repository.drizzle.ts`):
   the report is not deleted and its `reporter_user_id` equals the caller.
3. Files a `user_report` moderation item into the existing admin queue
   (`moderation_items`, the same queue operators already read) with
   `dedupeOpen: true`. When no open item exists for the report, an owner's
   request is marked distinctly so an operator can fast-track an owner-consented
   removal:
   - `flag = "Owner takedown request"` (vs. `"User report"` for third-party reports),
   - `priority = "high"` (vs. `"med"`).

   When an open item already exists for the report (a held report, or an earlier
   third-party report), `dedupeOpen` does not insert. It escalates that item
   (`escalateOpenItem`: `priority = 'high'`, the caller's id appended to
   `meta.reporters`) and drops the new flag, reason and details, so the queue item
   does not say that the owner asked for removal.
4. Writes an **audit-log entry** `report.takedown_requested`
   (`target = report:<id>`, `meta = { reason, via: "content-reports" }`) whenever
   ownership was confirmed, so the request is on the record even before an
   operator acts, and even when step 3 folded it into an existing item.

An operator then actions the queue item. **Remove** from the moderation queue
(`remove` in `services/admin/moderation-repository.drizzle.ts`, audit
`moderation.removed` with `target = moderation:<id>`) sets
`reports.status = 'rejected'` and `deleted_at`, writes a `rejected` timeline row
(note: the operator's reason, or "Removed in moderation"), and adds a strike and a
removal to the report author's `user_moderation` counters, which for an owner
takedown is the requester. The admin report screen's own remove action
(`services/admin/admin-report-repository.drizzle.ts`) does the same row changes
without the strike and audits `report.removed`. Either way the report read returns
404 once `deleted_at` is set, and `getMedia` denies the report's media
(`authorizeReportBound`, `services/media-authorization.ts`).

The report's media objects are not touched. With `R2_PUBLIC_BASE` set, a public
report's photos were served at a stable, unsigned `<R2_PUBLIC_BASE>/<served_key>`
URL (`makeMediaPresigner`, `adapters/storage.r2.ts:63`), and that URL keeps
resolving after the takedown for anyone who already holds it.

## Offline / no-DB behavior

The owner check is DB-gated: with no `DATABASE_URL` (all-fakes boot) the route returns
`false`, so the route degrades to the ordinary user-report path (the request is
still filed, just not flagged as an owner takedown). A query error is not caught:
it propagates and the request fails with 500 (not filed), so a transient DB error
never downgrades an owner takedown to a third-party report. The audit write only
runs when ownership was confirmed, which implies a real DB is present.

## What this does NOT do (product/counsel DECISIONS)

- **No irreversible hard purge.** Actioning a takedown soft-deletes the report
  (`deleted_at`); it does NOT hard-delete the row, the R2 media, or backups.
  Whether an erasure request should trigger a true hard purge across DB + R2 +
  backups is a product/counsel decision (see `docs/erasure-behavior.md`).
  DECISION REQUIRED.
- **No SLA encoded.** Response-time targets (e.g. the common 45-day DSAR clock)
  are an operations/policy commitment, not code. DECISION REQUIRED.
- **City-forwarded copies** of a report persist in external municipal systems and
  are out of civfix's reach; a takedown here cannot recall them. Must be
  disclosed. DECISION REQUIRED.
