# Mail effects and the outbound send triad

**Audience:** internal (engineering). Not served publicly.
**Last updated:** 2026-09-22 (sender authentication policy; unauthenticated token replies file as unaffiliated).

An inbound message that correlates to a mail thread can drive **public** effects: a report status
transition, a public `report_timeline` row, a report-chat system message, and a push to the reporter.
This documents how those run exactly once, and the one residual that is knowingly accepted.

## Which messages may drive effects

`readMailAuthVerdict` (`services/api/src/adapters/inbound-mail.cf.ts`) reduces a message's
authentication to `pass`, `fail` or `unknown`. The email Worker applies no filter; this is the only gate.

- Only the **top-most** `Authentication-Results` header is read, and only when its authserv-id is
  `mx.cloudflare.net` (`CLOUDFLARE_AUTHSERV_ID`), the stamp Cloudflare Email Routing prepends. Copies
  below it are sender-supplied and ignored. Any other top-most header, or none, is `unknown`.
- The stamp repeats values the sender controls (the SMTP HELO and MAIL FROM, echoed in the SPF results
  and their comments), so it is read fail-closed. It is `fail` when it holds a backslash, a `"` other
  than a quoted `smtp.remote-ip`, a nested or unbalanced comment, a result that repeats a property, or
  more than one dmarc result. Comments are dropped, and every result must then be a bare `method=result`
  followed only by `ptype.property=value` tokens (or be empty or `none`); anything else is `fail`.
- `dmarc=pass` counts only when its `header.from` equals the parsed From domain. `dmarc=fail`, and any
  result other than the no-policy ones below, is `fail`. A dmarc result written after an SPF result
  that carries `smtp.helo` or `smtp.mailfrom` is `fail`: Cloudflare writes DKIM, then DMARC, then SPF.
- With no DMARC policy (`dmarc=none`, `temperror`, `permerror`, or no dmarc result), a `dkim=pass` whose
  `header.d` aligns with the From domain passes, else an `spf=pass` whose `smtp.mailfrom` domain aligns
  with it. Only the DKIM results the stamp opens with count. SPF counts only when `smtp.mailfrom`
  appears exactly once in the whole header, as the only property of that SPF result, holding a single
  `local@domain` address, with nothing after that result but at most one `arc` result.
- Aligned means the same organizational domain under the Public Suffix List (`tldts`, private
  suffixes included), as DMARC relaxed alignment defines it. A From domain that is itself a public
  suffix (`org`, `co.uk`) has no organizational domain and is `fail`. `isJurisdictionSender` compares
  the From domain with the thread's contact the same way.
- A message with more than one `From` header or address has no parsed From. It never threads and goes
  to the Inbox.

`processInboundObject` (`services/api/src/services/admin/inbound-processor.ts`) then routes:

| Verdict | Addressed to a thread token | Matches a thread only by In-Reply-To/References | No thread |
|---|---|---|---|
| `pass` | threaded; effects run when `isJurisdictionSender` holds | threaded; same | Inbox |
| `fail` / `unknown` | threaded as **unaffiliated**: operator-visible, no public effects | Inbox | Inbox |

The verdict is kept with the message: `meta.authVerdict` on the thread's `delivered` event, and the
`x-civfix-auth-verdict` header on an Inbox row.

## Stage 2 publishes the city's reply text (product decision)

The `report_timeline` row (stage 1) and the reporter's push (stage 3) still carry **fixed copy only** —
`JURISDICTION_REPLY_NOTE` and `JURISDICTION_REPLY_NOTIFICATION_BODY`. Stage 2 is the exception: the
report-chat system message now carries the city's own words in its `body`, so residents read the reply
in the report chat rather than waiting for an operator to relay it. The reporter's push says "See their
reply in the report chat."

**The disclosure and the publication ship in the same delivery.** Publishing the reply text is only
defensible if the city was told, and the sentence that tells them lives in the contract's
`DEFAULT_FORWARD_BODY_TEMPLATE`, not in this repo: from `@civfix/shared` **0.53.0** the default outbound
packet body ends with "replies to this email are made public at `https://civfix.org/pin/{reportId}`".
This repo adopts 0.53.0 in the same change that turns on stage 2, so no packet sent by this code
publishes a reply without having disclosed it. An operator who has overridden the body template in
forward-template settings owns that copy: the override replaces the default wholesale, so a custom
template that drops the sentence sends an undisclosed packet.

**Accepted residual — retroactive publication of pre-0.53.0 threads.** Mail threads opened before this
delivery were sent under the older default copy, which promised operator-only handling. A city reply
arriving on one of those existing threads is published into the report chat anyway: correlation keys off
the thread, and nothing records which template revision a packet was rendered from. Those cities were
told their reply went to operators and it now reaches residents. This is knowingly accepted rather than
fixed — suppressing it would mean stamping a template revision on every historical
`mail_messages`/`mail_threads` row and gating stage 2 on it, and the alternative of not publishing at all
defeats the feature. The exposure decays as old threads go quiet.

What reaches the chat is `cityReplyChatBody(message.body)`
(`services/api/src/services/admin/inbound-thread-correlation.ts`): the **stored plain-text** body (an
HTML-only reply was already flattened by `htmlToText` before it was stored), conservatively stripped of
quoted history, whitespace-trimmed, and clipped to `MESSAGE_BODY_MAX` (2000) so it passes chat
validation. The clip is grapheme-safe (`clipToMessageBody` walks `segmentGraphemes` from
`@civfix/shared` and stops before the code-unit budget), so the cut can never split a surrogate pair or
a combining sequence and leave invalid text in the chat. The strip is deliberately conservative and is
unit-tested; a line is a cut point when it is:

- a Gmail-style attribution — `/^On\s.+\swrote:$/`, anchored at the end so prose like "On Tuesday our
  crew wrote: see below" is not mistaken for one;
- an Outlook separator — `-----Original Message-----`, tolerant of the dash count;
- an unquoted Outlook header block — `/^From:\s.+$/` followed within two lines by `Sent:`, `Date:` or
  `To:`.

Everything from the first cut point onward is dropped, then a trailing run of `>`-prefixed (or blank)
lines is dropped. A non-trailing quote is kept — a reply that quotes and then answers keeps both halves.

If the result is empty (a reply that was nothing but quoted history), stage 2 falls back to the previous
behavior: the note only, with `body: null`.

The chat emitter is injectable (`InboundEffectDeps.chatEmitter`, plumbed through
`InboundProcessorDeps`), so the stage is observable in the unit suite without a database.

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

Stage 2 builds its emitter with `propagateInsertFailure`: a failed chat insert throws, so the stage stays
at 1 and the sweep retries it. A broadcast or push failure after the row exists is logged and the stage
advances, because retrying would post the reply into the chat twice. Every inbound failure is logged with
its R2 key or message id: parse and park failures, correlation lookups (the object stays in
`inbound/pending/` for the sweep instead of falling into the Inbox), and the sweep's per-object and
re-drive errors.

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
- It can only ever **duplicate one already-published entry**. The timeline row and the push carry fixed
  copy, so a repeat there leaks nothing; a repeated stage 2 posts the same city reply into the same report
  chat a second time — visible noise, never new disclosure.
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
