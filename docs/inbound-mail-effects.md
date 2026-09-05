# Mail effects and the outbound send triad

**Audience:** internal (engineering). Not served publicly.
**Last updated:** 2026-09-03 (audit-fix pass).

An inbound message that correlates to a mail thread can drive **public** effects: a report status
transition, a public `report_timeline` row, a report-chat system message, and a push to the reporter.
This documents how those run exactly once, and the one residual that is knowingly accepted.

## Why this is not a boolean

The message insert is deduped on `message_id`, so re-delivering the `.eml` after a failure only ever
produces a `replay`. Firing the effects with `.catch(() => {})` after that insert therefore lost the
status transition and the reporter notification permanently — no retry, no log.

The columns on `mail_messages` (migration `0100`) are a **lease**, not a flag:

| Column | Meaning |
|---|---|
| `effects_claimed_at` | A runner holds the message. **Reclaimable**: the sweep re-drives any claim older than `EFFECTS_LEASE_MS` (10 min). A process death between claim and completion — a deploy restart, OOM, the drain watchdog — must not strand the row, which is the exact failure the re-drive exists to prevent. |
| `effects_applied_at` | Set **only** on completion. `IS NULL` is the "still owed" set the partial index serves; the lease comparison stays in the query because `now()` is not `IMMUTABLE`. |
| `effects_stage` | How far the ordered pipeline got: `0` none, `1` timeline, `2` chat, `3` reporter notified. A re-drive resumes from here. |

`applyInboundEffects` (`services/api/src/services/admin/inbound-thread-correlation.ts`) claims, runs the
stages it still owes, then calls `markMessageEffectsApplied`. On a throw it calls
`releaseMessageEffects`, which drops the claim but **keeps the stage**, so the next sweep resumes rather
than repeating.

## The pre-migration backfill

The pending predicate is `direction = 'in' AND effects_applied_at IS NULL` with no `created_at` floor.
Without a backfill, the first `inbound.sweep` after deploy would match **every historical inbound reply**
and re-drive it at stage 0 — a second "The city responded to this report" timeline row, another chat
system message, another push, and thread status forced back to `replied` over a closed or bounced thread,
100 per run until drained. Migration `0100` therefore ends with a one-shot idempotent settle
(`effects_applied_at = COALESCE(effects_applied_at, created_at), effects_stage = 3` for every inbound row
still NULL): their effects already ran under the old fire-and-forget path.

## Accepted residual: the stage write is not in the effect's transaction

Each stage is recorded by a separate `setMessageEffectsStage` UPDATE **after** the effect it describes
commits. A crash in the gap between an effect committing and its stage write means the re-drive repeats
that one step once — most visibly a duplicate "The city responded to this report" timeline row.

**This is accepted rather than fixed.** Closing it needs the effect and its marker in one transaction,
i.e. the marker living on the effect's own row: `report_timeline` has no `meta`/jsonb column
(`drizzle/0001_core.sql`, `src/db/schema/timeline.ts` — `id, report_id, status, note, kind, body,
actor_id, created_at`), so it would take DDL on a table this slice does not own, plus a matching marker
on the report-chat message and the notification rows.

The exposure is bounded and one-sided:

- The window is a single UPDATE, not a network call — orders of magnitude smaller than the
  claim-to-completion window the lease exists for.
- It can only ever **duplicate a body-less status entry**. No mail content is published (H6: the timeline
  row, the chat message and the push all carry fixed copy), so a repeat leaks nothing.
- It cannot skip a step: the stage is only ever advanced after the effect committed, so the failure mode
  is "at least once", never "never".

If `report_timeline` later gains a `meta` jsonb for another reason, the fix is to stamp the mail message
id into the row and make the timeline/chat/notify steps no-op when that marker is already present.


---

# The outbound send triad: deadline, in-flight window, stale claim

Three timings govern one report route, and they are **one invariant**, not three constants. They live
together in `services/api/src/services/admin/outbound-send-policy.ts`, which both the outbound mail
service and the admin report repository import.

| Timing | What it bounds |
|---|---|
| **Send deadline** (`outboundSendDeadlineMs`) | Total wall clock for one delivery: a phase budget (`OCI_EMAIL_SMTP_TIMEOUT_MS × 3`, covering connect + greeting + socket, all of which are INACTIVITY timeouts and so bound nothing on a trickling relay) plus the payload's time at a floor throughput (`OUTBOUND_SEND_MIN_THROUGHPUT_BPS`, default 256 KiB/s). Clamped to `2^31 - 1` so it can never overflow `setTimeout`, which Node silently clamps to 1 ms. |
| **In-flight window** (`ROUTE_DEADLINE_INFLIGHT_SECONDS`, 900 s) | How long a `failed` event whose meta says `reason: "deadline"` counts as *still in flight* rather than as a delivery failure. |
| **Stale claim** (`ROUTE_CLAIM_STALE_SECONDS`, 900 s) | How long an outbound row with NO event at all counts as in flight before it is treated as a crashed claim and becomes re-routable. |

## Why the deadline is not an abort

The `Mailer` seam exposes no cancellation, so the deadline is a `Promise.race`: the SMTP session stays
open and may still answer `250 OK`. A deadline expiry is therefore an **unknown outcome, not a
non-delivery**:

- The service attaches a continuation to the original send. A late fulfilment records `sent` with
  `late: true` and the real Message-ID (and runs the caller's `onLateSuccess`, which is how the report
  still advances to `acknowledged` with its timeline row and chat message). A late rejection leaves the
  recorded `failed` standing.
- `assertRoutable` refuses a re-route (409, `SEND_IN_FLIGHT_CONFLICT`) while the newest attempt is in
  flight — including the `retargeted` branch. `MailService.reply`/`resend` apply the same guard.
- `runAutoForwardWith` classifies the deadline error distinctly and does **not** retry it. Retrying would
  put a second multi-MB packet in front of a government contact for a message that very likely sent.
- The operator sees a **409 CONFLICT** with "the send is still in progress", not a 500 — so the console's
  existing conflict handling applies and the error tracker is not spammed for an expected outcome.

## Per-attempt, not per-thread

`send_failed` is decided from the **newest** `direction='out'` message's OWN events (joined on
`mail_events.message_id`), never thread-wide. Thread-wide, any earlier reason-less `failed` (attempt 1
connect timeout, say) satisfied the predicate and killed the in-flight guard for every later attempt.
The verdict is: a hard `failed` on the newest attempt → failed; a `deadline` failure inside the window →
in flight; any other `failed` → failed; no event and older than the stale window → crashed claim.

## Why misconfiguration fails closed

`assertOutboundSendPolicy` runs in `loadEnv`, so the process refuses to boot when the knobs would let one
send outlive the guard: `OUTBOUND_SEND_MIN_THROUGHPUT_BPS` must be ≥ 1024, `OCI_EMAIL_SMTP_TIMEOUT_MS`
must be ≤ 60 000, and the largest computable deadline — sized for `MAX_PACKET_TOTAL_BYTES` (8 MiB) after
base64 expansion (+33%, which is what actually crosses the wire) — must fit inside the 900 s window. At
the defaults that largest deadline is ≈ 88 s, comfortably inside it.

| Env var | Default | Notes |
|---|---|---|
| `OCI_EMAIL_SMTP_TIMEOUT_MS` | `15000` | Per-phase nodemailer timeout; also sets the phase budget (× 3). Must be ≤ 60 000. |
| `OUTBOUND_SEND_MIN_THROUGHPUT_BPS` | `262144` | Floor throughput sizing the transfer half of the deadline. Must be ≥ 1024, and must leave the largest packet inside the in-flight window. |
