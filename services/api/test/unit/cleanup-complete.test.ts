/**
 * Host event completion (B12–B19), against the in-memory CleanupRepository.
 *
 * Until this endpoint existed only an OPERATOR could move an event to 'done' — and 'done' is exactly
 * what logEventHours hard-requires — so no host could credit a single attendee without asking support.
 * The tests below pin the four things that make the transition safe rather than merely possible:
 *
 *   - WHO may close an event (organizer OR cohost, B13 — deliberately wider than cancel's organizer-only);
 *   - WHEN (now >= scheduledAt, B14 — hours are a falsifiable public record, so a host may not date an
 *     event next year and credit hours for it today);
 *   - the full B15 status matrix, including the two 409s and the idempotent repeat;
 *   - what is WRITTEN (one 'status' timeline row carrying the service-composed note) and what is NOT
 *     (a second timeline row on a repeat, and any notification at all — B19).
 *
 * The Drizzle twin of the same matrix runs in test/integration/cleanup-complete-pg.test.ts; the two
 * suites deliberately assert the same observable contract, because a divergence between the fake and the
 * real repository is invisible to CI otherwise (unit tests run the twin, integration the real one).
 */

import { describe, it, expect, beforeEach } from "vitest"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"

const ORG = "11111111-1111-1111-1111-111111111111"
const COHOST = "22222222-2222-2222-2222-222222222222"
const MEMBER = "33333333-3333-3333-3333-333333333333"
const STRANGER = "44444444-4444-4444-4444-444444444444"
const MISSING = "00000000-0000-0000-0000-000000000000"

const CLEANUP_ID = "aaaaaaaa-0000-0000-0000-000000000001"

const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000)
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

let repo: InMemoryCleanupRepository
let service: CleanupService

