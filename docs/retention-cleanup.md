# Retention cleanup jobs (civfix-backend)

**Audience:** internal (engineering + ops). Not served publicly.
**Last updated:** 2026-09-02 (audit-fix pass: inbound_emails TTL + doc-drift corrections).

Backs the "written retention schedule + scheduled cleanup jobs" item in
`documents/21-privacy-compliance.md` §7.1 for the TTL-able auth artifacts that
previously accumulated forever (no existing path deleted them).

## What runs

A `retention.sweep` cron in the **media-worker** (the same process that runs
`orphan.sweep` and `chat.partition.maintenance`) deletes expired rows from the
tables below. Every lane but `inbound_emails` deletes already-expired rows only
and needs no schema of its own.

| Table | Rows deleted | Source schema |
|---|---|---|
| `email_otps` | `consumed_at IS NOT NULL` OR `expires_at < cutoff` | `services/api/src/db/schema/otp.ts` |
| `anon_tokens` | `expires_at < cutoff` | `services/api/src/db/schema/anon.ts` |
| `sessions` | `expires_at < cutoff` | `services/api/src/db/schema/sessions.ts` |
| `idempotency_keys` | `created_at < now - 48h` (`RETENTION_IDEMPOTENCY_MS`) | `services/api/src/db/schema/idempotency.ts` |
| `notifications` | `created_at < now - 90d` (see F088 below) | `services/api/src/db/schema/notifications.ts` |
| `inbound_emails` | `archived_at < now - 180d` (see H10 below) | `services/api/src/db/schema/inbound_emails.ts` |

`cutoff = now - grace`, where `grace` defaults to **1 hour** past expiry (so a
just-expired row is never raced out from under an in-flight request). Each table
is deleted in a bounded batch (default **5000** rows/run, via a `ctid` subselect)
so a backlog drains over several daily runs rather than one long-locking DELETE.

## Where it lives

- Job logic: `services/media-worker/src/jobs/retention-sweep.ts`
  (`runRetentionSweep`) — pure deps, injectable clock/log/report, **never throws**
  (a per-table failure is counted + reported to GlitchTip; the other tables still
  run). Mirrors the orphan-sweep job shape exactly.
- Registration: `services/media-worker/src/worker.ts` — `RETENTION_SWEEP_JOB`
  queue + worker + `jobs.schedule(RETENTION_SWEEP_JOB, RETENTION_SWEEP_CRON)`.
- Schedule: `services/media-worker/src/config.ts` — `RETENTION_SWEEP_CRON`
  = `37 4 * * *` (daily, 04:37 UTC, off-peak).
- Tests: `services/media-worker/test/unit/retention-sweep.test.ts`.

## Scheduling mechanism

This follows the EXISTING periodic-work pattern — pg-boss cron via the worker's
Jobs seam (`jobs.schedule(name, cron)`), the same mechanism as the orphan sweep
and chat-partition maintenance. When the worker boots against a real
`DATABASE_URL` it registers the cron with pg-boss; in all-fake offline boot
(`USE_FAKE_JOBS=1`, no DB) the handler no-ops (nothing to delete).

## Tuning

Overridable per run via `runRetentionSweep({ graceMs, batchSize })`. The cron
expression is a code constant (`RETENTION_SWEEP_CRON`); change it there if a more
frequent cadence is wanted.

## Not covered here (deliberately)

Message/report *aging* (deleting old chat/DM/report rows after N days) is a
separate **product/counsel retention DECISION** — this sweep only reaps auth
artifacts that are unambiguously dead once expired. Orphaned media already has its
own `orphan.sweep`.

---

## F088 (mw half) — notifications now aged in retention.sweep

`notifications` is now a table drained by `retention.sweep`
(`services/media-worker/src/jobs/retention-sweep.ts`): rows with
`created_at < now() - 90 days` are deleted in bounded pages
(`RETENTION_NOTIFICATIONS_MS`, overridable via `notificationsRetentionMs`).

RATIONALE: chat/DM message previews are copied verbatim into notification
`body`, so an unbounded notifications table retained those copies forever —
surviving message deletion and every other sweep. A 90-day TTL bounds that
retention. Notifications are private to their recipient and are NOT civic
record, so aged deletion is safe (unlike published reports).

