# Volunteer-hours integrity (civfix-backend)

**Audience:** internal (engineering + operators). Not served publicly.
**Last updated:** 2026-09-13 (0168: an event's status is a clock reading over
`scheduled_at`/`ends_at`, `cleanups.ends_at` is NOT NULL, and the retired
"mark completed" action is gone - so the window cap now falls back to `ends_at`
and the daily cap keys on the event's own time zone).

Volunteer hours are the input to `POST /v1/me/volunteer-hours/certificates`, which mints a signed,
publicly verifiable PDF transcript that residents hand to schools and courts. Hours are supplied by
a human host, not derived from any device signal, so the honesty of that document rests entirely on
the rules below.

## The gap this closes

Before this change the only anti-inflation control was **"another host must credit you"**: a host
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
| a | A credit is capped at the event's own window: `COALESCE(completed_at, ends_at) - scheduled_at` **+ 1 h grace**, never above `MAX_EVENT_HOURS` (24) | `volunteer-hours-service.ts` (`creditableHoursForEvent`, `eventDurationMs`) | `VALIDATION` naming the event's real length |
| b | One person may hold at most **24 h across every event scheduled on the same local calendar day**, read in the event's own IANA zone (`cleanups.timezone`, falling back to `DEFAULT_EVENT_TIME_ZONE`) | `volunteer-hours-repository.drizzle.ts`, inside the crediting transaction under a per-user advisory lock | `CONFLICT` naming what they already hold |
| c | Reciprocity inside one event is refused **in both directions**; whoever credits second is the one refused (covers the organizer ↔ promoted-co-host swap) | same transaction | `CONFLICT` |
| d | Two anomaly signals are **flagged to moderation, never blocked**: >60 h credited in a rolling 7 days, and A↔B crediting each other on *different* events within 30 days | detected in the transaction (`detectHoursAnomalies`, `volunteer-hours-repository.drizzle.ts`), filed after commit by `reportAnomalies` (`volunteer-hours-service.ts`) as the item `toHoursAnomalyModerationItem` (`volunteer-hours-anomaly.ts`) builds | an open `moderation_items` row, `kind = 'pattern'`, `subject_type = 'user'` |
| e | Hours can be logged only **once the event has ended** (`now >= ends_at`), and never against an event whose window is **shorter than 15 minutes** | `volunteer-hours-service.ts` (`hasEventEnded`, then the `MIN_EVENT_DURATION_MS` check in `logEventHours`) | `CONFLICT` |

Rule (e)'s 15-minute floor is really enforced at write time: `assertEventWindow`
(`host/event-fields.ts`) refuses any create or update whose `ends_at` is less than
`MIN_EVENT_DURATION_MINUTES` after `scheduled_at`, so no persisted event can have a
sub-15-minute window. The check inside `logEventHours` survives as a defensive
second gate for legacy rows written before that assertion existed.

**The denominator in rule (a) is fixed the moment the event ends.** Once
`deriveCleanupStatus` reads `done`, `updateCleanup` refuses any change to `ends_at`
(as it already refuses the date, title, location and type), so a host cannot widen
the window a credit is measured against after the fact: the status may never move
backwards from `done`, and the cap a transcript was printed under stays the cap. An
event still **underway** may extend `ends_at` (running late is legitimate), bounded
by `assertEventWindow`'s 15 minute / 24 hour duration limits.

Rule (b) is enforced with `pg_advisory_xact_lock` per credited user, taken in sorted order after the
per-event lock, so two hosts crediting the same attendee on two different events serialize instead of
both reading a stale sum. Sorted acquisition is what keeps a batch of concurrent credits deadlock-free.

## What the anomaly items look like

Both signals file through the ordinary moderation create path with `dedupeOpen: true`, so a repeatedly
tripping ledger escalates ONE open item rather than flooding the queue.

- `flag`: `Volunteer hours anomaly`
- `reason`: `volunteer_hours.weekly_threshold` or `volunteer_hours.reciprocal_credit` (stable machine
  keys; filter on these)
- `subject_id`: the **credited** user; `desc` carries the hours or the counterpart account id.

An anomaly never fails the credit that produced it: the hours are already committed, and a moderation
outage must not undo them (the failure is logged and suppressed).

## Known limits of these rules (accepted, bounded, and deliberately not closed)

None of these is a hole an attacker walks through (each is bounded by the other
rules), but each is a real edge, so it is written down rather than discovered later.

**Reciprocity is pairwise, so a 3-cycle passes both checks.** Rule (c) refuses
"X credits Y for this event when Y already credited X for this event", and the
cross-event detector (d) is the same pairwise shape. Three co-hosts crediting in a
ring (A→C, C→B, B→A) trip neither: no pair credits *each other*. What still binds
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
midnight can still credit one person 24 h on each side (48 h inside roughly 47
wall-clock hours), and an event whose host left `timezone` null is read in the
platform default, which is wrong for a volunteer in another zone by at most the
offset between the two. Keying on the *credit* time instead would block a host
legitimately entering last month's events in one sitting. The residue is caught by
the weekly flag (48 h in two days is well inside a 60 h week, but a repeat of the
pattern is not).

**`users.last_activity_geom` is not cleared when its source report is deleted.**
The column is written on report create and event create (`touchUserActivity`,
`db/sql/user-activity.ts`), never on delete, so a tombstoned report's point can
outlive it. This is staleness in a
ranking input only: the value is **never served to any client** (it exists solely
to bound the follow-suggestions candidate scan), and it *is* nulled, with the rest
of the tombstone, when the account itself is erased (`auth/pg-stores.ts`). The next
report or event the user files overwrites it.

## Events from before migrations 0103 and 0168

`cleanups.completed_at` arrives in `0103` and is **not backfilled**: inventing a completion instant
would fabricate a fact that ends up printed on a government document. `0168` then made `ends_at`
NOT NULL and filled the rows that had none with `scheduled_at + 4 h`, the same
`DEFAULT_EVENT_DURATION_MS` a create applies when a host omits an end time.

So every row now has a window, and rules (a) and (e) apply to all of them: an old row without a
completion stamp is measured against its `ends_at`, which for a backfilled row is the declared
default rather than an observed fact. That default is the honest floor available (it never
claims more than four hours), and it is the only place in these rules where the denominator is a
convention rather than something a host chose.

Rules (b), (c) and (d) apply to them unchanged.

## Certificates

Issuance (`certificate-service.ts` → `entriesForCertificate`) already excludes `voided_at IS NOT NULL`
rows and `source = 'report'` rows. There is **no per-row "flagged" or "pending moderation" state** on
`volunteer_hours`, and none was added: a moderation signal is a suspicion about a pattern, not a verdict
on a row, and a silently-omitted row would make the printed total disagree with the ledger the holder
can see.

The remedy for confirmed abuse is to void the rows (`voided_at`), which removes them from every future
certificate and from every total, and to revoke any certificate already issued over them. **Neither has
an operator path in the API today.** No route or service sets `volunteer_hours.voided_at` (the only
writers are migration `0065_void_report_volunteer_hours.sql` and the in-memory test repository), so
voiding is a hand-run SQL `UPDATE`. `POST /v1/me/volunteer-hours/certificates/:code/revoke` revokes only
the caller's own certificate (`WHERE user_id = ${userId}` in `certificate-repository.drizzle.ts`, reason
`holder`). There is deliberately no admin HTTP route for either; revoking a certificate the holder will
not revoke is the operator CLI `pnpm --filter @civfix/api db:certificate:revoke <code> --reason issued_in_error`
(run `--dry-run` first), which records an operator reason and deletes the stored PDF. Never hand-edit the
certificate row. The procedure is in `docs/operator-runbook.md` §1b.

## Configuration

The rolling-7-day flag threshold defaults to **60 h** (`WEEKLY_HOURS_FLAG_DEFAULT`) and is read from
`VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS`, injected into the service as `weeklyFlagHours`, so a deployment
can lower it without a code change. The daily cap
(`DAILY_HOURS_CAP`), the grace window (`EVENT_WINDOW_GRACE_MS`), the reciprocal lookback
(`RECIPROCAL_LOOKBACK_MS`) and the minimum duration (`MIN_EVENT_DURATION_MS`) are deliberately
constants: they are policy about what is physically possible, not per-deployment tuning.