/** Seed an event with the full host cast: organizer + cohost + a plain member. */
function seedEvent(over: { scheduledAt?: Date; status?: "upcoming" | "active" | "done" | "cancelled" } = {}): string {
  repo.seedCleanup({
    id: CLEANUP_ID,
    organizerUserId: ORG,
    scheduledAt: over.scheduledAt ?? PAST,
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
  service = makeCleanupService({ repo })
})

describe("completeCleanup — B15 status matrix", () => {
  it("upcoming + now >= scheduledAt: flips to 'done' and writes ONE 'status' timeline row", async () => {
    const id = seedEvent()

    const dto = await service.completeCleanup(id, null, ORG)

    expect(dto.status).toBe("done")
    expect(dto.id).toBe(id)
    expect(repo.cleanups.get(id)?.status).toBe("done")
    expect(statusRows(id)).toEqual([{ note: "Event marked complete", actorId: ORG }])
  })

  it("active + now >= scheduledAt: also completes (the matrix accepts both live states)", async () => {
    const id = seedEvent({ status: "active" })

    const dto = await service.completeCleanup(id, null, ORG)

    expect(dto.status).toBe("done")
    expect(statusRows(id)).toHaveLength(1)
  })

  it("409s when the event has not started yet, and writes nothing (B14's time anchor)", async () => {
    const id = seedEvent({ scheduledAt: FUTURE })

    await expect(service.completeCleanup(id, null, ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    // Not applied-then-refused: an event dated next year stays exactly as it was, so a host can never
    // credit hours for something that has not happened.
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
    expect(statusRows(id)).toEqual([])
  })

  it("409s a CANCELLED event (a cancelled event can never be marked complete)", async () => {
    const id = seedEvent({ status: "cancelled" })

    await expect(service.completeCleanup(id, null, ORG)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(repo.cleanups.get(id)?.status).toBe("cancelled")
    expect(statusRows(id)).toEqual([])
  })

  it("404s a missing cleanup", async () => {
    await expect(service.completeCleanup(MISSING, null, ORG)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("a second call is idempotent: same 200 + DTO, NO second timeline row", async () => {
    const id = seedEvent()

    const first = await service.completeCleanup(id, "Great turnout", ORG)
    const second = await service.completeCleanup(id, "Great turnout", ORG)

    expect(first.status).toBe("done")
    expect(second.status).toBe("done")
    // The whole point of the repo reporting `already_completed` rather than a bare boolean: a retrying
    // client (or a double-tapping host) must not litter the public event timeline.
    expect(statusRows(id)).toHaveLength(1)
  })
})

describe("completeCleanup — authorization (B13: organizer OR cohost)", () => {
  it("the organizer may complete", async () => {
    const id = seedEvent()
    const dto = await service.completeCleanup(id, null, ORG)
    expect(dto.status).toBe("done")
    expect(dto.myRole).toBe("organizer")
  })

  it("a COHOST may complete — unlike cancel, which is organizer-only", async () => {
    const id = seedEvent()

    const dto = await service.completeCleanup(id, null, COHOST)

    expect(dto.status).toBe("done")
    // The cohost is exactly the person who then logs the hours (the hours gate sits on the ACTING host),
    // so refusing them here would leave the credit path dependent on the organizer being reachable.
    expect(dto.myRole).toBe("cohost")
    expect(statusRows(id)).toEqual([{ note: "Event marked complete", actorId: COHOST }])
  })

  it("403s a plain member and writes nothing", async () => {
    const id = seedEvent()

    await expect(service.completeCleanup(id, null, MEMBER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
    expect(statusRows(id)).toEqual([])
  })

  it("403s a non-member", async () => {
    const id = seedEvent()

    await expect(service.completeCleanup(id, null, STRANGER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
  })

  it("404 beats 403: a missing event never reveals itself through the host gate", async () => {
    await expect(service.completeCleanup(MISSING, null, STRANGER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

describe("completeCleanup — the timeline note the service composes", () => {
  it("interpolates a supplied note (trimmed) into the 'status' row", async () => {
    const id = seedEvent()

    await service.completeCleanup(id, "  42 bags off the creek  ", ORG)

    expect(statusRows(id)).toEqual([
      { note: "Event marked complete: 42 bags off the creek", actorId: ORG },
    ])
  })

  it("a blank/whitespace note degrades to the bare sentence (no dangling colon)", async () => {
    const id = seedEvent()

    await service.completeCleanup(id, "   ", ORG)

    expect(statusRows(id)).toEqual([{ note: "Event marked complete", actorId: ORG }])
  })

  it("422s a slur in the note — it lands in the PUBLIC event timeline", async () => {
    const id = seedEvent()
    // The canonical term the shared filter matches; see abuse/slur-filter.ts and the M19 block in
    // cleanup-service.test.ts. Every host-authored free text gets the same gate.
    const SLUR = "nigger"

    await expect(service.completeCleanup(id, `great day ${SLUR}`, ORG)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    // Refused outright, not applied-then-sanitized: the status flip never happens either.
    expect(repo.cleanups.get(id)?.status).toBe("upcoming")
    expect(statusRows(id)).toEqual([])
  })
})

describe("completeCleanup — B19: completion rings nobody", () => {
  it("emits NO notification, on a fresh completion or a repeat", async () => {
    const bells: string[] = []
    const svc = makeCleanupService({
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

    // "The host marked the event complete" is not actionable for an attendee, and a 2000-wide fan-out on
    // every completion is pure noise. The actionable moment is hours_logged, which fires elsewhere.
    expect(bells).toEqual([])
  })
})

describe("a terminal event's roster is frozen in BOTH directions", () => {
  it("409s an attendee leaving a completed event, and keeps their membership", async () => {
    const id = seedEvent({ status: "done" })

    await expect(service.leaveCleanup(id, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await repo.isMember(id, MEMBER)).toBe(true)
  })

  it("409s a host removing an attendee from a completed event (no delete, no ban)", async () => {
    const id = seedEvent({ status: "done" })

    await expect(service.removeMember(id, ORG, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await repo.isMember(id, MEMBER)).toBe(true)
    expect(await repo.isBanned(id, MEMBER)).toBe(false)
  })

  it("409s leave and remove on a CANCELLED event too (joining is already refused)", async () => {
    const id = seedEvent({ status: "cancelled" })

    await expect(service.leaveCleanup(id, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(service.removeMember(id, ORG, MEMBER)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(await repo.isMember(id, MEMBER)).toBe(true)
  })

  it("still lets an attendee leave (and a host remove) while the event is live", async () => {
    const id = seedEvent()

    await expect(service.leaveCleanup(id, MEMBER)).resolves.toMatchObject({ joined: false })
    await expect(service.removeMember(id, ORG, COHOST)).resolves.toMatchObject({ ok: true })
    expect(await repo.isMember(id, COHOST)).toBe(false)
  })
})