DECIDED TTL: 90 days (single lane for all notification types). If a shorter
TTL is later wanted for `FEED_HIDDEN_NOTIFICATION_TYPES` (chat/DM bells never
shown in the feed), split into a second drain — no schema change needed.

INDEX: `notifications_created_idx` (migration `0094_notifications_created_idx.sql`)
now covers the bare `created_at` drain — this was previously listed as deferred.
The F089 `notifications_feed_idx` is `(user_id, created_at DESC, id DESC) WHERE
type <> …` and does NOT cover it. The `DELETE /me` erasure cleanup step and the
`docs/erasure-behavior.md` row are owned by the users/erasure workstream.

UPDATE (H19, audit 2026-09) — the inflow side is now bounded too. Group/report
room activity used to write ONE row per member per message. Two windows now
govern it, deliberately separate
(`services/api/src/services/chat-room-fanout-notifier.ts`):

* `ROOM_ACTIVITY_COALESCE_WINDOW_MS` (10 min) is the BELL window — a recipient
  keeps ONE unread bell per room per window and gets ONE push; later messages
  UPDATE that row's title/body via `refreshUnreadNotification` instead of
  inserting. A recipient who READS (opens) the room has no unread row left, so
  the next message rings again immediately.
* `ROOM_FANOUT_THROTTLE_MS` (15 s) is the COST window — how often a room may pay
  for a fan-out at all (member list + presence + block/mute batches + the
  per-recipient upsert). It never decides whether a bell is due, so a refresh or
  a re-ring is at most 15 s stale even on a single-process deployment.

The upsert is ONE statement pair inside a single short `sql.begin`
(`upsertCoalescedNotification`): the `FOR UPDATE` in the refresh subquery makes
two runners that find the same unread row serialise, so the second refreshes
rather than inserting. RESIDUAL, accepted deliberately: when NO unread row
exists yet and two runners race (the Redis window claim fails open, or one
fan-out outlives the 15 s claim TTL), both can insert — there is no unique
constraint to lean on and `notifications` is a hot table where new DDL is not
worth it. The blast radius is ONE extra unread row per member per race, both
rows carry the same room link, opening the room clears them together, and the
next fan-out inside the bell window refreshes one of them rather than adding a
third.

The message preview stored in `body` is therefore the LATEST message of the
window rather than one row per message; retention semantics and the 90-day TTL are
unchanged, but the volume the sweep has to drain is bounded by rooms×windows
instead of members×messages. Mention/reply/DM bells are NOT coalesced.

The fan-out itself can now run off the sender's WS frame, on the pg-boss queue
`chat.room.fanout` (`services/api/src/services/chat-fanout-jobs.ts`, registered
in `src/server.ts`, queue declared in `src/adapters/jobs.pgboss.ts` with the
same explicit `policy: "short"` every API queue uses). Its `singletonKey` is
`<kind>:<roomId>:<throttle bucket>`, so simultaneous enqueues from different API
processes collapse into one run. The job payload is IDS ONLY — `{kind, roomId,
messageId}` — deliberately: `pgboss.job` has its own archive retention that was
never reviewed for message bodies, so the handler re-reads the message through
the room-scoped repository (which also preserves the "Deleted User" rendering)
instead of carrying a preview through the queue. The handler also drops a
message that was TOMBSTONED between the enqueue and the run — the finders
hydrate a tombstone rather than returning null, so a deleted message must not
still bell the room.

A caller opts in by passing `dispatchToJob` (and optionally the cross-process
`claimWindow`) to `makeRoomFanoutNotifier`; with neither, the notifier fans out
inline exactly as before, and an enqueue that throws (queue not started) also
falls back inline so bells are never silently dropped. The REST poll lane stays
inline on purpose — a poll create is one event, not a burst. Wiring the WS send
lane (`src/routes/chat-gateway-wiring.ts`) is the remaining step.

---

## F106 — `inbound/failed/` poison-message store (adminmail-a)

The inbound-mail processor parks parse-poisoned or over-cap `.eml` objects under
the R2 prefix `inbound/failed/` (`moveToFailed` in
`services/api/src/services/admin/inbound-processor.ts`). These are complete raw
messages (sender, body, attachments, headers) from residents/municipalities, so
they carry PII and MUST NOT accumulate forever. There is deliberately NO read
path for the prefix — it exists only so the boot/cron sweep never loops on a
poison object.

