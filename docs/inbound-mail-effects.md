# Mail effects and the outbound send triad

**Audience:** internal (engineering). Not served publicly.
**Last updated:** 2026-09-23 (a thread in review stays there while it holds a withheld reply, whatever reply settles it, an operator's included; Mark replied keeps the reply dismissed; the stripped-reply audit row is written once; an attempt with no outcome yet counts as in flight; bounce bookkeeping and its completion marker).

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
  to the Inbox, whose row shows every claimed sender joined with commas, for display only.

`processInboundObject` (`services/api/src/services/admin/inbound-processor.ts`) first drops our own
outbound mail looping back (a Message-ID of the `<out-…@MAIL_FROM_OUTREACH domain>` shape, or a From that
is one of our reply addresses) with a warning. It reads a thread token from the To addresses, then Cc,
matched case-insensitively on `MAIL_REPLY_DOMAIN`. It then routes:

| Verdict | Addressed to a thread token | Matches a thread only by In-Reply-To/References | No thread |
|---|---|---|---|
| `pass` | threaded; effects run when `isJurisdictionSender` holds | threaded; same | Inbox |
| `fail` / `unknown` | threaded as **unaffiliated**: operator-visible, no public effects | Inbox | Inbox |

The verdict is kept with the message: `mail_messages.auth_verdict` on a threaded reply (migration `0181`
filled it for earlier replies from `meta.authVerdict` on their `delivered` event), and the
`x-civfix-auth-verdict` header on an Inbox row.

## A withheld reply waits for an operator

An unaffiliated reply on a thread linked to a report or event is **withheld**. It is stored with its
verdict and applies no public effect, and the same insert sets the thread to `needs_action`, so it shows
under the Mail list's attention filter. A warning logs the sender's domain, never the address.

A delivered outbound message clears a send failure's `needs_action` back to `sent`, but not while the
thread still holds a withheld reply (`hasWithheldReply`): a resend, a follow-up or a resident's @city
forward would otherwise drop the reply out of review. A thread with no report or event has nothing
public to publish to, so an unaffiliated reply there is stored without the flag.

A reply whose effects run, verified or published, settles the thread last (stage 4,
`settleRepliedThread`), and an operator's reply settles it the same way once it is delivered
(`settleThreadStatus`). The thread stays `needs_action` when it is already `needs_action` and still
holds a withheld reply; otherwise it becomes `replied`. Both are read under a lock on the thread row, in
one transaction (for an inbound reply, the one that records the stage), so a later verified reply, an
operator's reply, or publishing one of two withheld replies leaves the thread in review. The rule only
keeps a thread in review, it never puts one back: **Mark replied** is how an operator turns a withheld
reply down without publishing it, so a thread already set to `replied` stays `replied` and the reply
stays dismissed, whatever reply settles it next.

An operator publishes a withheld reply with `publishMailReply`
(`POST /admin/mail/:id/messages/:messageId/publish`: operator only, CSRF, 20 a minute per operator).
It is an explicit, audited override of the affiliation gate. One transaction clears `unaffiliated` and
writes a `mail.reply_published` audit row naming the operator (with the sender's domain, never the
address); then exactly the effects a verified reply gets run, under the same lease. Only an inbound
message of that thread qualifies (404 otherwise), and a thread with no report or event is refused with
409. Publishing an already published reply is a no-op with no second audit row. When the effects fail,
or another runner holds the lease, the answer is `pending`: the cleared flag makes the reply eligible
for the sweep, which finishes it.

The same endpoint finishes a verified reply whose effects are still owed (`pending`, for instance after
a failed chat insert). When the operator's call is the run that completes the effects, the transaction
that marks them applied also writes a `mail.reply_published` row naming that operator, unless the reply
already has one from its approval. A reply therefore carries at most one such row however many
operators or retries publish it, and a reply the sweep finishes carries none.

## Stage 2 publishes the city's reply text (product decision)

The `report_timeline` row (stage 1) and the reporter's push (stage 3) still carry **fixed copy only**:
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

**Accepted residual: retroactive publication of pre-0.53.0 threads.** Mail threads opened before this
delivery were sent under the older default copy, which promised operator-only handling. A city reply
arriving on one of those existing threads is published into the report chat anyway: correlation keys off
the thread, and nothing records which template revision a packet was rendered from. Those cities were
told their reply went to operators and it now reaches residents. This is knowingly accepted rather than
fixed: suppressing it would mean stamping a template revision on every historical
`mail_messages`/`mail_threads` row and gating stage 2 on it, and the alternative of not publishing at all
defeats the feature. The exposure decays as old threads go quiet.

What reaches the chat is `cityReplyChatBody(message.body, MAIL_REPLY_DOMAIN)`
(`services/api/src/services/admin/inbound-thread-correlation.ts`): the **stored plain-text** body,
conservatively stripped of quoted history, whitespace-trimmed, and clipped to `MESSAGE_BODY_MAX`
(2000) so it passes chat validation. The clip is grapheme-safe (`clipToMessageBody` walks
`segmentGraphemes` from `@civfix/shared` and stops before the code-unit budget), so the cut can never
split a surrogate pair or a combining sequence and leave invalid text in the chat. The strip is deliberately conservative and is
unit-tested.

The stored body is the message's `text/plain` part. The adapter parses with mailparser's
`skipHtmlToText`, so an HTML-only reply is flattened by our own `htmlToText`
(`services/api/src/services/admin/mail-preview.ts`) before it is stored: block elements break lines,
`<blockquote>` lines get a `> ` prefix, images are dropped, and an `http(s)` link keeps its target in
parentheses; `<pre>` keeps its own line breaks. The Inbox stores the same text for an HTML-only message.

A line is a cut point when it is:

- an attribution (`On … wrote:`, `El … escribió:`, `Am … schrieb …:`, `Le … a écrit :` or
  `2026년 … 작성:`), anchored at the end so prose like "On Tuesday our crew wrote: see below" is not
  mistaken for one. Up to three lines are joined when the joined text holds an `@`, because Gmail
  wraps a long attribution. The join stops only at a line where another attribution begins, so a reply
  line starting with `On`, `El`, `Am` or `Le` right above one is kept, while a wrapped sender name that
  starts with one of those words still joins;
- a separator line: Outlook's `-----Original Message-----` or Gmail's
  `---------- Forwarded message ---------`, tolerant of the dash count;
- an unquoted Outlook header block: `/^From:\s.+$/` followed within two lines by `Sent:`, `Date:` or
  `To:`;
- any line holding one of our own mail identifiers: a thread reply address (`report-`, `reply-` or
  `event-` plus a token, on `MAIL_REPLY_DOMAIN`) or an outbound Message-ID (`out-<uuid>@…`). Every
  quoting style repeats our From address or Message-ID in its attribution or header block, so this cut
  holds for a client or language the patterns above miss, and no reply address reaches the chat.

Everything from the first cut point onward is dropped, then a trailing run of `>`-prefixed, blank or
separator (`___`, `---`) lines is dropped. A non-trailing quote is kept (a reply that quotes and then
answers keeps both halves) unless it holds one of our identifiers.

If the result is empty (a reply that was nothing but quoted history), stage 2 falls back to the previous
behavior: the note only, with `body: null`. When the stored body had text and the strip removed all of
it, for instance a one-line reply that mentions our reply address, the thread ends at `needs_action`
instead of `replied` and a `mail.reply_published_without_text` audit row with no actor records it, so an
operator can see that the city's words did not reach the chat and relay them. The row is written in the
stage 4 transaction, so a re-drive after a crash never writes a second one. Like a send failure's, this
flag clears on the thread's next delivered outbound message.

The chat emitter is injectable (`InboundEffectDeps.chatEmitter`, plumbed through
`InboundProcessorDeps`), so the stage is observable in the unit suite without a database.

## Why this is not a boolean

The message insert is deduped on `message_id`, so re-delivering the `.eml` after a failure only ever
produces a `replay`. Firing the effects with `.catch(() => {})` after that insert therefore lost the
status transition and the reporter notification permanently: no retry, no log.

The columns on `mail_messages` (migration `0100`) are a **lease**, not a flag:

| Column | Meaning |
|---|---|
| `effects_claimed_at` | A runner holds the message. **Reclaimable**: the sweep re-drives any claim older than `EFFECTS_LEASE_MS` (10 min). A process death between claim and completion (a deploy restart, OOM, the drain watchdog) must not strand the row, which is the exact failure the re-drive exists to prevent. |
| `effects_applied_at` | Set **only** on completion. `IS NULL` is the "still owed" set the partial index serves; the lease comparison stays in the query because `now()` is not `IMMUTABLE`. |
| `effects_stage` | How far the ordered pipeline got: `0` none, `1` timeline, `2` chat, `3` reporter notified, `4` thread settled. An event reply goes from `1` to `4`. A re-drive resumes from here. |

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
and re-drive it at stage 0: a second "The city responded to this report" timeline row, another chat
system message, another push, and thread status forced back to `replied` over a closed or bounced thread,
100 per run until drained. Migration `0100` therefore ends with a one-shot idempotent settle
(`effects_applied_at = COALESCE(effects_applied_at, created_at), effects_stage = 3` for every inbound row
still NULL): their effects already ran under the old fire-and-forget path.

## Accepted residual: the stage write is not in the effect's transaction

Each stage is recorded by a separate `setMessageEffectsStage` UPDATE **after** the effect it describes
commits. A crash in the gap between an effect committing and its stage write means the re-drive repeats
that one step once, most visibly a duplicate "The city responded to this report" timeline row.

**This is accepted rather than fixed.** Closing it needs the effect and its marker in one transaction,
i.e. the marker living on the effect's own row: `report_timeline` has no `meta`/jsonb column
(`drizzle/0001_core.sql`, `src/db/schema/timeline.ts`: `id, report_id, status, note, kind, body,
actor_id, created_at`), so it would take DDL on a table this slice does not own, plus a matching marker
on the report-chat message and the notification rows.

The exposure is bounded and one-sided:

- The window is a single UPDATE, not a network call, orders of magnitude smaller than the
  claim-to-completion window the lease exists for.
- It can only ever **duplicate one already-published entry**. The timeline row and the push carry fixed
  copy, so a repeat there leaks nothing; a repeated stage 2 posts the same city reply into the same report
  chat a second time: visible noise, never new disclosure.
- It cannot skip a step: the stage is only ever advanced after the effect committed, so the failure mode
  is "at least once", never "never".

If `report_timeline` later gains a `meta` jsonb for another reason, the fix is to stamp the mail message
id into the row and make the timeline/chat/notify steps no-op when that marker is already present.

## Bounces: bookkeeping and its completion marker

A delivery status notification (`detectBounce` in `services/api/src/services/admin/inbound-bounce.ts`:
a `mailer-daemon@` or `postmaster@` sender, a `report-type=delivery-status` content type, or an
`X-Failed-Recipients` header) is stored in the Inbox and then runs `handleBounce`. It acts only when the
DSN names both a failed recipient and an original Message-ID, the sender passes
`isPlausibleBounceSender`, and the Message-ID maps to a thread that actually sent to that recipient. It
then, in order:

1. sets the thread status to `bounced`;
2. stamps `bounced_at` on the jurisdiction's `jurisdiction_contacts` rows for that address and enqueues
   `jurisdiction.discovery` for the geoid (when a geoid is known, from the thread or the contact);
3. writes the `bounced` mail event, with meta `{ failedRecipient, originalMessageId }`.

The `bounced` event is written **last** because it is the completion marker. When a step throws, the
object stays in `inbound/pending/` and the next sweep replays it; a replay runs `handleBounce` again,
which first asks `hasBounceEvent` (same thread, `type = 'bounced'`, same `originalMessageId`, same
`failedRecipient` ignoring case). With no marker it repeats the steps, all of which are safe to repeat.
With the marker it does nothing, so a duplicate delivery of a finished DSN cannot force a thread back to
`bounced` after an operator has changed its status.

A legacy `contact_emails` address has no `bounced_at` column, so the event's `failedRecipient` is what
marks it unusable: `legacyContactEmailUsable` skips an address with a `bounced` event on that
jurisdiction's threads newer than `contact_updated_at`, or with a bounced per-category row for the same
address. Discovery, the jurisdiction health probe behind `resolveForPoint` and the outreach digest all
apply it, and all ignore a per-category contact whose `bounced_at` is set. Saving the contact again moves
`contact_updated_at` past the old event, which makes a corrected address usable again.


---

# The outbound send triad: deadline, in-flight window, stale claim

Three timings govern one report route, and they are **one invariant**, not three constants. They live
together in `services/api/src/services/admin/outbound-send-policy.ts`, which both the outbound mail
service and the admin report repository import.

| Timing | What it bounds |
|---|---|
| **Send deadline** (`outboundSendDeadlineMs`) | Total wall clock for one delivery: a phase budget (`OCI_EMAIL_SMTP_TIMEOUT_MS × 3`, covering connect + greeting + socket, all of which are INACTIVITY timeouts and so bound nothing on a trickling relay) plus the payload's time at a floor throughput (`OUTBOUND_SEND_MIN_THROUGHPUT_BPS`, default 256 KiB/s). Clamped to `2^31 - 1` so it can never overflow `setTimeout`, which Node silently clamps to 1 ms. |
| **In-flight window** (`ROUTE_DEADLINE_INFLIGHT_SECONDS`, 900 s) | How long a `failed` event whose meta says `reason: "deadline"` counts as *still in flight* rather than as a delivery failure. |
| **Stale claim** (`ROUTE_CLAIM_STALE_SECONDS`, 900 s) | How long an outbound row with no `sent` and no `failed` event counts as in flight (reply, resend and re-route are refused) before it is treated as a crashed claim and becomes re-routable. |

## Why the deadline is not an abort

The `Mailer` seam exposes no cancellation, so the deadline is a `Promise.race`: the SMTP session stays
open and may still answer `250 OK`. A deadline expiry is therefore an **unknown outcome, not a
non-delivery**:

- The service attaches a continuation to the original send. A late fulfilment records `sent` with
  `late: true` and the real Message-ID (and runs the caller's `onLateSuccess`, which is how the report
  still advances to `acknowledged` with its timeline row and chat message). A late rejection leaves the
  recorded `failed` standing.
- `assertRoutable` refuses a re-route (409, `SEND_IN_FLIGHT_CONFLICT`) while the newest attempt is in
  flight, including the `retargeted` branch. `MailService.reply`/`resend` apply the same guard.
- `runAutoForwardWith` classifies the deadline error distinctly and does **not** retry it. Retrying would
  put a second packet in front of a government contact for a message that very likely sent.
- The operator sees a **409 CONFLICT** with "the send is still in progress", not a 500, so the console's
  existing conflict handling applies and the error tracker is not spammed for an expected outcome.

## Per-attempt, not per-thread

`send_failed` is decided from the **newest** `direction='out'` message's OWN events (joined on
`mail_events.message_id`), never thread-wide. Thread-wide, any earlier reason-less `failed` (attempt 1
connect timeout, say) satisfied the predicate and killed the in-flight guard for every later attempt.
The verdict is: a hard `failed` on the newest attempt → failed; a `deadline` failure inside the window →
in flight; any other `failed` → failed; no event and younger than the stale window → in flight; no event
and older than the stale window → crashed claim.

