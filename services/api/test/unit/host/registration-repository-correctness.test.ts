import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import {
  makeDrizzleHostRegistrationRepository,
  REGISTER_IDEMPOTENCY_SCOPE,
} from "../../../src/services/host/registration-repository.drizzle.js"
import { deterministicUuid } from "../../../src/services/deterministic-uuid.js"
import type {
  RegisterTxArgs,
  SeatDraft,
} from "../../../src/services/host/registration-repository.js"
import { WAITLIST_CLAIM_WINDOW_MS } from "../../../src/services/host/waitlist-service.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../../helpers/fake-sql.js"
import type { Sql } from "../../../src/db/client.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SLOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const HOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const TYPE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const REGISTRATION = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const WAITLIST = "abababab-abab-4bab-8bab-abababababab"
const GUEST = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
const NOW = new Date("2026-01-01T12:00:00.000Z")
const HOUR_MS = 60 * 60 * 1000

function repoOver(fake: FakeSqlControl) {
  return makeDrizzleHostRegistrationRepository(fake.sql as unknown as Sql)
}

function seats(n: number): SeatDraft[] {
  return Array.from({ length: n }, () => ({
    id: randomUUID(),
    attendeeName: null,
    tokenHash: randomUUID(),
  }))
}

function registerArgs(over: Partial<RegisterTxArgs> = {}): RegisterTxArgs {
  return {
    cleanupId: EVENT,
    subject: { kind: "user", userId: USER },
    ticketTypeId: null,
    seats: seats(1),
    accessCodeHash: null,
    answers: [],
    consent: null,
    slotId: null,
    source: "self",
    idempotencyKey: "retry-key-1",
    waitlistId: null,
    now: NOW,
    ...over,
  }
}

function eventRow(over: Record<string, unknown> = {}) {
  return {
    status: "upcoming",
    visibility: "public",
    registration_opens_at: null,
    registration_closes_at: null,
    capacity: null,
    scheduled_at: new Date(NOW.getTime() + 24 * HOUR_MS),
    ends_at: new Date(NOW.getTime() + 28 * HOUR_MS),
    now: NOW,
    ...over,
  }
}

function registrationRow(over: Record<string, unknown> = {}) {
  return {
    id: REGISTRATION,
    cleanup_id: EVENT,
    ticket_type_id: null,
    ticket_type_name: null,
    user_id: USER,
    guest_id: null,
    guest_name: null,
    party_size: 1,
    status: "registered",
    source: "self",
    host_note: null,
    registered_at: NOW,
    cancelled_at: null,
    checked_in_at: null,
    slot_id: null,
    slot_title: null,
    answers_preview: null,
    person_display_name: null,
    person_handle: null,
    person_bio: null,
    person_avatar_url: null,
    person_deleted_at: null,
    ...over,
  }
}