- **Retention:** delete `inbound/failed/**` objects older than **14 days**.
- **How it is enforced:** OWNED BY OPS — an R2 lifecycle rule on the inbound
  bucket, or a bounded pass inside the retention sweep. This code change adds
  the visibility signal only (`runInboundSweep` now returns `parked`, logged by
  `inbound.sweep`), not the reaper. See the wiring request in
  `SCRATCH/wiring/adminmail-a.md` (F106).
- **No new PII surface:** the bytes are already the raw inbound message; this
  documents an existing store and bounds its lifetime, it does not add data.

---

## Guest event RSVP — new TTLs (contract 0.38.0, DECISIONS §18)

Guest RSVP is the first PII the platform holds for people who are NOT users,
and phone numbers are a class it has never held at all, so the three new tables
from `services/api/drizzle/0096_cleanup_guests.sql` each carry an explicit rule.

| Table | Rule | Enforced by |
|---|---|---|
| `cleanup_guests` (`email`, `phone`, `contact_key`) | NULLed ~**30 days** after the event's `scheduled_at` passes. For a **cancelled** event the clock is the guest row's own `created_at`, NOT the moment of cancellation — a guest who RSVPd more than 30 days before the host cancelled is scrubbed on the next sweep, and one who RSVPd yesterday keeps their contact until 30 days after that RSVP. Also NULLed **immediately** when the guest cancels their own RSVP. | `guest.retention.sweep` cron + `guestRsvpCancel` |
| `cleanup_guests` (the row itself) | Kept indefinitely, contact-free. It is the record that someone RSVPd (and whether they withdrew); `contact_scrubbed_at` marks that the means of contacting them is gone. | — |
| `guest_otps` | Deleted **24 hours** after `created_at`. A guest OTP is dead the moment it is consumed or expires (5 min); 24h is pure operational slack. | `guest.retention.sweep` cron |
| `sms_opt_outs` | **Indefinite, deliberately.** A suppression list that expires re-enables texting someone who replied STOP. Never add a TTL here. | — |

### Where it lives

- Job logic: `services/api/src/services/guest-rsvp-service.ts` (`runRetentionSweep`),
  backed by `scrubExpiredGuestContacts` / `deleteStaleOtps` in
  `services/api/src/services/guest-rsvp-repository.drizzle.ts`. Both run in
  bounded pages (`GUEST_RETENTION_BATCH`, 500 rows) and DRAINED to the cutoff
  each run (up to `GUEST_RETENTION_MAX_PAGES` = 20 pages, i.e. 10k rows/lane/run)
  rather than one long-locking statement. The two lanes are independent: a
  failure in the contact scrub is logged and still lets the OTP reap run, and a
  run that hits the page ceiling logs the remaining backlog and continues on the
  next run. A single capped page would NOT meet the TTLs below once daily inflow
  exceeded it, so the drain is load-bearing, not an optimization.
- Registration: `services/api/src/services/guest-jobs.ts` — the
  `guest.retention.sweep` queue + worker + `jobs.schedule(...)`, started from
  `server.ts` alongside the other API crons.
- Schedule: `GUEST_RETENTION_CRON` env var (default `15 4 * * *`, 04:15 UTC).

This sweep lives in the **API** (like `outreach.digest` and `inbound.sweep`),
not in the media-worker's `retention.sweep`, because it reads the guest domain's
own repository rather than the auth artifacts that sweep owns.

### Deletion semantics

`cleanup_guests` has **no** `users` FK by design — a guest is not an account and
account deletion does not touch guest rows. `ON DELETE CASCADE` on `cleanup_id`
means deleting an event (which the product does not currently do) removes its
guests with it. There is no way to look a guest up by contact, so there is no
guest-facing erasure endpoint: cancelling the RSVP is the erasure path, and it
is capability-based (the manage token), needing no identity check.

---

## H10 — `inbound_emails` retention (audit-fix 2026-09)

