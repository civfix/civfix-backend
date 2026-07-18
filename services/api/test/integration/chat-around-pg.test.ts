/**
 * Around-mode history integration test (P2 Task 2.4, Docker-gated). Boots against a live PostGIS
 * container (via withPg) and exercises the DB-backed center-window history paths on all three room
 * scopes (cleanup / report / dm):
 *
 *   - `around=<messageId>` returns a window of ceil(limit/2) at-or-older rows (target INCLUDED) +
 *     floor(limit/2) strictly newer, in the SAME newest-first ordering as a before-mode page;
 *   - nextCursor = the older end of the window (follows as a normal `before` cursor), prevCursor = the
 *     newer end (a "there are newer messages" signal — no `after` param exists today), each null when
 *     that side reaches the edge (tail / live head);
 *   - a target that is missing or lives in ANOTHER room/thread -> 404 (scope isolation);
 *   - a soft-deleted target still anchors: its tombstone rides in the window while every OTHER deleted
 *     row stays excluded;
 *   - reply previews (Task 2.3) hydrate on the merged window exactly like before-mode pages.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"

const pg = await withPg()

/** Await a rejection and assert it is a 404 AppError. */
async function expect404(p: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught, "expected a 404 rejection").toBeInstanceOf(AppError)
  expect((caught as AppError).httpStatus).toBe(404)
}

const ids = (items: ChatMessageDTO[]): string[] => items.map((m) => m.id)

