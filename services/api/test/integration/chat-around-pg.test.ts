
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

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

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

  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

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
    const m = await seedChat(repo, cleanupId, organizerId, 10)

    const page = await repo.history(cleanupId, undefined, 6, null, m[4]!.id)
    expect(ids(page.items)).toEqual([m[7], m[6], m[5], m[4], m[3], m[2]].map((x) => x!.id))

    const full = await repo.history(cleanupId, undefined, 50)
    expect(ids(page.items)).toEqual(ids(full.items).slice(2, 8))

    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[7]!.id)

    const older = await repo.history(cleanupId, page.nextCursor!, 50)
    expect(ids(older.items)).toEqual([m[1]!.id, m[0]!.id])
    expect(older.nextCursor).toBeNull()
    expect("prevCursor" in older).toBe(false)

    const newer = await repo.history(cleanupId, undefined, 6, null, page.prevCursor!)
    expect(ids(newer.items)).toEqual([m[9], m[8], m[7], m[6], m[5]].map((x) => x!.id))
    expect(newer.prevCursor).toBeNull()
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

    expect(await repo.softDelete(cleanupId, m[4]!.id, organizerId)).not.toBeNull()
    expect(await repo.softDelete(cleanupId, m[3]!.id, organizerId)).not.toBeNull()

    const page = await repo.history(cleanupId, undefined, 6, null, m[4]!.id)
    expect(ids(page.items)).toEqual([m[7], m[6], m[5], m[4], m[2], m[1]].map((x) => x!.id))
    const tombstone = page.items.find((x) => x.id === m[4]!.id)
    expect(tombstone?.deletedAt).toBeTruthy()
    expect(tombstone?.body ?? null).toBeNull()
    expect(tombstone?.attachments ?? []).toEqual([])
    expect(tombstone?.reactions ?? []).toEqual([])
    expect(tombstone?.mentions ?? []).toEqual([])
    expect(page.items.some((x) => x.id === m[3]!.id)).toBe(false)
    expect(page.nextCursor).toBe(m[1]!.id)
    expect(page.prevCursor).toBe(m[7]!.id)
  })

  it("reply previews hydrate on the merged around window", async () => {
    const organizerId = await newUser("Around Reply Org")
    const cleanupId = await newCleanup(organizerId, "Around reply sweep")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, cleanupId, organizerId, 6, { replyToIndexByIndex: { 5: 1 } })

    const page = await repo.history(cleanupId, undefined, 6, null, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2], m[1]].map((x) => x!.id))
    const reply = page.items.find((x) => x.id === m[5]!.id)
    expect(reply?.replyToId).toBe(m[1]!.id)
    expect(reply?.replyTo).toMatchObject({ id: m[1]!.id, excerpt: "m2", kind: "text" })
    expect(page.prevCursor).toBeNull()
    expect(page.nextCursor).toBe(m[1]!.id)
  })

  it("report room: around centers the window in report scope and 404s a cleanup-room id", async () => {
    const organizerId = await newUser("Around Report Org")
    const reportId = await newReport()
    const cleanupId = await newCleanup(organizerId, "Around report decoy")
    const repo = makeDrizzleChatRepository(h.sql)
    const m = await seedChat(repo, reportId, organizerId, 7, { roomKind: "report" })
    const decoy = await seedChat(repo, cleanupId, organizerId, 1)

    const page = await repo.reportHistory(reportId, undefined, 4, null, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2]].map((x) => x!.id))
    expect(page.items.every((x) => x.roomKind === "report")).toBe(true)
    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[5]!.id)

    const full = await repo.reportHistory(reportId, undefined, 50, null)
    expect(ids(page.items)).toEqual(ids(full.items).slice(1, 5))

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

    const page = await dm.history(thread.id, undefined, 4, b, m[3]!.id)
    expect(ids(page.items)).toEqual([m[5], m[4], m[3], m[2]].map((x) => x!.id))
    expect(page.items.every((x) => x.roomKind === "dm")).toBe(true)
    expect(page.nextCursor).toBe(m[2]!.id)
    expect(page.prevCursor).toBe(m[5]!.id)

    const full = await dm.history(thread.id, undefined, 50, b)
    expect(ids(page.items)).toEqual(ids(full.items).slice(2, 6))
    expect("prevCursor" in full).toBe(false)

    await expect404(dm.history(thread.id, undefined, 4, b, foreign.id))
    await expect404(dm.history(thread.id, undefined, 4, b, randomUUID()))
  })
})