`inbound_emails` holds the catch-all inbox: complete third-party correspondence
(`body_text`, sanitized `body_html`, allowlisted headers) plus the R2 keys of
every attachment. It had **no TTL and no sweep**, so it was on track to become the
largest unbounded PII store on the box, with no way to honour a DSAR from a
resident who had emailed support.

**DECIDED RULE (product owner, 2026-09-02):** an **archived** thread is purged
**180 days after `archived_at`**. Unread and read rows are untouched — they are
still open operator work, and ageing them out would silently drop live
correspondence. The attachment objects in the inbound R2 bucket are deleted with
the row.

| What | Value |
|---|---|
| Table | `inbound_emails` |
| Predicate | `archived_at IS NOT NULL AND archived_at < now() - 180 days` |
| Objects deleted | every `attachments[].key` on the deleted rows, from the **inbound** bucket |
| Cron | the existing `retention.sweep` (`37 4 * * *`, daily) |
| Batching | `SELECT … ORDER BY archived_at ASC LIMIT n` → delete that page's objects → `DELETE … WHERE id = ANY(...)`, drained page-wise up to `RETENTION_MAX_PAGES` |
| Order | **objects before rows.** Deleting rows first meant a crash between the commit and the object deletes leaked every object on the page with nothing left pointing at it. In this order a crash leaves rows whose objects are already gone; the next run re-selects them and object deletes are idempotent, so the page simply completes. A row whose objects could NOT be deleted is kept and retried; a page where nothing at all could be reaped stops the drain rather than re-selecting the same rows. |
| Tuning | `runRetentionSweep({ inboundEmailsRetentionMs })`, constant `RETENTION_INBOUND_EMAILS_MS` |

**Schema:** `drizzle/0101_inbound_emails_archived_at.sql` adds `archived_at`
(plus a partial index for the sweep predicate) and backfills existing archived
rows from `received_at`. `InboundRepository.setStatus` stamps `archived_at` on
the transition into `archived` and clears it on any transition out, so
un-archiving restarts the clock rather than leaving a stale deadline.

**Where it lives:** the delete is
`services/api/src/services/admin/inbound-retention-repository.drizzle.ts`
(`makeDrizzleInboundRetentionRepository`, exported to the worker as
`@civfix/api/inbound-retention-repo`); the drain lane is
`runInboundEmailRetentionLane` at the END of
`services/media-worker/src/jobs/retention-sweep.ts`, called once from
`runRetentionSweep` after the auth-artifact lanes. Tests:
`services/media-worker/test/unit/retention-sweep.test.ts` (lane) and
`services/api/test/integration/inbound-repository.test.ts` (the `archived_at`
clock + the retention predicate against the real schema).

**Bucket:** inbound attachments are written by the API through
`container.inboundStorage`, which is the dedicated `R2_INBOUND_BUCKET` whenever
`R2_PUBLIC_BASE` is set (raw inbound mail is never kept in the public media
bucket). The worker therefore builds its own `inboundStorage` seam
(`services/media-worker/src/seams.ts`) instead of reusing the media `storage`
seam.

**Row deletion:** `deleteByIds` deletes strictly by the ids the same page selected and deliberately does
NOT re-check `archived_at`. By the time it runs, that page's attachment objects are already gone, so
re-qualifying the row could only leave a row pointing at deleted objects. The window is one page of a
single sweep run, and the only way a row could stop qualifying inside it is an operator un-archiving it in
that instant — for which "the row goes" is the consistent outcome, not a lost decision.

**OPS:** the worker's SOPS env (`civfix-infra/secrets/media-worker.sops.env`)
currently carries `R2_PUBLIC_BASE` but NOT `R2_INBOUND_BUCKET`, so the bucket
cannot be identified there yet. The worker does **not** refuse to boot over
this: it logs a warning, leaves `inboundStorage` undefined, and the lane is
**skipped entirely** — rows are KEPT, never deleted with unreachable
attachments. Add `R2_INBOUND_BUCKET` (the same value the API uses) to the
worker's env to activate the lane. A failed object delete is counted
(`inboundEmailObjectsLeaked`) and reported to GlitchTip, and the row is **kept** so the next run retries
it — a row is only deleted once every one of its objects is gone. A page where nothing at all could be
reaped ends the drain rather than re-selecting the same rows.

