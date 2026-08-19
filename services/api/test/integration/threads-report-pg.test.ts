/**
 * Task D-E3: report chats in the threads inbox + real per-conversation `muted` (Docker-gated). Boots a
 * live PostGIS container (via withPg) and exercises the DB-backed report threads SQL the offline suite
 * covers only with a fake source (test/unit/threads-report.test.ts):
 *
 *   - a member's listThreads includes a kind:"report" thread with the right id/refId/title (category
 *     label + short address) / last / ago / lastFromMe / unread (others' messages after joined_at,
 *     including sender-less system rows) / members, and muted:false;
 *   - inserting a conversation_mutes ('report') row flips that thread's muted to true;
 *   - a NON-member's listThreads excludes the report thread (membership-scoped query);
 *   - a soft-deleted report (deleted_at set) is excluded.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleReportThreadsSource,
  makeDrizzleThreadsRepository,
} from "../../src/services/threads-repository.drizzle.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import {
  makeThreadsService,
  InMemoryChatReadState,
} from "../../src/services/threads-service.js"

const pg = await withPg()

describe.skipIf(!pg)("report chats in the threads inbox (integration)", () => {
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
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** Insert a report (category + addr drive the thread title) and return its id. */
  async function newReport(
    opts: {
      category?: string
      type?: string
      addr?: string | null
      deleted?: boolean
      status?: string
      visibility?: string
      reporterId?: string | null
    } = {},
  ): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell, addr, reporter_user_id, deleted_at)
      VALUES (
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
        'manual',
        ${opts.category ?? "trash"},
        ${opts.type ?? "dump"},
        ${opts.status ?? "published"},
        ${opts.visibility ?? "public"},
        'h0',
        ${opts.addr ?? null},
        ${opts.reporterId ?? null},
        ${opts.deleted ? new Date() : null}
      )
      RETURNING id
    `
    return r!.id
  }

  /** Add `userId` to a report chat with an explicit join time. */
  async function joinReportChat(reportId: string, userId: string, joinedAt: Date): Promise<void> {
    await h.sql`
      INSERT INTO report_chat_members (report_id, user_id, role, joined_at)
      VALUES (${reportId}, ${userId}, 'member', ${joinedAt})
    `
  }

  /** Insert a report chat message (sender_id null => system message). */
  async function addReportMessage(
    reportId: string,
    body: string,
    senderId: string | null,
    createdAt: Date,
  ): Promise<void> {
    await h.sql`
      INSERT INTO chat_messages (report_id, sender_id, body, kind, created_at)
      VALUES (${reportId}, ${senderId}, ${body}, ${senderId === null ? "system" : "text"}, ${createdAt})
    `
  }

  /** Build the full inbox service exactly as the route wires it (cleanup repo + report source + mutes). */
  function service() {
    return makeThreadsService({
      repo: makeDrizzleThreadsRepository(h.sql),
      readState: new InMemoryChatReadState(),
      report: makeDrizzleReportThreadsSource(h.sql),
      mutes: makeConversationMutesRepository(h.sql),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
    })
  }

  it("a member sees a kind:'report' thread with the right title / last / unread / members / muted:false", async () => {
    const me = await newUser("Report Member")
    const other = await newUser("Report Other")
    const reportId = await newReport({ category: "trash", addr: "123 Main St, Los Angeles, CA" })

    await joinReportChat(reportId, me, new Date("2026-06-01T09:00:00.000Z"))
    await joinReportChat(reportId, other, new Date("2026-06-01T09:00:00.000Z"))

    // A message from OTHER after I joined -> unread 1; and a later SYSTEM message (sender_id null) that
    // must ALSO count as "from others" (IS DISTINCT FROM) -> unread 2, and is the last message.
    await addReportMessage(reportId, "please look", other, new Date("2026-06-01T11:00:00.000Z"))
    await addReportMessage(reportId, "Report was acknowledged.", null, new Date("2026-06-01T11:30:00.000Z"))

    const { items } = await service().listThreads(me)
    const t = items.find((x) => x.id === reportId)
    expect(t, "member should see the report thread").toBeDefined()
    expect(t!.kind).toBe("report")
    expect(t!.refId).toBe(reportId)
    // Title = category label + first comma-segment of addr.
    expect(t!.title).toBe("Trash - 123 Main St")
    expect(t!.last).toBe("Report was acknowledged.")
    expect(t!.ago).toBe("30m")
    expect(t!.lastFromMe).toBe(false)
    expect(t!.unread).toBe(2)
    expect(t!.members).toBe(2)
    expect(t!.muted).toBe(false)
  })

  it("the title falls back to the category label alone when the report has no address", async () => {
    const me = await newUser("No Addr Member")
    const reportId = await newReport({ category: "water", addr: null })
    await joinReportChat(reportId, me, new Date("2026-06-01T09:00:00.000Z"))

    const t = (await service().listThreads(me)).items.find((x) => x.id === reportId)
    expect(t!.title).toBe("Water")
  })

  it("a conversation_mutes ('report') row flips the thread's muted to true", async () => {
    const me = await newUser("Mute Member")
    const other = await newUser("Mute Other")
    const reportId = await newReport({ category: "graffiti", addr: "5 Elm Ave" })
    await joinReportChat(reportId, me, new Date("2026-06-01T09:00:00.000Z"))
    await addReportMessage(reportId, "tagging here", other, new Date("2026-06-01T10:00:00.000Z"))

    const before = (await service().listThreads(me)).items.find((x) => x.id === reportId)
    expect(before!.muted).toBe(false)

    await makeConversationMutesRepository(h.sql).setMuted(me, "report", reportId, true)

    const after = (await service().listThreads(me)).items.find((x) => x.id === reportId)
    expect(after!.muted).toBe(true)
  })

  it("excludes a report the viewer is NOT a member of", async () => {
    const member = await newUser("Actual Member")
    const stranger = await newUser("Stranger")
    const reportId = await newReport({ category: "hazard", addr: "9 Oak Blvd" })
    await joinReportChat(reportId, member, new Date("2026-06-01T09:00:00.000Z"))
    await addReportMessage(reportId, "watch out", member, new Date("2026-06-01T10:00:00.000Z"))

    const memberThreads = await service().listThreads(member)
    expect(memberThreads.items.some((x) => x.id === reportId)).toBe(true)

    const strangerThreads = await service().listThreads(stranger)
    expect(strangerThreads.items.some((x) => x.id === reportId)).toBe(false)
  })

  it("excludes a soft-deleted report even for a member", async () => {
    const me = await newUser("Deleted Report Member")
    const reportId = await newReport({ category: "trash", addr: "1 Gone St", deleted: true })
    await joinReportChat(reportId, me, new Date("2026-06-01T09:00:00.000Z"))

    const threads = await service().listThreads(me)
    expect(threads.items.some((x) => x.id === reportId)).toBe(false)
  })

  it("a non-public report drops from a non-owner member's inbox but stays in the reporter's (finding #45)", async () => {
    const reporter = await newUser("Held Reporter")
    const member = await newUser("Held Member")
    const reportId = await newReport({
      category: "trash",
      addr: "77 Held St",
      status: "submitted",
      reporterId: reporter,
    })
    await joinReportChat(reportId, reporter, new Date("2026-06-01T09:00:00.000Z"))
    await joinReportChat(reportId, member, new Date("2026-06-01T09:00:00.000Z"))

    const memberThreads = await service().listThreads(member)
    expect(memberThreads.items.some((x) => x.id === reportId)).toBe(false)

    const reporterThreads = await service().listThreads(reporter)
    expect(reporterThreads.items.some((x) => x.id === reportId)).toBe(true)
  })
})
