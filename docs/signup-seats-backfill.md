# Signup-seat backfill (civfix-backend)

**Audience:** internal (engineering + ops). Not served publicly.
**Last updated:** 2026-09-13 (DECISIONS §44: a sign-up on a non-ticketed event is a free registration).

## Why this exists

The host surfaces are keyed on **registration seats**, not on membership:
`GET /cleanups/:id/registrations` (the host "Attendees" roster), the check-in
scanner and manual check-in, the live counters, the insights seat rollups, the
no-show sweep, `getMyEventTicket`, and the `all_registered` broadcast lane all
read `cleanup_registrations` / `cleanup_registration_seats`.

A sign-up on an event with **no ticket types** used to write only a
`cleanup_members` row (plus a `cleanup_slot_claims` row when a slot was picked).
The result on every slot-based event was an empty host roster, zero counters, no
attendee ticket, and no way to check anyone in.

Sign-ups now mint a **free one-seat registration** in the same transaction as the
membership upsert (`ensureSignupRegistrationIn` in
`services/api/src/services/cleanup-repository.drizzle.ts`), and leaving or being
removed cancels it (`cancelSignupRegistrationIn`, which matches the attendee's
active registration on `ticket_type_id IS NULL`). Ticketed events are untouched:
minting is gated on the event having no ticket types, and the cancel can never
reach a ticketed registration, which still goes exclusively through `registerIn`
and `removeRegistration`.

Events that already had members when that shipped still have none of those rows.
This CLI mints them.

## Why a CLI and not a migration

`cleanup_registration_seats.ticket_token_hash` is
`sha256(base32(hmac(TICKET_TOKEN_SECRET, seat_id)))`. Postgres cannot compute it
without the ticket secret being in the database, which is precisely what the seat
design avoids (see `drizzle/0116_cleanup_registrations.sql`). So the hash is
computed in Node with `makeTicketTokenSigner(env.TICKET_TOKEN_SECRET)` and the
rows are written from outside the migration runner.

## Running it

```sh
# rehearse: writes one batch inside a transaction, verifies, ROLLS BACK
DATABASE_URL=postgres://... pnpm --filter @civfix/api db:backfill:signup-seats

# commit, batching until the candidate set is empty
DATABASE_URL=postgres://... pnpm --filter @civfix/api db:backfill:signup-seats -- --yes

# smaller batches (default 500 rows per transaction)
DATABASE_URL=postgres://... pnpm --filter @civfix/api db:backfill:signup-seats -- --yes --batch 200
```

On the box the built entrypoint is `pnpm start:backfill:signup-seats`
(`node dist/db/backfill-signup-seats.js`), same flags. `TICKET_TOKEN_SECRET` must
be the environment's real secret; a seat minted under a different secret can
never be scanned.

It is an ordinary post-deploy step, not part of the `migrate` one-shot: run it
once per environment after the release that carries §44 is healthy. It touches no
public data and needs no downtime.

## Scope and safety

Candidates are `cleanup_members` rows where:

- the row is any `cleanup_members` row, **organizer included**. The live path has
  no role test: `claimSlot` runs `ensureSignupRegistrationIn` for whoever claims a
  shift, so an organizer who claims their own gets a seat, and
  `0169_default_event_slot.sql` already gave every member of a board-less open
  event (organizers among them) a claim on the seeded default slot. Excluding
  organizers here would leave the host of a slot-based event off their own roster
  while every organizer who claims a shift after the release is on it. The rule is
  therefore plain membership: every non-guest member of a qualifying event gets one
  seat;
- the event is **not cancelled** and **has not ended** (`ends_at > now()`); a
  finished event's roster is history, and minting seats into it would resurrect
  the no-show sweep's candidate set;
- the event has **zero ticket types**;
- the member holds **no active registration**.

Each batch is one transaction. The insert carries the same
`ON CONFLICT (cleanup_id, user_id) WHERE status = 'registered' AND user_id IS NOT NULL
DO NOTHING` arbiter the runtime path uses, and the seat row is written only for the
registrations that actually landed, so the CLI is safe to re-run and safe to run
while the API is serving traffic. `registered_at` and the seat's `created_at` are
taken from `cleanup_members.joined_at`, so the roster keeps its real ordering.

Rehearsal mode writes exactly one batch and rolls it back, which is enough to prove
the arbiter resolves and every CHECK passes against the live schema. The counts it
reports are the real ones: `seats=` is the number of seat rows the transaction
actually wrote before the rollback, not the number of candidates it scanned.

## Where the seat write sits in the lock order

`drizzle/0116_cleanup_registrations.sql` fixes the binding order for every writer:
`cleanups -> cleanup_members -> cleanup_guests -> cleanup_registrations ->
cleanup_registration_seats -> cleanup_answers -> cleanup_waitlist ->
cleanup_ticket_types -> cleanup_slots -> cleanup_slot_claims`. The three touched
transactions keep `cleanup_registrations` on the same side of
`cleanup_slot_claims` and `cleanup_bans` as `registerTx` and `removeRegistration`
already do, so nothing inverts against them:

| Transaction | Order |
|---|---|
| `joinCleanupTx` | cleanups (FOR SHARE) -> cleanup_members -> registrations -> seats |
| `claimSlot` | cleanups (FOR SHARE) -> cleanup_slots (FOR UPDATE) -> cleanup_members -> registrations -> seats -> cleanup_slot_claims |
| `leaveCleanup` | cleanups (FOR SHARE) -> cleanup_members -> registrations -> seats -> cleanup_slot_claims |
| `removeMember` | cleanups (FOR NO KEY UPDATE) -> cleanup_members -> registrations -> seats -> cleanup_bans -> cleanup_slot_claims |

`claimSlot` takes `cleanup_slots (FOR UPDATE)` BEFORE `cleanup_members`, ahead of
the registration and the seat. Slots-before-members is not new and not an
inversion introduced here: it is the exception `0063_cleanup_slots.sql` already
documents for the auto-RSVP, because the capacity decision has to be made under the
slot lock and neither the membership row nor the seat may be written on a
`slot_not_found` / `full` refusal (`sql.begin` commits on a normal return). The
seat write therefore comes AFTER those refusals and BEFORE the slot claim, so a
concurrent `registerIn(slotId)` for the same person (which goes registration
first, slot claim second) cannot form an ABBA cycle with it.

The `cleanup_ticket_types` probe is an unlocked `SELECT` and takes no row lock of
its own, but it is not racy either: every minting transaction already holds the
`cleanups` row `FOR SHARE` when it runs, and `createTicketType` takes that same row
`FOR NO KEY UPDATE`, which conflicts with `FOR SHARE`. A ticket type therefore
cannot be created in the window between the probe and the seat insert: the two
transactions serialize on the `cleanups` row. Cancellation does not depend on the
probe at all: `cancelSignupRegistrationIn` discriminates on the REGISTRATION row
(`ticket_type_id IS NULL`), the exact shape the sign-up path mints, so a host who
adds a ticket type after plain sign-ups exist cannot leave a departed or removed
attendee holding an active seat and a scannable token, and a genuinely ticketed
registration is never cancelled by a plain leave.

## Retention

The rows this creates are ordinary registration rows and inherit the schedules in
`docs/retention-cleanup.md` and `drizzle/0116_cleanup_registrations.sql`:
`attendee_name` (always NULL here) at 30 days post-event, `checked_in_at` coarsened
to the day at 30 days, `host_note` (never set here) at 90 days.