**Not covered:** `mail_threads` / `mail_messages` (the operator outreach record
for reports and events) are civic-record correspondence about a public report and
are deliberately kept, like the reports themselves.

### `mail_events` — no TTL (accepted)

`mail_events` is the per-delivery trail (`sent` / `failed` / `delivered` /
`bounced` / `complained` / `opened`) behind every outbound packet. It has **no
retention rule and that is deliberate**:

- It carries **no message content** — only a type, a timestamp, the from/to
  addresses and a small meta jsonb (`reason`, `deadlineMs`, `bytes`,
  `failedRecipient`, `late`). It is the least PII-bearing table in the mail
  cluster.
- It is **load-bearing for correctness**, not just history. `send_failed` /
  `send_in_flight` (`admin-report-repository.drizzle.ts`) and `hasSendInFlight`
  (`mail-repository.drizzle.ts`) decide from the newest outbound attempt's own
  events whether a report may be re-routed. Ageing rows out would make an old
  report look re-routable and could put a second packet in front of a
  jurisdiction.
- Growth is bounded by **outbound volume**, not by inbound traffic: a handful of
  rows per report routed or operator reply, not one per inbound webhook.

**Indexing is the real constraint.** Every predicate above must be reachable
through `mail_events_thread_idx` (`thread_id`); the table has no `message_id`
index, so a per-attempt subquery filtered only on `message_id` seq-scans it.
`services/api/src/services/admin/outbound-send-sql.ts` is the single place those
expressions are built, and every `mail_events` subquery there carries the thread
filter — asserted offline by
`services/api/test/unit/outbound-send-sql.test.ts`.

**Pending decision (not taken here):** if outbound volume ever makes the table
large, the safe TTL is "delete events whose thread has no outbound message newer
than N months", never a flat `created_at` cutoff — the newest attempt's events
must outlive the in-flight and stale-claim windows by a wide margin.

---

## Event host platform — new TTLs (contract 0.40.0)

Organizations, ticketed registration, host broadcasts and donations each add
stores with their own rule. Everything below is enforced by the
`host.retention.sweep` cron (`HOST_RETENTION_CRON`, default `35 4 * * *`) unless
another lane is named; every lane is bounded (500 rows × 20 pages per run) and
NEVER throws — a failed lane is logged and the next lane still runs.

### Organizations and event team

| Table | Rule | Enforced by |
|---|---|---|
| `org_verifications.ein_number` | NULLed **90 days** after `reviewed_at`; `ein_scrubbed_at` records it. The row (kind, decision, document list, reviewer) is kept — it is the audit trail of a verification decision. | `host.retention.sweep` → `organizationService.scrubDecidedEins(limit)` |
| `org_verifications.documents` | Kept as an id list; the underlying media are `purpose = 'verification'` assets and follow the verification-media rules. Never exported to the organization or to `/me/data-export`. | — |
| `cleanup_team_invites.invited_email` | NULLed **7 days after `expires_at`**, and immediately on accept or revoke; `email_scrubbed_at` records it. The row is kept as the record of who was given standing on the event. | `host.retention.sweep` → `hostTeamService.scrubInviteEmails(limit)` + the accept/revoke statements |
| `cleanup_team_invites.status` | `pending` → `expired` once `expires_at` passes. | `host.retention.sweep` → `hostTeamService.expireStaleInvites(limit)` |
| `event_consents` | **Never scrubbed, never swept.** Deleted only with its event (`ON DELETE CASCADE`); `registration_id` is `ON DELETE SET NULL` (0121) so the consent artifact survives a registration that does not. It holds no contact detail of its own — the subject is a foreign key — and it is the artifact THAT consent existed, including the `surface` it was captured on. | — |

### Registration and check-in

| Store | Rule | Mechanism |
|---|---|---|
| `cleanup_answers` (`value_text` / `value_json`) | NULLed **30 days** after the event ends | `host.retention.sweep` -> `registrations` lane; `scrubbed_at` stamped, a partial index drains the backlog |
| `cleanup_registration_seats.checked_in_at` | coarsened to the DAY at **30 days** | `host.retention.sweep` -> `registrations` lane; `checkin_coarsened_at` stamped |
| `cleanup_registration_seats.attendee_name` | NULLed **30 days** after the event | `host.retention.sweep` -> `registrations` lane; partial index |
| `cleanup_registrations.host_note` | NULLed **90 days** after the event | `host.retention.sweep` -> `registrations` lane; partial index |
| `cleanup_registrations`, `cleanup_registration_seats` (the rows) | Kept. They are the roster record of someone else's event, and a check-in is a civic-participation record. | — |

