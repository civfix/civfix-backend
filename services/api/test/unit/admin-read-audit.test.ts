import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import type { Container } from "../../src/di.js"
import { auditRead } from "../../src/routes/admin/_audit-read.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

// Per-subject admin reads (e.g. a user's private messages, including soft-deleted ones) must leave a trace
// of who made the disclosure. Unlike a write, a read must not 500 because the audit insert failed.

// auditRead only uses `request.log.warn`.
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
    // actor_id, action, target, meta: the insertAuditRow column order.
    expect(insert?.values.slice(0, 3)).toEqual(["op-1", "user.messages_viewed", "user:u-1"])
    expect(insert?.values[3]).toMatchObject({ returned: 20 })
    expect(warnings).toHaveLength(0)
  })

  it("does NOT throw when the audit write fails; a read must not 500 on an audit hiccup", async () => {
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
    expect(warnings).toHaveLength(1)
  })
})
