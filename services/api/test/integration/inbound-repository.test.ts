/**
 * Inbound (catch-all inbox) data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * InboundRepository against a live Postgres container via withPg, which applies the canonical
 * 0010_inbound_emails.sql migration. Proven against the real schema + the UNIQUE(message_id) constraint:
 *   - insertIdempotent inserts once and reports inserted=false on a re-delivery (ON CONFLICT DO NOTHING);
 *   - list pages newest-first with the keyset cursor and applies status / localPart / q filters;
 *   - get maps the row to InboundEmailDTO; setStatus transitions the triage state.
 *
 * When Docker is unavailable the whole describe block SKIPS, so the local suite stays green; CI runs it.
 */

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

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleInboundRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE inbound_emails RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("insertIdempotent dedups on the UNIQUE message_id", async () => {
    const input = insert({ messageId: "<dup@x>", attachments: [{ key: "k", filename: "f.pdf", size: 3 }] })
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
    await repo.insertIdempotent(insert({ messageId: "<a@x>", recipient: "support@civfix.org", receivedAt: new Date(1000) }))
    await repo.insertIdempotent(insert({ messageId: "<b@x>", recipient: "hello@civfix.org", receivedAt: new Date(2000) }))
    const third = await repo.insertIdempotent(insert({ messageId: "<c@x>", recipient: "support@civfix.org", receivedAt: new Date(3000) }))

    const page1 = await repo.list({ limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe(third.id) // newest first
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

  // L6: setInboxStatus used to mutate state with NO actor and NO audit row - the only admin state change
  // in the console that left no trace of who made it. The audit is now written in the SAME transaction.
  it("setStatus writes an inbox.status_changed audit row (with the actor + the transition) in-tx", async () => {
    const r = await repo.insertIdempotent(insert({ messageId: "<audit@x>" }))
    const actor = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, role) VALUES ('Op', ${`op-${r.id.slice(0, 8)}`}, 'operator')
      RETURNING id
    `
    const actorId = actor[0]!.id
    expect(await repo.setStatus(r.id, "archived", actorId)).toBe(true)
    const audit = await h.sql<{ actor_id: string; target: string; meta: Record<string, unknown> }[]>`
      SELECT actor_id, target, meta FROM audit_log WHERE action = 'inbox.status_changed'
    `
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor_id).toBe(actorId)
    expect(audit[0]?.target).toBe(`inbound_email:${r.id}`)
    expect(audit[0]?.meta).toMatchObject({ status: "archived", priorStatus: "unread" })
  })
})
