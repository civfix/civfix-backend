# Per-report takedown request path (civfix-backend)

**Audience:** internal (engineering + support + privacy counsel). Not served publicly.
**Last updated:** 2026-06-20 (privacy/backend-hardening).

Backs the "report takedown / removal request path" item in
`documents/21-privacy-compliance.md` section 7.2. `DELETE /me` soft-deletes the
*account* but published reports survive (rendered authorless). This documents how
a user requests removal of one specific published report **without** deleting
their account.

## How a user requests takedown of their OWN report

There is **no separate endpoint** (adding one would require a coordinated
`@civfix/shared` endpoint-registry release, out of scope here). Instead the
existing content-report channel carries it:

    POST /v1/content-reports
    { "subjectType": "report", "subjectId": "<their report id>", "reason": "...", "details": "..." }

Route: `services/api/src/routes/report-content.routes.ts` (op `reportContent`,
auth + csrf, rate-limited). The handler:

1. Files a `user_report` moderation item into the existing admin queue
   (`moderation_items`, the same queue operators already read).
2. **Detects ownership server-side** (`reportOwnedBy`): when the `report`
   subject's `reporter_user_id` equals the caller, the item is marked distinctly
   so an operator can fast-track an owner-consented removal:
   - `flag = "Owner takedown request"` (vs. `"User report"` for third-party reports),
   - `priority = "high"` (vs. `"med"`).
3. Writes an **audit-log entry** `report.takedown_requested`
   (`target = report:<id>`, `meta = { reason, via: "content-reports" }`) so the
   request is on the record even before an operator acts.

An operator then actions the queue item. **Remove** (`moderation.remove` ->
`report.removed` audit) sets `reports.status = 'rejected'`, `deleted_at = now()`,
and writes a `rejected` timeline row -- the report disappears from every public
surface (the report read returns 404 once `deleted_at` is set).

`dedupeOpen` keeps one open queue item per report, so repeated requests do not
spam the queue.

## Offline / no-DB behavior

`reportOwnedBy` is DB-gated and fail-safe: with no `DATABASE_URL` (all-fakes boot)
or on any query error it returns `false`, so the route degrades to the ordinary
user-report path (the request is still filed, just not flagged as an owner
takedown). The audit write only runs when ownership was confirmed, which implies
a real DB is present.

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