### Communications, analytics and exports

| Data | TTL | Lane |
|---|---|---|
| `broadcast_deliveries` rows | **180 d** from `created_at` | `host.retention.sweep` → `broadcast_deliveries` |
| `broadcasts` subject + body + CTA | scrubbed **180 d** after `finished_at`; the counts and the row are kept indefinitely as the audit record that a message was sent | `host.retention.sweep` → `broadcast_content` |
| `host_exports` rows | **90 d** from `requested_at` | `host.retention.sweep` → `host_exports` |
| host export OBJECTS | **24 h** (`HOST_EXPORT_TTL_HOURS`); objects are deleted BEFORE their rows | `host.export.reap` |
| `event_metrics_daily` | **never** — aggregates with no identifier of any kind, and the only long-run record a host has | — |
| `broadcast_unsubscribes`, `email_suppressions` | **indefinite, deliberately** — a suppression list that expires re-enables mailing someone who said stop (same reasoning as `sms_opt_outs`) | — |

### Donations, eligibility and legal

| Table | Rows deleted | Source schema |
|---|---|---|
| `donations` | **none, ever.** Contact columns (`donor_email`, `donor_name`) NULLed at `charged_at + 7y` | `schema/donations.ts` |
| `donation_refunds` / `donation_disputes` | none, ever | `schema/donation_refunds.ts` |
| `stripe_events` | deleted at `received_at + 400d` | `schema/stripe_events.ts` |
| `org_eligibility_checks` | deleted at the per-row `retention_until` (7 y; 10 y OFAC) | `schema/org_eligibility_checks.ts` |
| `eligibility_source_revisions` | deleted at `retention_until`, **object before row** | `schema/eligibility_source_revisions.ts` |
| `consent_records` | none, ever | `schema/consent_records.ts` |
| `legal_documents` | none, ever | `schema/legal_documents.ts` |

⚠ **The media-worker orphan sweep must never reap `receipts/` or `compliance/`.**
Neither prefix has `media_assets` rows, so today's row-driven reaper cannot reach
them — but a prefix-listing reaper would silently destroy issued receipts and
§8.01 eligibility evidence. Any change to that sweep must exclude both prefixes
explicitly.

## What binds a media asset (the orphan sweep's exemption set)

The media-worker `orphan.sweep` deletes every `media_assets` row nothing points
at once it is older than `MEDIA_ORPHAN_TTL_MS` (6h by default), together with its
R2 upload, served and thumbnail objects. "Nothing points at it" is one
definition, in `src/services/media-bindings.ts`, and the sweep
(`orphanPredicate`), the claim helpers (`claimEventMediaInTx`,
`claimVerificationDocumentsInTx`, `savePage`) and the media view authorizer
(`authorizeEventBound`) all read it from there, so an asset can never be
reapable and servable at the same time.

The bindings are:

| Binding | Where |
| --- | --- |
| `media_assets.report_id` / `chat_message_id` / `post_id` | columns on the asset itself |
| `users.avatar_media_id` | profile photo |
| `chat_groups.avatar_media_id` | group photo |
| `organizations.logo_media_id` | org logo |
| `cleanups.cover_media_id`, `cleanups.gallery_media_ids` | event imagery |
| `cleanup_page_media (cleanup_id, media_id)` | images embedded in a signup page's blocks |
| `purpose = 'verification'` | operator-only documents, exempt by purpose |

`cleanup_page_media` (0123) exists because `cleanup_pages.blocks` is a jsonb
document: an image referenced only from inside a block has no joinable reference,
and a jsonb containment scan over every page is not something an hourly reaper may
run. `savePage` rewrites that set on every save, so dropping a block drops the
binding and the image becomes reapable again on the normal schedule.

A verification document dropped from a re-submission has its `purpose` cleared
back to `'report'` in the same transaction, so it returns to the reapable set
instead of being exempt forever.