const EVENT_LOCK = /FROM cleanups WHERE id = \?\s+LIMIT 1 FOR SHARE/
const REGISTRATION_INSERT = /INSERT INTO cleanup_registrations\s*\(/
const REGISTRATION_RELOAD = /FROM cleanup_registrations r\s/

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

describe("a slot claimed while registering is claimed under the slot's row lock", () => {
  function slotHandlers(claimed: number): SqlHandler[] {
    return [
      { match: EVENT_LOCK, rows: [eventRow()] },
      { match: REGISTRATION_INSERT, rows: [{ id: REGISTRATION }] },
      { match: /FROM cleanup_slots\s+WHERE id = \?/, rows: [{ capacity: 1 }] },
      { match: /SELECT slot_id FROM cleanup_slot_claims/, rows: [] },
      { match: /count\(\*\)::int AS n FROM cleanup_slot_claims/, rows: [{ n: claimed }] },
      { match: REGISTRATION_RELOAD, rows: [registrationRow({ slot_id: SLOT })] },
    ]
  }

  it("refuses the whole registration when the slot is already full", async () => {
    const fake = makeFakeSql(slotHandlers(1))

    await expect(repoOver(fake).registerTx(registerArgs({ slotId: SLOT }))).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That slot is already full.",
    })
    const lock = fake.statements.find((s) => /FROM cleanup_slots/.test(s.sql))
    expect(flat(lock?.sql ?? "")).toContain("FOR UPDATE")
    expect(fake.statements.some((s) => /INSERT INTO cleanup_slot_claims/.test(s.sql))).toBe(false)
  })

  it("claims the slot when it still has room", async () => {
    const fake = makeFakeSql(slotHandlers(0))

    const outcome = await repoOver(fake).registerTx(registerArgs({ slotId: SLOT }))

    expect(outcome.kind).toBe("registered")
    const claim = fake.statements.find((s) => /INSERT INTO cleanup_slot_claims/.test(s.sql))
    expect(claim?.values).toEqual([EVENT, USER, SLOT])
  })

  it("refuses a slot that is not on this event instead of dropping it silently", async () => {
    const fake = makeFakeSql([
      { match: /FROM cleanup_slots\s+WHERE id = \?/, rows: [] },
      ...slotHandlers(0),
    ])

    await expect(repoOver(fake).registerTx(registerArgs({ slotId: SLOT }))).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "That slot no longer exists.",
    })
    expect(fake.statements.some((s) => /INSERT INTO cleanup_slot_claims/.test(s.sql))).toBe(false)
  })
})

describe("a retried registration replays its committed result", () => {
  it("replays a committed registration after the sales window has closed", async () => {
    const fake = makeFakeSql([
      {
        match: EVENT_LOCK,
        rows: [eventRow({ registration_closes_at: new Date(NOW.getTime() - HOUR_MS) })],
      },
      {
        match: /SELECT response_snapshot FROM idempotency_keys/,
        rows: [{ response_snapshot: { registrationId: REGISTRATION } }],
      },
    ])

    const outcome = await repoOver(fake).registerTx(registerArgs())

    expect(outcome).toEqual({ kind: "replayed", registration: null })
  })

  it("replays when a concurrent twin with the same key won the active-registration index", async () => {
    let snapshotReads = 0
    const fake = makeFakeSql([
      { match: EVENT_LOCK, rows: [eventRow()] },
      {
        match: /SELECT response_snapshot FROM idempotency_keys/,
        rows: () => {
          snapshotReads += 1
          return snapshotReads === 1
            ? []
            : [{ response_snapshot: { registrationId: REGISTRATION } }]
        },
      },
      {
        match: REGISTRATION_INSERT,
        rows: () => {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint_name: "cleanup_registrations_active_user_uidx",
          })
        },
      },
      { match: REGISTRATION_RELOAD, rows: [registrationRow()] },
    ])

    const outcome = await repoOver(fake).registerTx(registerArgs())

    expect(outcome.kind).toBe("replayed")
    expect(outcome.kind === "replayed" ? outcome.registration?.id : null).toBe(REGISTRATION)
  })

  it("still answers already_registered when the winner used a different key", async () => {
    const fake = makeFakeSql([
      { match: EVENT_LOCK, rows: [eventRow()] },
      {
        match: REGISTRATION_INSERT,
        rows: () => {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint_name: "cleanup_registrations_active_user_uidx",
          })
        },
      },
    ])

    await expect(repoOver(fake).registerTx(registerArgs())).resolves.toEqual({
      kind: "already_registered",
    })
  })
})