`sendInFlightExpr` (`services/api/src/services/admin/outbound-send-sql.ts`) is the in-flight half of that
verdict, read from the same newest attempt: no `sent` event, and either a `deadline` failure inside the
window or no `failed` event at all while the outbound row is younger than the stale window. The outbound
row is inserted before transmission starts, so an attempt with no outcome yet is a send still on the
wire, or one whose process died mid-send; the two cannot be told apart until the stale window passes.
Until then reply and resend (`MailService`, through `hasSendInFlight`) and re-route (`assertRoutable`,
through the report's `send_in_flight`) answer 409 `SEND_IN_FLIGHT_CONFLICT`. Once a `sent` or `failed`
event lands, or the row passes the stale window, the guard lifts and `sendFailedExpr` decides whether the
attempt reads as failed.

## Why misconfiguration fails closed

`assertOutboundSendPolicy` runs in `loadEnv`, so the process refuses to boot when the knobs would let one
send outlive the guard: `OUTBOUND_SEND_MIN_THROUGHPUT_BPS` must be ≥ 1024, `OCI_EMAIL_SMTP_TIMEOUT_MS`
must be ≤ 60 000, and the largest computable deadline, sized for `OUTBOUND_PAYLOAD_BUDGET_BYTES` (8 MiB)
after base64 expansion (+33%), far above any packet now that report media goes out as links rather than
attachments, must fit inside the 900 s window. At
the defaults that largest deadline is ≈ 88 s, comfortably inside it.

| Env var | Default | Notes |
|---|---|---|
| `OCI_EMAIL_SMTP_TIMEOUT_MS` | `15000` | Per-phase nodemailer timeout; also sets the phase budget (× 3). Must be ≤ 60 000. |
| `OUTBOUND_SEND_MIN_THROUGHPUT_BPS` | `262144` | Floor throughput sizing the transfer half of the deadline. Must be ≥ 1024, and must leave the largest packet inside the in-flight window. |
