import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { describe, it, expect, beforeEach } from "vitest"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const COHOST = "22222222-2222-2222-2222-222222222222"
const MEMBER = "33333333-3333-3333-3333-333333333333"
const STRANGER = "44444444-4444-4444-4444-444444444444"
const MISSING = "00000000-0000-0000-0000-000000000000"

const CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000001"

const PAST = new Date(Date.now() - 8 * 60 * 60 * 1000)
const PAST_END = new Date(Date.now() - 4 * 60 * 60 * 1000)
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

let repo: InMemoryCleanupRepository
let service: CleanupService

/**
 * DECISIONS §40: `completeCleanup` is DEPRECATED. Status is derived from the clock, so the endpoint
 * writes nothing at all — it stays registered only so a mobile binary older than 0.46.0 neither crashes
 * nor changes state. These tests pin the no-op contract: auth still applies, the call is idempotent, and
 * neither the stored status, `completed_at` nor the timeline moves.
 */

function seedEvent(
  over: { scheduledAt?: Date; endsAt?: Date; status?: "upcoming" | "cancelled" } = {},
): string {
  repo.seedCleanup({
    id: CLEANUP_ID,
    organizerUserId: ORG,
    scheduledAt: over.scheduledAt ?? PAST,
    endsAt: over.endsAt ?? PAST_END,
    ...(over.status !== undefined ? { status: over.status } : {}),
  })
  repo.seedMember(CLEANUP_ID, COHOST, "cohost")
  repo.seedMember(CLEANUP_ID, MEMBER, "member")
  return CLEANUP_ID
}

function statusRows(cleanupId: string): { note: string | null; actorId: string | null }[] {
  return repo.timeline
    .filter((t) => t.cleanupId === cleanupId && t.kind === "status")
    .map((t) => ({ note: t.note, actorId: t.actorId }))
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: ORG, displayName: "Olive Organizer", handle: "olive" })
  repo.seedUser({ id: COHOST, displayName: "Casey Cohost", handle: "casey" })
  repo.seedUser({ id: MEMBER, displayName: "Mel Member", handle: "mel" })
  repo.seedUser({ id: STRANGER, displayName: "Sam Stranger", handle: "sam" })
  service = makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
  })
})

describe("completeCleanup — the deprecated no-op contract", () => {
  it("returns the event unchanged: no status write, no completed_at, no timeline row", async () => {
    const id = seedEvent()

    const dto = await service.completeCleanup(id, null, ORG)

    expect(dto.id).toBe(id)
    expect(dto.status).toBe("done")
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
    expect(repo.cleanups.get(id)?.completedAt).toBeNull()
    expect(statusRows(id)).toEqual([])
  })

  it("is idempotent: a second call returns the same DTO and still writes nothing", async () => {
    const id = seedEvent()

    const first = await service.completeCleanup(id, "42 bags", ORG)
    const second = await service.completeCleanup(id, "42 bags", ORG)

    expect(second).toEqual(first)
    expect(statusRows(id)).toEqual([])
  })

  it("no longer refuses an event that has not started — it simply does nothing", async () => {
    const id = seedEvent({
      scheduledAt: FUTURE,
      endsAt: new Date(FUTURE.getTime() + 4 * 3_600_000),
    })

    const dto = await service.completeCleanup(id, null, ORG)

    expect(dto.status).toBe("upcoming")
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
    expect(statusRows(id)).toEqual([])
  })

  it("no longer refuses a cancelled event either, and leaves it cancelled", async () => {
    const id = seedEvent({ status: "cancelled" })

    const dto = await service.completeCleanup(id, null, ORG)

    expect(dto.status).toBe("cancelled")
    expect(repo.cleanups.get(id)?.status).toBe("cancelled")
    expect(statusRows(id)).toEqual([])
  })

  it("logs one deprecation line carrying the caller's user agent", async () => {
    const lines: { cleanupId?: string; userAgent?: string | null }[] = []
    const svc = makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo,
      counters: new InMemoryCounterStore(),
      logger: {
        info: (obj) => lines.push(obj as { cleanupId?: string; userAgent?: string | null }),
        warn: () => {},
        error: () => {},
      },
    })
    const id = seedEvent()

    await svc.completeCleanup(id, null, ORG, "civfix-ios/1.4.0")

    expect(lines).toEqual([{ cleanupId: id, userAgent: "civfix-ios/1.4.0" }])
  })
})

describe("completeCleanup — authorization still applies", () => {
  it("the organizer and a cohost may call it", async () => {
    const id = seedEvent()

    await expect(service.completeCleanup(id, null, ORG)).resolves.toMatchObject({ id })
    await expect(service.completeCleanup(id, null, COHOST)).resolves.toMatchObject({ id })
  })

  it("403s a plain member and a stranger", async () => {
    const id = seedEvent()

    await expect(service.completeCleanup(id, null, MEMBER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(service.completeCleanup(id, null, STRANGER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("404s an unknown event", async () => {
    seedEvent()

    await expect(service.completeCleanup(MISSING, null, ORG)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("422s a slur in the note before doing anything", async () => {
    const id = seedEvent()

    await expect(service.completeCleanup(id, "you retard", ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    expect(statusRows(id)).toEqual([])
  })
})

describe("completeCleanup — B19: completion rings nobody", () => {
  it("emits NO notification, on a first call or a repeat", async () => {
    const bells: string[] = []
    const svc = makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      counters: new InMemoryCounterStore(),
      repo,
      notifier: {
        createNotification: (userId, input) => {
          bells.push(userId)
          return Promise.resolve({
            id: "n1",
            type: input.type,
            title: "",
            read: false,
            createdAt: new Date().toISOString(),
          })
        },
      },
    })
    const id = seedEvent()

    await svc.completeCleanup(id, null, ORG)
    await svc.completeCleanup(id, null, ORG)

    expect(bells).toEqual([])
  })
})

describe("a past event's roster is frozen in BOTH directions", () => {
  it("still lets an attendee leave (and a host remove) while the event has not been cancelled", async () => {
    const id = seedEvent({
      scheduledAt: FUTURE,
      endsAt: new Date(FUTURE.getTime() + 4 * 3_600_000),
    })

    await expect(service.leaveCleanup(id, MEMBER)).resolves.toMatchObject({ joined: false })
    await expect(service.removeMember(id, ORG, COHOST)).resolves.toMatchObject({ ok: true })
    expect(await repo.isMember(id, COHOST)).toBe(false)
  })

  it("409s leave and remove on a CANCELLED event", async () => {
    const id = seedEvent({ status: "cancelled" })

    await expect(service.leaveCleanup(id, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(service.removeMember(id, ORG, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await repo.isMember(id, MEMBER)).toBe(true)
  })
})