describe("waitlist offers skip cancelled and ended events", () => {
  it("scopes both offer queries to a live event without locking the event row", async () => {
    for (const offer of [
      (fake: FakeSqlControl) =>
        repoOver(fake).offerNextWaitlistEntry({
          ticketTypeId: TYPE,
          now: NOW,
          claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
        }),
      (fake: FakeSqlControl) =>
        repoOver(fake).offerWaitlistEntry({
          cleanupId: EVENT,
          waitlistId: WAITLIST,
          now: NOW,
          claimWindowMs: WAITLIST_CLAIM_WINDOW_MS,
        }),
    ]) {
      const fake = makeFakeSql()
      await expect(offer(fake)).resolves.toBeNull()
      const select = flat(fake.statements[0]?.sql ?? "")
      expect(select).toContain("FROM cleanups c WHERE c.id = w.cleanup_id")
      expect(select).toContain("c.status <> 'cancelled'")
      expect(select).toContain("COALESCE(c.ends_at, c.scheduled_at +")
      expect(select).toContain("> now()")
      expect(select).toMatch(/FOR UPDATE( SKIP LOCKED)?$/)
      expect(select).not.toMatch(/JOIN cleanups/)
    }
  })

  it("releases the hold instead of registering when the event ended before the claim", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM cleanup_waitlist w/,
        rows: [
          {
            id: WAITLIST,
            cleanup_id: EVENT,
            ticket_type_id: TYPE,
            ticket_type_name: "General",
            user_id: USER,
            guest_id: null,
            guest_name: null,
            party_size: 1,
            status: "offered",
            position: null,
            created_at: NOW,
            offered_at: NOW,
            claim_expires_at: new Date(NOW.getTime() + HOUR_MS),
            person_display_name: null,
            person_handle: null,
            person_bio: null,
            person_avatar_url: null,
            person_deleted_at: null,
          },
        ],
      },
      {
        match: /FROM cleanups\s+WHERE id = \?\s+LIMIT 1 FOR SHARE/,
        rows: [
          eventRow({
            scheduled_at: new Date(NOW.getTime() - 6 * HOUR_MS),
            ends_at: new Date(NOW.getTime() - HOUR_MS),
          }),
        ],
      },
      {
        match: /SET status = 'claimed'/,
        rows: [{ party_size: 1, user_id: USER, guest_id: null }],
      },
    ])

    const outcome = await repoOver(fake).claimWaitlistOffer({
      cleanupId: EVENT,
      waitlistId: WAITLIST,
      subject: { kind: "user", userId: USER },
      seats: seats(1),
      now: NOW,
    })

    expect(outcome).toEqual({ kind: "not_offered" })
    expect(fake.statements.some((s) => /SET status = 'expired'/.test(s.sql))).toBe(true)
    expect(fake.statements.some((s) => REGISTRATION_INSERT.test(s.sql))).toBe(false)
  })
})

describe("a transfer names the ticket type it vacated", () => {
  it("returns the previous ticket type so the caller can promote its waitlist", async () => {
    const fake = makeFakeSql([
      { match: /FROM cleanups WHERE id = \? LIMIT 1 FOR NO KEY UPDATE/, rows: [{ id: EVENT }] },
      {
        match:
          /FROM cleanup_registrations\s+WHERE id = \? AND cleanup_id = \?\s+LIMIT 1 FOR UPDATE/,
        rows: [{ id: REGISTRATION, ticket_type_id: TYPE, party_size: 1, status: "registered" }],
      },
      {
        match: /SELECT id, max_party_size, capacity, reserved_seats/,
        rows: [
          { id: TYPE, max_party_size: 4, capacity: 1, reserved_seats: 1 },
          { id: SLOT, max_party_size: 4, capacity: null, reserved_seats: 0 },
        ],
      },
      { match: /SET reserved_seats = reserved_seats \+/, rows: [{ id: SLOT }] },
      { match: REGISTRATION_RELOAD, rows: [registrationRow({ ticket_type_id: SLOT })] },
    ])

    const outcome = await repoOver(fake).transferRegistration({
      cleanupId: EVENT,
      registrationId: REGISTRATION,
      ticketTypeId: SLOT,
      now: NOW,
    })

    expect(outcome).toMatchObject({ kind: "transferred", previousTicketTypeId: TYPE })
  })
})

