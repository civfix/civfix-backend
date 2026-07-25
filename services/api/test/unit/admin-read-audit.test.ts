import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import type { Container } from "../../src/di.js"
import { auditRead } from "../../src/routes/admin/_audit-read.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

/**
 * L4: every admin READ used to be unaudited — including GET /admin/users/:id/messages, which dumps the full
 * TEXT of one user's private DMs, group chats and report chats, INCLUDING messages they soft-deleted. That
 * disclosure left no trace of who made it.
 *
 * Four per-SUBJECT reads now write an audit row (user detail, user messages, inbox detail, mail thread).
 * Aggregate/list/analytics reads stay unaudited by design (documented in audit.routes.ts). These tests pin
 * the helper the four routes share: it writes an audit_log row naming the operator and the subject, and it
 * NEVER throws — unlike a write, a read must not 500 because the audit insert failed.
 */

/** A minimal FastifyRequest stand-in: auditRead only uses `request.log.warn`. */
function fakeRequest(): { request: FastifyRequest; warnings: unknown[] } {
  const warnings: unknown[] = []
  const request = {
    log: {
      warn: (obj: unknown) => {
        warnings.push(obj)
      },
    },
  } as unknown as FastifyRequest
  return { request, warnings }
}

describe("L4: auditRead", () => {
  it("inserts an audit_log row with the operator, the action and the subject", async () => {
    const fake = makeFakeSql([{ match: /INSERT INTO audit_log/i, rows: [{ id: "audit-1" }] }])
    const container = { getDb: () => ({ sql: fake.sql }) } as unknown as Container
    const { request, warnings } = fakeRequest()

    await auditRead(request, container, "op-1", {
      action: "user.messages_viewed",
      target: "user:u-1",
      meta: { returned: 20 },
    })

    const insert = fake.statements.find((s) => /INSERT INTO audit_log/i.test(s.sql))
    expect(insert).toBeDefined()
    // actor_id, action, target, meta — in the writeAudit column order.
    expect(insert?.values.slice(0, 3)).toEqual(["op-1", "user.messages_viewed", "user:u-1"])
    expect(insert?.values[3]).toMatchObject({ returned: 20 })
    expect(warnings).toHaveLength(0)
  })

  it("does NOT throw when the audit write fails — a read must not 500 on an audit hiccup", async () => {
    const container = {
      getDb: () => {
        throw new Error("no DATABASE_URL configured")
      },
    } as unknown as Container
    const { request, warnings } = fakeRequest()

    await expect(
      auditRead(request, container, "op-1", {
        action: "inbox.message_viewed",
        target: "inbound_email:i-1",
      }),
    ).resolves.toBeUndefined()
    // The failure is surfaced in the log rather than swallowed silently.
    expect(warnings).toHaveLength(1)
  })
})
