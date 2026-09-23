import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleInboundRepository,
  type InboundEmailInsert,
  type InboundRepository,
} from "../../src/services/admin/inbound-repository.drizzle.js"

const pg = await withPg()

function insert(over: Partial<InboundEmailInsert> = {}): InboundEmailInsert {
  return {
    messageId: over.messageId ?? `<${Math.random().toString(36).slice(2)}@x>`,
    fromAddr: over.fromAddr ?? "resident@example.com",
    toAddr: over.toAddr ?? "support@civfix.org",
    recipient: over.recipient ?? "support@civfix.org",
    subject: over.subject ?? "Question",
    bodyText: over.bodyText ?? "Body text here.",
    bodyHtml: over.bodyHtml ?? null,
    headers: over.headers ?? { from: "resident@example.com" },
    attachments: over.attachments ?? [],
    ...(over.receivedAt ? { receivedAt: over.receivedAt } : {}),
  }
}

describe.skipIf(!pg)("inbound repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: InboundRepository
  let operatorId: string

  beforeAll(async () => {
    h = pg as PgHarness
    repo = makeDrizzleInboundRepository(h.sql)
    const operator = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, role)
      VALUES ('Inbox Operator', ${`op_${randomUUID().replace(/-/g, "").slice(0, 12)}`}, 'operator')
      RETURNING id
    `
    operatorId = operator[0]!.id
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE inbound_emails RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("insertIdempotent dedups on the UNIQUE message_id", async () => {
    const input = insert({
      messageId: "<dup@x>",
      attachments: [{ key: "k", filename: "f.pdf", size: 3 }],
    })
    const first = await repo.insertIdempotent(input)
    expect(first.inserted).toBe(true)
    const second = await repo.insertIdempotent(input)
    expect(second.inserted).toBe(false)
    expect(second.id).toBe(first.id)
    const dto = await repo.get(first.id)
    expect(dto?.hasAttachments).toBe(true)
    expect(dto?.attachments).toHaveLength(1)
  })

  it("lists newest-first, paginates by cursor, and filters by status + localPart", async () => {
    await repo.insertIdempotent(
      insert({ messageId: "<a@x>", recipient: "support@civfix.org", receivedAt: new Date(1000) }),
    )
    await repo.insertIdempotent(
      insert({ messageId: "<b@x>", recipient: "hello@civfix.org", receivedAt: new Date(2000) }),
    )
    const third = await repo.insertIdempotent(
      insert({ messageId: "<c@x>", recipient: "support@civfix.org", receivedAt: new Date(3000) }),
    )

    const page1 = await repo.list({ limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe(third.id)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await repo.list({ limit: 2, cursor: page1.nextCursor ?? undefined })
    expect(page2.items).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()

    const onlySupport = await repo.list({ localPart: "support" })
    expect(onlySupport.items.every((i) => i.localPart === "support")).toBe(true)
    expect(onlySupport.items).toHaveLength(2)
  })

  it("setStatus transitions the triage state and filters reflect it", async () => {
    const r = await repo.insertIdempotent(insert({ messageId: "<s@x>" }))
    expect((await repo.get(r.id))?.status).toBe("unread")
    expect(await repo.setStatus(r.id, "archived", null)).toBe(true)
    expect((await repo.get(r.id))?.status).toBe("archived")
    expect((await repo.list({ status: "unread" })).items).toHaveLength(0)
    expect((await repo.list({ status: "archived" })).items).toHaveLength(1)
  })

  it("setStatus writes an inbox.status_changed audit row (with the actor + the transition) in-tx", async () => {
    const r = await repo.insertIdempotent(insert({ messageId: "<audit@x>" }))
    const actor = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, role)
      -- Underscore, not a hyphen: 0026_user_handle_required.sql's users_handle_format_chk is
      -- ^[A-Za-z0-9_]{3,20}$, so 'op-<hex>' is rejected at insert time.
      VALUES ('Op', ${`op_${r.id.slice(0, 8)}`}, 'operator')
      RETURNING id
    `
    const actorId = actor[0]!.id
    expect(await repo.setStatus(r.id, "archived", actorId)).toBe(true)
    const audit = await h.sql<
      { actor_id: string; target: string; meta: Record<string, unknown> }[]
    >`
      SELECT actor_id, target, meta FROM audit_log
      WHERE action = 'inbox.status_changed' AND target = ${`inbound_email:${r.id}`}
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor_id).toBe(actorId)
    expect(audit[0]?.target).toBe(`inbound_email:${r.id}`)
    expect(audit[0]?.meta).toMatchObject({ status: "archived", priorStatus: "unread" })

    expect(await repo.setStatus(r.id, "archived", actorId)).toBe(true)
    const again = await h.sql<{ meta: Record<string, unknown> }[]>`
      SELECT meta FROM audit_log
      WHERE action = 'inbox.status_changed' AND target = ${`inbound_email:${r.id}`}
      ORDER BY created_at ASC, id ASC
    `
    expect(again).toHaveLength(2)
    expect(again[1]?.meta).toMatchObject({ status: "archived", priorStatus: "archived" })

    expect(await repo.setStatus("00000000-0000-0000-0000-000000000000", "read", actorId)).toBe(
      false,
    )
    const missing = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'inbox.status_changed'
        AND target = 'inbound_email:00000000-0000-0000-0000-000000000000'
    `
    expect(missing[0]!.n).toBe(0)
  })

  it("H10: stamps archived_at on archive, keeps it on a re-archive, and clears it on un-archive", async () => {
    const { id } = await repo.insertIdempotent(insert({ messageId: "<archived-clock@x>" }))

    const read = async (): Promise<Date | null> => {
      const rows = await h.sql<{ archived_at: Date | null }[]>`
        SELECT archived_at FROM inbound_emails WHERE id = ${id}
      `
      return rows[0]?.archived_at ?? null
    }

    expect(await read()).toBeNull()
    await repo.setStatus(id, "read", operatorId)
    expect(await read()).toBeNull()

    await repo.setStatus(id, "archived", operatorId)
    const first = await read()
    expect(first).toBeInstanceOf(Date)

    await repo.setStatus(id, "archived", operatorId)
    expect((await read())?.getTime()).toBe(first!.getTime())

    await repo.setStatus(id, "unread", operatorId)
    expect(await read()).toBeNull()
  })

  it("H10: the retention predicate finds ONLY archived rows past the TTL, with their attachment keys", async () => {
    const long = 200 * 24 * 60 * 60 * 1000
    const short = 10 * 24 * 60 * 60 * 1000
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)

    const stale = await repo.insertIdempotent(
      insert({
        messageId: "<stale-archived@x>",
        attachments: [{ key: "inbound-emails/stale/1-a.pdf", filename: "a.pdf", size: 4 }],
      }),
    )
    const fresh = await repo.insertIdempotent(insert({ messageId: "<fresh-archived@x>" }))
    const unread = await repo.insertIdempotent(insert({ messageId: "<still-unread@x>" }))

    await repo.setStatus(stale.id, "archived", operatorId)
    await repo.setStatus(fresh.id, "archived", operatorId)
    await h.sql`
      UPDATE inbound_emails SET archived_at = now() - make_interval(secs => ${long / 1000})
      WHERE id = ${stale.id}
    `
    await h.sql`
      UPDATE inbound_emails SET archived_at = now() - make_interval(secs => ${short / 1000})
      WHERE id = ${fresh.id}
    `

    const due = await h.sql<{ id: string; attachments: { key: string }[] }[]>`
      SELECT id, attachments FROM inbound_emails
      WHERE archived_at IS NOT NULL AND archived_at < ${cutoff}
      ORDER BY archived_at ASC
    `
    expect(due.map((r) => r.id)).toEqual([stale.id])
    expect(due[0]?.attachments?.[0]?.key).toBe("inbound-emails/stale/1-a.pdf")
    expect(due.map((r) => r.id)).not.toContain(fresh.id)
    expect(due.map((r) => r.id)).not.toContain(unread.id)
  })
})