describe("publishing re-checks the review flag in the write itself", () => {
  it("refuses to publish a page an operator flagged after the service read it", async () => {
    const fake = makeFakeSql([
      { match: /UPDATE cleanup_pages/, rows: [] },
      { match: /SELECT flagged_at FROM cleanup_pages/, rows: [{ flagged_at: NOW }] },
    ])

    const outcome = await repoOver(fake).publishPage({
      cleanupId: EVENT,
      published: true,
      actorId: HOST,
      now: NOW,
    })

    expect(outcome).toEqual({ kind: "flagged" })
    const update = flat(fake.statements[0]?.sql ?? "")
    expect(update).toContain("flagged_at IS NULL")
  })

  it("still lets a flagged page be unpublished", async () => {
    const fake = makeFakeSql([
      { match: /UPDATE cleanup_pages/, rows: [{ cleanup_id: EVENT }] },
      {
        match: /FROM cleanups c\s+LEFT JOIN cleanup_pages p/,
        rows: [
          {
            cleanup_id: EVENT,
            slug: "park-day",
            status: "unpublished",
            theme_accent: "bloom",
            blocks: [],
            seo: {},
            cover_media_id: null,
            cover_key: null,
            visibility: "public",
            published_at: null,
            updated_at: NOW,
            flagged_at: NOW,
            flag_reason: "spam",
            view_count: 0,
          },
        ],
      },
    ])

    const outcome = await repoOver(fake).publishPage({
      cleanupId: EVENT,
      published: false,
      actorId: HOST,
      now: NOW,
    })

    expect(outcome.kind).toBe("published")
    expect(fake.statements[0]?.values).toContain(false)
  })
})

describe("a walk-up checked in on arrival is registered and checked in atomically", () => {
  it("checks every seat in with one statement inside the registration transaction", async () => {
    const fake = makeFakeSql([
      { match: /INSERT INTO cleanup_guests/, rows: [{ id: GUEST }] },
      { match: EVENT_LOCK, rows: [eventRow()] },
      { match: REGISTRATION_INSERT, rows: [{ id: REGISTRATION }] },
      {
        match: REGISTRATION_RELOAD,
        rows: [registrationRow({ user_id: null, guest_id: GUEST, source: "walkup" })],
      },
    ])
    let began = -1
    let ended = -1
    const begin = fake.sql.begin
    fake.sql.begin = async (cb) => {
      began = fake.statements.length
      const result = await begin(cb)
      ended = fake.statements.length
      return result
    }

    const outcome = await repoOver(fake).registerWalkupTx({
      cleanupId: EVENT,
      name: "Pat Walker",
      manageTokenHash: "hash",
      ticketTypeId: null,
      seats: seats(2),
      idempotencyKey: "walkup-key",
      idempotencyOwner: `user:${HOST}`,
      now: NOW,
      checkIn: { actorId: HOST, method: "walkup" },
    })

    expect(outcome.kind).toBe("registered")
    const checkIns = fake.statements
      .map((s, index) => ({ ...s, index }))
      .filter((s) => /UPDATE cleanup_registration_seats/.test(s.sql) && /checked_in_at/.test(s.sql))
    expect(checkIns).toHaveLength(1)
    expect(checkIns[0]?.index).toBeGreaterThanOrEqual(began)
    expect(checkIns[0]?.index).toBeLessThan(ended)
    expect(checkIns[0]?.values).toEqual(expect.arrayContaining([REGISTRATION, HOST, "walkup"]))
  })
})

