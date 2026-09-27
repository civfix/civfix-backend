# Volunteer-hours integrity (civfix-backend)

**Audience:** internal (engineering + operators). Not served publicly.
**Last updated:** 2026-09-26 (operators credit and void hours from the admin console; see
"Operator credits and voids". A host re-save only rewrites rows it changes, and re-crediting a
voided row revives it; see "Re-saving and voided rows").

Volunteer hours are the input to `POST /v1/me/volunteer-hours/certificates`, which mints a signed,
publicly verifiable PDF transcript that residents hand to schools and courts. Hours are supplied by
a human host, not derived from any device signal, so the honesty of that document rests entirely on
the rules below.

## The gap this closes

Before this change the only anti-inflation control was **"another host must credit you"** — a host
could not credit themselves. Two ordinary accounts satisfy that for each other:

1. A creates an event scheduled an hour ago (backdating up to 24 h is allowed).
2. B joins; A promotes B to co-host.
3. A completes the event immediately (`scheduled_at <= now` was the only check).
4. B credits A 24 h; A credits B 24 h.
5. Repeat, bounded only by the 20/min create limit and the 10/min log limit.

Every step was legal, every hour landed on a transcript, and nothing was flagged.

## The rules now enforced

| # | Rule | Where | Effect when tripped |
|---|---|---|---|
| a | A credit is capped at the event's own window: `COALESCE(completed_at, ends_at) - scheduled_at` **+ 1 h grace**, never above `MAX_EVENT_HOURS` (24) | `volunteer-hours-rules.ts` (`creditableHoursForEvent`, `eventDurationMs`, checked by `assertCreditableEventHours`) | `VALIDATION` naming the event's real length |
| b | One person may hold at most **24 h across every event scheduled on the same local calendar day**, read in the event's own IANA zone (`cleanups.timezone`, falling back to `DEFAULT_EVENT_TIME_ZONE`), **plus every live manual adjustment whose `service_date` is that day** | `sameDayEventHours` and `hoursHeldOnServiceDate` (`volunteer-hours-credit.drizzle.ts`) and `assertWithinDailyHoursCap` (`volunteer-hours-rules.ts`), inside the crediting transaction under a per-user advisory lock | `CONFLICT` naming what they already hold |
| c | Reciprocity inside one event is refused **in both directions** — whoever credits second is the one refused (covers the organizer ↔ promoted-co-host swap) | same transaction | `CONFLICT` |
| d | Two anomaly signals are **flagged to moderation, never blocked**: >60 h credited in a rolling 7 days, and A↔B crediting each other on *different* events within 30 days | detected in the transaction, filed by `volunteer-hours-anomaly.ts` | an open `moderation_items` row, `kind = 'pattern'`, `subject_type = 'user'` |
| e | Hours can be logged only **once the event has ended** (`now >= ends_at`), and never against an event whose window is **shorter than 15 minutes** | `assertEventCreditable` in `volunteer-hours-rules.ts` (`hasEventEnded`, then the `MIN_EVENT_DURATION_MS` check) | `CONFLICT` |

Rule (e)'s 15-minute floor is really enforced at write time: `assertEventWindow`
(`host/event-fields.ts`) refuses any create or update whose `ends_at` is less than
`MIN_EVENT_DURATION_MINUTES` after `scheduled_at`, so no persisted event can have a
sub-15-minute window. The check inside `logEventHours` survives as a defensive
second gate for legacy rows written before that assertion existed.

**The denominator in rule (a) is fixed the moment the event ends.** Once
`deriveCleanupStatus` reads `done`, `updateCleanup` refuses any change to `ends_at`
(as it already refuses the date, title, location and type), so a host cannot widen
the window a credit is measured against after the fact — the status may never move
backwards from `done`, and the cap a transcript was printed under stays the cap. An
event still **underway** may extend `ends_at` (running late is legitimate), bounded
by `assertEventWindow`'s 15 minute / 24 hour duration limits.

Rule (b) is enforced with `pg_advisory_xact_lock` per credited user, taken in sorted order after the
per-event lock, so two hosts crediting the same attendee on two different events serialize instead of
both reading a stale sum. Sorted acquisition is what keeps a batch of concurrent credits deadlock-free.
Both locks are taken by `lockEventCredits` (`volunteer-hours-credit.drizzle.ts`), and the shared
upsert there, `writeEventCredits`, relies on the caller already holding them.

## Re-saving and voided rows

The host editor re-submits the whole sheet, so `logEventHours` is written to be idempotent per row:

- **An unchanged live row is not rewritten.** Same hours, same jurisdiction, not voided: the row
  keeps its `logged_by_user_id`, gets no `volunteer_hours_audit` entry, moves no rollup and rings
  no one. A co-host re-saving the sheet therefore never silently takes over another host's
  credits; changing a row's hours does, and that change is journaled with the co-host as actor.
