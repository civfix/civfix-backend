/**
 * F160: the moderation queue's "where does this item live" column used to be a per-row correlated
 * subquery — for a chat subject `SELECT … FROM chat_messages WHERE id = subject_id`, for a photo a
 * media_assets → chat_messages id-only join. chat_messages is PARTITIONED on created_at, so an id-only
 * lookup cannot prune and probes EVERY monthly partition; a page of up to 101 rows therefore cost
 * ~101 × partitions index probes on top of the main scan. The page now resolves its chat/photo subjects
 * in ONE batched `WHERE id = ANY(...)` per lane after the page is cut.
 *
 * The batched path is only reachable through the Drizzle repository against the real partitioned schema,
 * which is what this file exercises (Docker-gated). The assertion that matters is EQUIVALENCE: the
 * batched list must resolve exactly the destinations the single-row getItem resolves, for every subject
 * shape (report / chat-in-report / chat-in-event / photo bound to a report / photo bound to an event
 * chat / unbound photo), or the queue's "open" link silently goes somewhere else.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleModerationRepository } from "../../src/services/admin/moderation-repository.drizzle.js"
import type { ModerationRepository } from "../../src/services/admin/moderation-service.js"

const pg = await withPg()

describe.skipIf(!pg)("F160: batched destination refs match the per-item lookup", () => {
  let h: PgHarness
  let repo: ModerationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleModerationRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE moderation_items RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM media_assets`
    await h.sql`DELETE FROM chat_messages`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM cleanups`
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

  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'published', 'h0')
      RETURNING id
    `
    return r!.id
  }

  async function newCleanup(organizerId: string): Promise<string> {
    const [c] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanups (organizer_user_id, title, type, geom, scheduled_at, status)
      VALUES (${organizerId}, 'Beach cleanup', 'site', ST_SetSRID(ST_MakePoint(-118.49, 34.0), 4326), now(), 'upcoming')
      RETURNING id
    `
    return c!.id
  }

  async function newChatMessage(
    senderId: string,
    binding: { reportId?: string; cleanupId?: string },
  ): Promise<string> {
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_messages (report_id, cleanup_id, sender_id, body, kind)
      VALUES (${binding.reportId ?? null}, ${binding.cleanupId ?? null}, ${senderId}, 'hello', 'text')
      RETURNING id
    `
    return m!.id
  }

  async function newDmMessage(senderId: string, peerId: string): Promise<string> {
    const [t] = await h.sql<{ id: string }[]>`
      INSERT INTO dm_threads (user_lo, user_hi)
      VALUES (LEAST(${senderId}::uuid, ${peerId}::uuid), GREATEST(${senderId}::uuid, ${peerId}::uuid))
      RETURNING id
    `
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO dm_messages (thread_id, sender_id, body, kind)
      VALUES (${t!.id}, ${senderId}, 'hello', 'text')
      RETURNING id
    `
    return m!.id
  }

  async function newMedia(binding: {
    reportId?: string
    chatMessageId?: string
  }): Promise<string> {
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, purpose, report_id, chat_message_id)
      VALUES (
        ${randomUUID()}, 'image', ${`m/${randomUUID()}.jpg`}, 'ready', 'report',
        ${binding.reportId ?? null}, ${binding.chatMessageId ?? null}
      )
      RETURNING id
    `
    return m!.id
  }

  async function openItem(subjectType: string, subjectId: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO moderation_items (kind, subject_type, subject_id, flag, status)
      VALUES ('image', ${subjectType}, ${subjectId}, 'Reported', 'open')
      RETURNING id
    `
    return row!.id
  }

  it("resolves every subject shape in the LIST exactly as getItem does", async () => {
    const author = await newUser("Author")
    const reportId = await newReport()
    const cleanupId = await newCleanup(author)
    const reportChat = await newChatMessage(author, { reportId })
    const eventChat = await newChatMessage(author, { cleanupId })
    const reportPhoto = await newMedia({ reportId })
    const eventChatPhoto = await newMedia({ chatMessageId: eventChat })
    const unboundPhoto = await newMedia({})

    const ids = [
      await openItem("report", reportId),
      await openItem("chat", reportChat),
      await openItem("chat", eventChat),
      await openItem("photo", reportPhoto),
      await openItem("photo", eventChatPhoto),
      await openItem("photo", unboundPhoto),
    ]

    const { records } = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(records.map((r) => r.id).sort()).toEqual([...ids].sort())

    for (const record of records) {
      const single = await repo.getItem(record.id)
      expect(single).not.toBeNull()
      expect({
        kind: record.destinationKind,
        id: record.destinationId,
      }).toEqual({ kind: single!.destinationKind, id: single!.destinationId })
    }

    const bySubject = new Map(records.map((r) => [r.subjectId, r]))
    expect(bySubject.get(reportId)).toMatchObject({ destinationKind: "report", destinationId: reportId })
    expect(bySubject.get(reportChat)).toMatchObject({
      destinationKind: "report",
      destinationId: reportId,
    })
    expect(bySubject.get(eventChat)).toMatchObject({
      destinationKind: "event",
      destinationId: cleanupId,
    })
    expect(bySubject.get(reportPhoto)).toMatchObject({
      destinationKind: "report",
      destinationId: reportId,
    })
    expect(bySubject.get(eventChatPhoto)).toMatchObject({
      destinationKind: "event",
      destinationId: cleanupId,
    })
    expect(bySubject.get(unboundPhoto)).toMatchObject({
      destinationKind: null,
      destinationId: null,
    })
  })

  it("keeps the destinations correct across a PAGED walk of the queue", async () => {
    const author = await newUser("Author")
    const expected = new Map<string, string>()
    for (let i = 0; i < 5; i++) {
      const reportId = await newReport()
      const chatId = await newChatMessage(author, { reportId })
      expected.set(await openItem("chat", chatId), reportId)
    }

    const seen = new Map<string, string | null>()
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const res: { records: Array<{ id: string; destinationId: string | null }>; nextCursor: string | null } =
        await repo.listOpen({ q: null, filter: "all", cursor, limit: 2 })
      for (const r of res.records) seen.set(r.id, r.destinationId)
      if (res.nextCursor === null) break
      cursor = res.nextCursor
    }

    expect(seen.size).toBe(expected.size)
    for (const [itemId, reportId] of expected) expect(seen.get(itemId)).toBe(reportId)
  })

  /**
   * The SHAPE of the query is the finding. A statement-capturing connection (postgres-js `debug`) proves
   * the page no longer carries the per-row correlated lookups into the partitioned chat_messages, and
   * that each lane resolves through a single `= ANY(...)` batch instead.
   */
  it("resolves the page with BATCHED lookups, not a per-row correlated subquery", async () => {
    const author = await newUser("Author")
    const reportId = await newReport()
    for (let i = 0; i < 6; i++) {
      const chatId = await newChatMessage(author, { reportId })
      await openItem("chat", chatId)
      await openItem("photo", await newMedia({ chatMessageId: chatId }))
    }

    const statements: string[] = []
    const spy = postgres(h.uri, {
      max: 1,
      onnotice: () => {},
      debug: (_conn: number, query: string) => {
        statements.push(query)
      },
    }) as Sql
    try {
      const spied = makeDrizzleModerationRepository(spy)
      const { records } = await spied.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
      expect(records).toHaveLength(12)
      expect(records.every((r) => r.destinationId === reportId)).toBe(true)
    } finally {
      await spy.end()
    }

    const correlated = statements.filter((q) =>
      /chat_messages\s+cm\s+WHERE\s+cm\.id\s*=\s*moderation_items\.subject_id/i.test(q),
    )
    expect(correlated).toEqual([])

    const batched = statements.filter((q) => /=\s*ANY\(/i.test(q) && /chat_messages/i.test(q))
    expect(batched.length).toBeGreaterThan(0)
    expect(batched.length).toBeLessThanOrEqual(2)
  })

  it("W7: a `message` subject resolves its room exactly like a `chat` subject", async () => {
    const author = await newUser("Msg author")
    const peer = await newUser("Msg peer")
    const reportId = await newReport()
    const cleanupId = await newCleanup(author)
    const reportMsg = await newChatMessage(author, { reportId })
    const eventMsg = await newChatMessage(author, { cleanupId })
    const dmMsg = await newDmMessage(author, peer)

    const ids = [
      await openItem("message", reportMsg),
      await openItem("message", eventMsg),
      await openItem("message", dmMsg),
    ]

    const { records } = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(records.map((r) => r.id).sort()).toEqual([...ids].sort())

    for (const record of records) {
      const single = await repo.getItem(record.id)
      expect({ kind: record.destinationKind, id: record.destinationId }).toEqual({
        kind: single!.destinationKind,
        id: single!.destinationId,
      })
    }

    const bySubject = new Map(records.map((r) => [r.subjectId, r]))
    expect(bySubject.get(reportMsg)).toMatchObject({
      destinationKind: "report",
      destinationId: reportId,
    })
    expect(bySubject.get(eventMsg)).toMatchObject({
      destinationKind: "event",
      destinationId: cleanupId,
    })
    expect(bySubject.get(dmMsg)).toMatchObject({ destinationKind: null, destinationId: null })
  })

  it("W7: chat and message subjects share ONE batched chat_messages lookup", async () => {
    const author = await newUser("Batch author")
    const reportId = await newReport()
    for (let i = 0; i < 3; i++) {
      await openItem("chat", await newChatMessage(author, { reportId }))
      await openItem("message", await newChatMessage(author, { reportId }))
    }

    const statements: string[] = []
    const spy = postgres(h.uri, {
      max: 1,
      onnotice: () => {},
      debug: (_conn: number, query: string) => {
        statements.push(query)
      },
    }) as Sql
    try {
      const spied = makeDrizzleModerationRepository(spy)
      const { records } = await spied.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
      expect(records).toHaveLength(6)
      expect(records.every((r) => r.destinationId === reportId)).toBe(true)
    } finally {
      await spy.end()
    }

    const batched = statements.filter(
      (q) => /=\s*ANY\(/i.test(q) && /chat_messages/i.test(q),
    )
    expect(batched).toHaveLength(1)
  })

  it("issues no per-row destination lookup when the page has no chat/photo subjects", async () => {
    const reportId = await newReport()
    const itemId = await openItem("report", reportId)

    const { records } = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: itemId,
      destinationKind: "report",
      destinationId: reportId,
    })
  })
})