describe("a same-key twin serializes on its idempotency key", () => {
  const KEY_LOCK = /pg_advisory_xact_lock\(hashtext\(/
  const SNAPSHOT = /SELECT response_snapshot FROM idempotency_keys/

  function lockedKeyOf(args: RegisterTxArgs): string {
    return deterministicUuid([REGISTER_IDEMPOTENCY_SCOPE, `user:${USER}`, args.idempotencyKey])
  }

  it("takes the key lock before any other statement, so a twin reads the winner's snapshot", async () => {
    const args = registerArgs()
    const fake = makeFakeSql([
      { match: EVENT_LOCK, rows: [eventRow()] },
      { match: REGISTRATION_INSERT, rows: [{ id: REGISTRATION }] },
      { match: REGISTRATION_RELOAD, rows: [registrationRow()] },
    ])

    await repoOver(fake).registerTx(args)

    const first = fake.statements[0]
    expect(first?.sql).toMatch(KEY_LOCK)
    expect(first?.values).toContain(lockedKeyOf(args))
    const snapshotAt = fake.statements.findIndex((s) => SNAPSHOT.test(s.sql))
    expect(snapshotAt).toBeGreaterThan(0)
    expect(fake.statements.filter((s) => KEY_LOCK.test(s.sql))).toHaveLength(1)
  })

  it("replays the winner's registration instead of answering full once the lock is granted", async () => {
    const fake = makeFakeSql([
      { match: EVENT_LOCK, rows: [eventRow({ capacity: 1 })] },
      { match: SNAPSHOT, rows: [{ response_snapshot: { registrationId: REGISTRATION } }] },
      { match: /COALESCE\(sum\(party_size\), 0\)/, rows: [{ held: 1 }] },
      { match: REGISTRATION_RELOAD, rows: [registrationRow()] },
    ])

    const outcome = await repoOver(fake).registerTx(registerArgs())

    expect(outcome.kind).toBe("replayed")
    const keyLockAt = fake.statements.findIndex((s) => KEY_LOCK.test(s.sql))
    const snapshotAt = fake.statements.findIndex((s) => SNAPSHOT.test(s.sql))
    expect(keyLockAt).toBe(0)
    expect(snapshotAt).toBeGreaterThan(keyLockAt)
  })
})

describe("registering with a slot takes ticket type, then slot, then member rows", () => {
  it("locks the slot after the seat reserve and before the member and registration inserts", async () => {
    const fake = makeFakeSql([
      { match: EVENT_LOCK, rows: [eventRow()] },
      {
        match: /FROM cleanup_ticket_types\s+WHERE cleanup_id = \?\s+ORDER BY sort_order, id/,
        rows: [
          {
            id: TYPE,
            capacity: 5,
            reserved_seats: 0,
            sales_opens_at: null,
            sales_closes_at: null,
            visibility: "public",
            access_code_hash: null,
            max_party_size: 4,
          },
        ],
      },
      { match: /SET reserved_seats = reserved_seats \+/, rows: [{ id: TYPE }] },
      { match: /FROM cleanup_slots\s+WHERE id = \?/, rows: [{ capacity: 3 }] },
      { match: /count\(\*\)::int AS n FROM cleanup_slot_claims/, rows: [{ n: 0 }] },
      { match: REGISTRATION_INSERT, rows: [{ id: REGISTRATION }] },
      { match: REGISTRATION_RELOAD, rows: [registrationRow({ slot_id: SLOT })] },
    ])

    const outcome = await repoOver(fake).registerTx(
      registerArgs({ ticketTypeId: TYPE, slotId: SLOT }),
    )

    expect(outcome.kind).toBe("registered")
    const at = (match: RegExp): number => fake.statements.findIndex((s) => match.test(s.sql))
    const reserve = at(/SET reserved_seats = reserved_seats \+/)
    const slotLock = at(/FROM cleanup_slots\s+WHERE id = \?/)
    const memberInsert = at(/INSERT INTO cleanup_members/)
    const registrationInsert = at(REGISTRATION_INSERT)
    expect(reserve).toBeGreaterThanOrEqual(0)
    expect(slotLock).toBeGreaterThan(reserve)
    expect(memberInsert).toBeGreaterThan(slotLock)
    expect(registrationInsert).toBeGreaterThan(slotLock)
  })
})
