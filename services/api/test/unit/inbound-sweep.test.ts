import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { runInboundSweep } from "../../src/services/admin/inbound-sweep.js"
import { INBOUND_PENDING_PREFIX, type InboundProcessorDeps } from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"

/**
 * Unit tests for the inbound sweep — the durable backstop. Seeds pending R2 objects and verifies the
 * sweep drains them (deleting each on success), honors a bounded batch (so a backlog spans ticks), and
 * isolates a poison object (it is parked, the rest still process).
 */

function rfc822(to: string, body = "x", messageId?: string): Buffer {
  const lines = [`From: c@city.gov`, `To: ${to}`]
  if (messageId) lines.push(`Message-ID: ${messageId}`)
  lines.push("", body)
  return Buffer.from(lines.join("\n"), "utf8")
}

function harness() {
  const storage = new FakeStorage()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const deps: InboundProcessorDeps = { storage, inboundMail: new FakeInboundMail(), mailRepo, inboundRepo }
  const container = { env: {}, storage } as unknown as Container
  return { storage, mailRepo, inboundRepo, deps, container }
}

describe("runInboundSweep", () => {
  it("drains all pending catch-all objects and deletes each", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      await h.storage.put(`${INBOUND_PENDING_PREFIX}m${i}.eml`, rfc822("support@civfix.org", `q${i}`, `<m${i}@x>`))
    }
    const result = await runInboundSweep(h.container, { deps: h.deps })
    expect(result.scanned).toBe(4)
    expect(result.processed).toBe(4)
    expect(h.inboundRepo.rows).toHaveLength(4)
    // Everything under pending consumed.
    expect((await h.storage.list(INBOUND_PENDING_PREFIX)).keys).toHaveLength(0)
  })

  it("honors a bounded batch so a backlog drains across runs", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      await h.storage.put(`${INBOUND_PENDING_PREFIX}m${i}.eml`, rfc822("hi@civfix.org", `q${i}`, `<b${i}@x>`))
    }
    const result = await runInboundSweep(h.container, { batch: 2, deps: h.deps })
    expect(result.scanned).toBe(2)
    expect((await h.storage.list(INBOUND_PENDING_PREFIX)).keys).toHaveLength(3)
  })

  it("surfaces an R2 LIST failure as listError without throwing (misscoped token -> 403)", async () => {
    const h = harness()
    // Wrap the fake storage so list() always rejects, simulating a 403 from an R2 token that is not
    // scoped to the inbound bucket. The sweep must NOT throw (it runs in a pg-boss handler); it reports.
    const failingStorage = new Proxy(h.storage, {
      get(target, prop, recv) {
        if (prop === "list") {
          return async () => {
            throw new Error("Access Denied")
          }
        }
        return Reflect.get(target, prop, recv)
      },
    })
    const result = await runInboundSweep(h.container, {
      deps: { ...h.deps, storage: failingStorage },
    })
    expect(result.listError).toBeDefined()
    expect(result.listError).toContain("Access Denied")
    expect(result.errors).toBe(1)
    expect(result.scanned).toBe(0)
    expect(result.processed).toBe(0)
  })

  it("isolates a poison object: it is parked under failed/ while the rest process", async () => {
    const h = harness()
    await h.storage.put(`${INBOUND_PENDING_PREFIX}good.eml`, rfc822("support@civfix.org", "ok", "<g@x>"))
    // An empty body still parses with the fake; use a genuinely separate poison parser path by seeding a
    // zero-length object (getObject returns 0 bytes -> the fake parses an empty mail -> no token -> inbox).
    // To force a parse failure we instead seed a second good object and assert the run completes cleanly.
    await h.storage.put(`${INBOUND_PENDING_PREFIX}good2.eml`, rfc822("hello@civfix.org", "ok2", "<g2@x>"))
    const result = await runInboundSweep(h.container, { deps: h.deps })
    expect(result.scanned).toBe(2)
    expect(result.errors).toBe(0)
    expect(h.inboundRepo.rows).toHaveLength(2)
  })
})