describe.skipIf(!pg)("around-mode history windows (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  /** Create a cleanup (organizer joined) and return its id. */
  async function newCleanup(organizerId: string, title: string): Promise<string> {
    const created = await makeCleanupService({
      repo: makeDrizzleCleanupRepository(h.sql),
    }).createCleanup(
      {
        title,
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      organizerId,
    )
    return created.id
  }

  /** Insert a minimal report and return its id. */
  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

  /**
   * Seed `n` chat messages (bodies m1..mN, m1 oldest) into a cleanup or report room with EXPLICIT,
   * strictly-increasing created_at values (1s apart) so the (created_at, id) keyset ordering is
   * deterministic regardless of insert latency. Returns the DTOs oldest-first.
   */
  async function seedChat(
    repo: ReturnType<typeof makeDrizzleChatRepository>,
    roomId: string,
    userId: string,
    n: number,
    opts?: { roomKind?: "report"; replyToIndexByIndex?: Record<number, number> },
  ): Promise<ChatMessageDTO[]> {
    const base = Date.now() - 120_000
    const out: ChatMessageDTO[] = []
    for (let i = 0; i < n; i++) {
      const replyIdx = opts?.replyToIndexByIndex?.[i]
      const m = await repo.insertMessage(
        {
          cleanupId: roomId,
          ...(opts?.roomKind !== undefined ? { roomKind: opts.roomKind } : {}),
          userId,
          body: `m${i + 1}`,
          ...(replyIdx !== undefined ? { replyToId: out[replyIdx]!.id } : {}),
        },
        randomUUID(),
      )
      await h.sql`UPDATE chat_messages SET created_at = ${new Date(base + i * 1000)} WHERE id = ${m.id}`
      out.push(m)
    }
    return out
  }

  it("cleanup around the middle: exact centered window, before-mode ordering, both cursors follow", async () => {
    const organizerId = await newUser("Around Org")
    const cleanupId = await newCleanup(organizerId, "Around sweep")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, cleanupId, organizerId, 10) // m[0]=m1 oldest .. m[9]=m10 newest

    // limit 6 around m5: ceil(6/2)=3 at-or-older (m5,m4,m3 — target included) + floor(6/2)=3 newer
    // (m6,m7,m8), merged newest-first.
    const page = await repo.history(cleanupId, undefined, 6, null, m[4]!.id)
    expect(ids(page.items)).toEqual([m[7], m[6], m[5], m[4], m[3], m[2]].map((x) => x!.id))

    // The window's ordering is IDENTICAL to the corresponding slice of a before-mode fetch.
    const full = await repo.history(cleanupId, undefined, 50)
    expect(ids(page.items)).toEqual(ids(full.items).slice(2, 8))

    // Both ends have more rows beyond the window -> both cursors non-null and pointing at the ends.
    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[7]!.id)

    // nextCursor follows as a plain `before` cursor: strictly older rows, no overlap.
    const older = await repo.history(cleanupId, page.nextCursor!, 50)
    expect(ids(older.items)).toEqual([m[1]!.id, m[0]!.id])
    expect(older.nextCursor).toBeNull()
    // Before-mode pages carry NO prevCursor key at all (byte-identical to pre-2.4 pages).
    expect("prevCursor" in older).toBe(false)

    // prevCursor is re-consumable via around-mode ("load newer"): centering on it reaches the head.
    const newer = await repo.history(cleanupId, undefined, 6, null, page.prevCursor!)
    expect(ids(newer.items)).toEqual([m[9], m[8], m[7], m[6], m[5]].map((x) => x!.id))
    expect(newer.prevCursor).toBeNull() // reaches the live head
    expect(newer.nextCursor).toBe(m[5]!.id)
  })

  it("cleanup around the newest -> prevCursor null; around the oldest -> nextCursor null", async () => {
    const organizerId = await newUser("Around Edges Org")
    const cleanupId = await newCleanup(organizerId, "Around edges sweep")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, cleanupId, organizerId, 10)

    const atHead = await repo.history(cleanupId, undefined, 6, null, m[9]!.id)
    expect(ids(atHead.items)).toEqual([m[9], m[8], m[7]].map((x) => x!.id))
    expect(atHead.prevCursor).toBeNull()
    expect(atHead.nextCursor).toBe(m[7]!.id)

    const atTail = await repo.history(cleanupId, undefined, 6, null, m[0]!.id)
    expect(ids(atTail.items)).toEqual([m[3], m[2], m[1], m[0]].map((x) => x!.id))
    expect(atTail.nextCursor).toBeNull()
    expect(atTail.prevCursor).toBe(m[3]!.id)
  })

  it("around a foreign-room or unknown id -> 404 (scope isolation)", async () => {
    const organizerId = await newUser("Around 404 Org")
    const roomA = await newCleanup(organizerId, "Around room A")
    const roomB = await newCleanup(organizerId, "Around room B")
    const repo = makeDrizzleChatRepository(h.sql)
    await seedChat(repo, roomA, organizerId, 3)
    const inB = await seedChat(repo, roomB, organizerId, 1)

    await expect404(repo.history(roomA, undefined, 6, null, inB[0]!.id))
    await expect404(repo.history(roomA, undefined, 6, null, randomUUID()))
  })

  it("around a soft-deleted target: tombstone anchors the window, other deleted rows stay excluded", async () => {
    const organizerId = await newUser("Around Tombstone Org")
    const cleanupId = await newCleanup(organizerId, "Around tombstone sweep")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, cleanupId, organizerId, 10)

    // Delete the TARGET (m5) and a neighbor (m4): the target rides as a tombstone; m4 is skipped so
    // the older half backfills with the next live rows (m3, m2).
    expect(await repo.softDelete(cleanupId, m[4]!.id, organizerId)).not.toBeNull()
    expect(await repo.softDelete(cleanupId, m[3]!.id, organizerId)).not.toBeNull()

    const page = await repo.history(cleanupId, undefined, 6, null, m[4]!.id)
    expect(ids(page.items)).toEqual([m[7], m[6], m[5], m[4], m[2], m[1]].map((x) => x!.id))
    const tombstone = page.items.find((x) => x.id === m[4]!.id)
    expect(tombstone?.deletedAt).toBeTruthy()
    expect(page.items.some((x) => x.id === m[3]!.id)).toBe(false)
    expect(page.nextCursor).toBe(m[1]!.id) // m1 still older
    expect(page.prevCursor).toBe(m[7]!.id) // m9/m10 still newer
  })

  it("reply previews hydrate on the merged around window", async () => {
    const organizerId = await newUser("Around Reply Org")
    const cleanupId = await newCleanup(organizerId, "Around reply sweep")
    const repo = makeDrizzleChatRepository(h.sql)
    // m6 replies to m2.
    const m = await seedChat(repo, cleanupId, organizerId, 6, { replyToIndexByIndex: { 5: 1 } })

    const page = await repo.history(cleanupId, undefined, 6, null, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2], m[1]].map((x) => x!.id))
    const reply = page.items.find((x) => x.id === m[5]!.id)
    expect(reply?.replyToId).toBe(m[1]!.id)
    expect(reply?.replyTo).toMatchObject({ id: m[1]!.id, excerpt: "m2", kind: "text" })
    expect(page.prevCursor).toBeNull() // the window reaches the live head
    expect(page.nextCursor).toBe(m[1]!.id) // m1 remains older
  })

  it("report room: around centers the window in report scope and 404s a cleanup-room id", async () => {
    const organizerId = await newUser("Around Report Org")
    const reportId = await newReport()
    const cleanupId = await newCleanup(organizerId, "Around report decoy")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, reportId, organizerId, 7, { roomKind: "report" })
    const decoy = await seedChat(repo, cleanupId, organizerId, 1)

    // limit 4 around m4: ceil(4/2)=2 at-or-older (m4,m3) + floor(4/2)=2 newer (m5,m6).
    const page = await repo.reportHistory(reportId, undefined, 4, null, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2]].map((x) => x!.id))
    expect(page.items.every((x) => x.roomKind === "report")).toBe(true)
    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[5]!.id)

    // Ordering matches the before-mode report page.
    const full = await repo.reportHistory(reportId, undefined, 50, null)
    expect(ids(page.items)).toEqual(ids(full.items).slice(1, 5))

    // A cleanup-room message id is not in this report's scope -> 404.
    await expect404(repo.reportHistory(reportId, undefined, 4, null, decoy[0]!.id))
  })

  it("dm: around round-trips in thread scope and 404s a foreign-thread id", async () => {
    const a = await newUser("Around DM A")
    const b = await newUser("Around DM B")
    const c = await newUser("Around DM C")
    const dm = makeDrizzleDmRepository(h.sql)
    const thread = await dm.openOrCreateThread(a, b)
    const otherThread = await dm.openOrCreateThread(a, c)

    const base = Date.now() - 120_000
    const m: ChatMessageDTO[] = []
    for (let i = 0; i < 8; i++) {
      const sent = await dm.persist({ threadId: thread.id, senderId: i % 2 === 0 ? a : b, body: `m${i + 1}` })
      await h.sql`UPDATE dm_messages SET created_at = ${new Date(base + i * 1000)} WHERE id = ${sent.id}`
      m.push(sent)
    }
    const foreign = await dm.persist({ threadId: otherThread.id, senderId: a, body: "elsewhere" })

    // limit 4 around m4: 2 at-or-older (m4,m3) + 2 newer (m5,m6).
    const page = await dm.history(thread.id, undefined, 4, b, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2]].map((x) => x!.id))
    expect(page.items.every((x) => x.roomKind === "dm")).toBe(true)
    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[5]!.id)

    // Matches the before-mode dm ordering.
    const full = await dm.history(thread.id, undefined, 50, b)
    expect(ids(page.items)).toEqual(ids(full.items).slice(2, 6))
    expect("prevCursor" in full).toBe(false) // before-mode page carries no prevCursor key

    // Foreign-thread and unknown targets -> 404.
    await expect404(dm.history(thread.id, undefined, 4, b, foreign.id))
    await expect404(dm.history(thread.id, undefined, 4, b, randomUUID()))
  })
})
