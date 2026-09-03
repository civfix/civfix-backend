# Retention cleanup jobs (civfix-backend)

**Audience:** internal (engineering + ops). Not served publicly.
**Last updated:** 2026-06-20 (privacy/backend-hardening).

Backs the "written retention schedule + scheduled cleanup jobs" item in
`documents/21-privacy-compliance.md` §7.1 for the TTL-able auth artifacts that
previously accumulated forever (no existing path deleted them).

## What runs

A new `retention.sweep` cron in the **media-worker** (the same process that runs
`orphan.sweep` and `chat.partition.maintenance`) deletes expired rows from three
existing tables. **No new schema** — it only deletes already-expired rows.

| Table | Rows deleted | Source schema |
|---|---|---|
| `email_otps` | `consumed_at IS NOT NULL` OR `expires_at < cutoff` | `services/api/src/db/schema/otp.ts` |
| `anon_tokens` | `expires_at < cutoff` | `services/api/src/db/schema/anon.ts` |
| `sessions` | `expires_at < cutoff` | `services/api/src/db/schema/sessions.ts` |

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
  = `30 3 * * *` (daily, 03:30 UTC, off-peak).
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

FOLLOW-UP (not in this change): the drain query is `WHERE created_at < cutoff
LIMIT n`. At scale a `notifications(created_at)` index would help; the F089
`notifications_feed_idx` is `(user_id, created_at DESC, id DESC) WHERE type <>
…` and does not cover a bare `created_at` scan. Pre-launch tables are tiny, so
this is deferred, not blocking. The `DELETE /me` erasure cleanup step and the
`docs/erasure-behavior.md` row are owned by the users/erasure workstream.

UPDATE (H19, audit 2026-09) — the inflow side is now bounded too. Group/report
room activity used to write ONE row per member per message; a room fan-out now
happens at most once per `ROOM_ACTIVITY_COALESCE_WINDOW_MS` (10 min,
`services/api/src/services/chat-room-fanout-notifier.ts`) and a recipient keeps
ONE unread bell per room per window — later messages in the window UPDATE that
row's title/body via `refreshUnreadNotification` instead of inserting. The
message preview stored in `body` is therefore the LATEST message of the window
rather than one row per message; retention semantics and the 90-day TTL are
unchanged, but the volume the sweep has to drain is bounded by rooms×windows
instead of members×messages. Mention/reply/DM bells are NOT coalesced.

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