- **A jurisdiction move is a change.** When the event now resolves to a different jurisdiction (or
  none), a re-save with the same hours takes them out of the old rollup and adds them to the new one.
- **A voided row holds 0 hours.** Every void path takes the row's hours out of
  `user_jurisdiction_hours` when it voids it (0065 did it by recompute), so a re-credit reads its
  previous value as `0` in no jurisdiction: the full hours go back into the rollup, the journal
  records `previous_hours = 0` (not `NULL`, which 0053 reserves for a genuine first credit, so the
  journal still shows the attendee was credited before), the attendee is notified because the
  hours went up, `voided_at` is cleared and `created_at` moves to the re-credit time.
- **A change or revival takes over the row's attribution whole.** `logged_by_user_id`, `note` and
  `credited_by_operator_id` (0182) come from the new write, and the previous void's
  `voided_by_operator_id` and `void_reason` are cleared, so a host correcting an operator's credit
  does not keep showing the operator's reason on a row the host now owns. `audit_log` and
  `volunteer_hours_audit` keep that history.

`credited` in the response still counts every entry the host submitted, so the host's
confirmation reads the same whether or not a row changed.

## Operator credits and voids

The admin console's Hours tab (DECISIONS §58 in the shared contract) is the one writer besides the
host sheet. It runs through `admin-user-hours-service.ts` and the repository methods
`creditEventAsOperator`, `creditManual` and `voidEntry`, each one transaction that writes its
`audit_log` row (`user.hours_credited` / `user.hours_voided`, actor = the operator, meta = entry,
hours and reason) before it commits.

- **`POST /v1/admin/users/:id/hours` with `kind: "event"`** credits a person who is not on the
  roster, typically someone who attended before they had the app. It obeys rules (a), (b) and (e)
  exactly as the host path does (the same `assertEventCreditable` / `assertCreditableEventHours`
  and the same locked daily-cap read); only roster membership is skipped. A live row for that
  person and event is a `CONFLICT`: the operator voids it first. The row is written through the
  shared `writeEventCredits` upsert with `logged_by_user_id` = the CivFix official account, so the
  user, the event, the public history and the leaderboard see "credited by CivFix"; the operator
  lands in `credited_by_operator_id` and in the `volunteer_hours_audit` journal as actor.
- **`kind: "manual"`** is work outside any event. The row has no `cleanup_id` and no
  jurisdiction, so it counts toward the person's total and toward no leaderboard, and it carries a
  `service_date`: required on manual rows and refused on every other source (the 0182 CHECK),
  on or after 2000-01-01 (the contract's floor), and never after today as read in
  `DEFAULT_EVENT_TIME_ZONE`. The service date is what dates the row on the ledger and on a
  transcript. Rule (b) counts manual rows on their `service_date` together with event rows on
  their local event day, so an operator adjustment cannot push a day past 24 h, in either order.
  A second identical manual credit (same person, hours, date and operator) within 60 s is a
  `CONFLICT`, which absorbs a double-submitted form.
- **`POST /v1/admin/users/:id/hours/:entryId/void`** is the "admin void path" and the only
  correction: entries are never edited in place, so a wrong credit is voided with a reason and a
  new one credited. The entry must belong to the account in the path (`NOT_FOUND` otherwise), a
  second void is a `CONFLICT`, and a retired `source = 'report'` row is never voidable. The void
  takes the hours out of `user_jurisdiction_hours` and, for an event row, journals
  `previous_hours = hours, new_hours = 0`. A host may credit the person again afterwards, which
  revives the row as described above.

Neither operator write runs rule (c) or the rule (d) detectors. Both exist to catch accounts
crediting *each other*; an operator credit is attributed to CivFix, which can be in no such
exchange, and the act is already an audited operator action with a written reason, so filing it to
the moderation queue that same operator works would add noise and no oversight. The operator's
reason and identity stay on the admin plane: no user-facing read and no data export carries
`note`, `void_reason` or either operator column.

## What the anomaly items look like

Both signals file through the ordinary moderation create path with `dedupeOpen: true`, so a repeatedly
tripping ledger escalates ONE open item rather than flooding the queue.

- `flag`: `Volunteer hours anomaly`
- `reason`: `volunteer_hours.weekly_threshold` or `volunteer_hours.reciprocal_credit` (stable machine
  keys — filter on these)
- `subject_id`: the **credited** user; `desc` carries the hours or the counterpart account id.

An anomaly never fails the credit that produced it: the hours are already committed, and a moderation
outage must not undo them (the failure is logged and suppressed).

## Known limits of these rules (accepted, bounded, and deliberately not closed)

None of these is a hole an attacker walks through — each is bounded by the other
rules — but each is a real edge, so it is written down rather than discovered later.

**Reciprocity is pairwise, so a 3-cycle passes both checks.** Rule (c) refuses
"X credits Y for this event when Y already credited X for this event", and the
cross-event detector (d) is the same pairwise shape. Three co-hosts crediting in a
ring — A→C, C→B, B→A — trip neither: no pair credits *each other*. What still binds
them is everything that is not about pairs: the per-attendee window cap (a), the
24 h/day cap (b), the 15-minute minimum (e), and the rolling 7-day flag (d),
which is per-person and does not care where the hours came from. So a ring can
still only mint what real events on real days can carry, and a ring running hot
lands in the moderation queue on the weekly signal. Closing it properly means
cycle detection over the credit graph (a recursive CTE to depth 3 inside the
crediting transaction, or an out-of-band sweep); that is a real query on a hot
path to buy a bound the caps already provide, so it is **not implemented**. If the
weekly signal starts firing on rings in practice, the cheap next step is to widen
the cross-event detector to depth 3 in the same `EXISTS` shape it already uses.

**The daily cap keys on the EVENT's `scheduled_at` date in the EVENT's own time
zone, not on a rolling window.** The date is `(scheduled_at AT TIME ZONE
COALESCE(cleanups.timezone, DEFAULT_EVENT_TIME_ZONE))::date`, so "the same day"
means the day the volunteers actually showed up rather than a UTC day that can
split a West Coast evening in half. Two overlapping events straddling that local
midnight can still credit one person 24 h on each side — 48 h inside roughly 47
wall-clock hours — and an event whose host left `timezone` null is read in the
platform default, which is wrong for a volunteer in another zone by at most the
offset between the two. Keying on the *credit* time instead would block a host
legitimately entering last month's events in one sitting. The residue is caught by
the weekly flag (48 h in two days is well inside a 60 h week, but a repeat of the
pattern is not).

**`users.last_activity_geom` is not cleared when its source report is deleted.**
The column is written on report/event create and on event completion, never on
delete, so a tombstoned report's point can outlive it. This is staleness in a
ranking input only: the value is **never served to any client** — it exists solely
to bound the follow-suggestions candidate scan — and it *is* nulled, with the rest
of the tombstone, when the account itself is erased (`auth/pg-stores.ts`). The next
report or event the user files overwrites it.

## Events from before migrations 0103 and 0168

`cleanups.completed_at` arrives in `0103` and is **not backfilled** — inventing a completion instant
would fabricate a fact that ends up printed on a government document. `0168` then made `ends_at`
NOT NULL and filled the rows that had none with `scheduled_at + 4 h`, the same
`DEFAULT_EVENT_DURATION_MS` a create applies when a host omits an end time.

So every row now has a window, and rules (a) and (e) apply to all of them: an old row without a
completion stamp is measured against its `ends_at`, which for a backfilled row is the declared
default rather than an observed fact. That default is the honest floor available — it never
claims more than four hours — and it is the only place in these rules where the denominator is a
convention rather than something a host chose.

Rules (b), (c) and (d) apply to them unchanged.

## Certificates

Issuance (`certificate-service.ts` → `entriesForCertificate`) already excludes `voided_at IS NOT NULL`
rows and `source = 'report'` rows. There is **no per-row "flagged" or "pending moderation" state** on
`volunteer_hours`, and none was added: a moderation signal is a suspicion about a pattern, not a verdict
on a row, and a silently-omitted row would make the printed total disagree with the ledger the holder
can see. The operator remedy for confirmed abuse is to void the rows from the admin console
(`POST /v1/admin/users/:id/hours/:entryId/void`), which removes them from every future certificate.
A certificate already issued is a frozen snapshot and keeps verifying with the old total, so the void
response lists the holder's live certificates whose snapshot itemised the entry
(`affectedCertificates`, read by `CertificateRepository.liveCodesListingEntry`). Revoking those stays
a deliberate, separate step: the holder can revoke their own
(`POST /v1/me/volunteer-hours/certificates/:code/revoke`), and an operator runs
`pnpm --filter @civfix/api db:certificate:revoke <code> --reason ledger_corrected`
(`services/api/scripts/revoke-certificate.ts`, `--dry-run` first). The console never revokes one.

## Configuration

The rolling-7-day flag threshold defaults to **60 h** (`WEEKLY_HOURS_FLAG_DEFAULT`) and is read from
`VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS`, injected into the service as `weeklyFlagHours`, so a deployment
can lower it without a code change. The daily cap
(`DAILY_HOURS_CAP`), the grace window (`EVENT_WINDOW_GRACE_MS`), the reciprocal lookback
(`RECIPROCAL_LOOKBACK_MS`) and the minimum duration (`MIN_EVENT_DURATION_MS`) are deliberately
constants: they are policy about what is physically possible, not per-deployment tuning.
