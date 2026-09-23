import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { runInboundSweep } from "../../src/services/admin/inbound-sweep.js"
import {
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { JURISDICTION_REPLY_NOTE } from "../../src/services/admin/inbound-thread-correlation.js"
import type { Container } from "../../src/di.js"

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
  const deps: InboundProcessorDeps = {
    storage,
    inboundMail: new FakeInboundMail(),
    mailRepo,
    inboundRepo,
  }
  const container = { env: {}, storage } as unknown as Container
  return { storage, mailRepo, inboundRepo, deps, container }
}

describe("runInboundSweep", () => {
  it("drains all pending catch-all objects and deletes each", async () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      await h.storage.put(
        `${INBOUND_PENDING_PREFIX}m${i}.eml`,
        rfc822("support@civfix.org", `q${i}`, `<m${i}@x>`),
      )
    }
    const result = await runInboundSweep(h.container, { deps: h.deps })
    expect(result.scanned).toBe(4)
    expect(result.processed).toBe(4)
    expect(h.inboundRepo.rows).toHaveLength(4)
    expect((await h.storage.list(INBOUND_PENDING_PREFIX)).keys).toHaveLength(0)
  })

  it("honors a bounded batch so a backlog drains across runs", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      await h.storage.put(
        `${INBOUND_PENDING_PREFIX}m${i}.eml`,
        rfc822("hi@civfix.org", `q${i}`, `<b${i}@x>`),
      )
    }
    const result = await runInboundSweep(h.container, { batch: 2, deps: h.deps })
    expect(result.scanned).toBe(2)
    expect((await h.storage.list(INBOUND_PENDING_PREFIX)).keys).toHaveLength(3)
  })

  it("surfaces an R2 LIST failure as listError without throwing (misscoped token -> 403)", async () => {
    const h = harness()
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
    await h.storage.put(
      `${INBOUND_PENDING_PREFIX}good.eml`,
      rfc822("support@civfix.org", "ok", "<g@x>"),
    )
    await h.storage.put(
      `${INBOUND_PENDING_PREFIX}good2.eml`,
      rfc822("hello@civfix.org", "ok2", "<g2@x>"),
    )
    const result = await runInboundSweep(h.container, { deps: h.deps })
    expect(result.scanned).toBe(2)
    expect(result.errors).toBe(0)
    expect(h.inboundRepo.rows).toHaveLength(2)
  })
})

describe("runInboundSweep: side-effect re-drive", () => {
  const TOKEN = "0123456789abcdef01234567"

  function reply(body: string): Buffer {
    return Buffer.from(
      [
        "From: clerk@lacity.gov",
        `To: reply+${TOKEN}@civfix.org`,
        "Message-ID: <reply-redrive@lacity.gov>",
        "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=lacity.gov",
        "",
        body,
      ].join("\n"),
      "utf8",
    )
  }

  function redriveHarness() {
    const storage = new FakeStorage()
    const mailRepo = new InMemoryMailRepository()
    const inboundRepo = new InMemoryInboundRepository()
    const adminReportRepo = new InMemoryAdminReportRepository()
    const notifier = new RecordingNotifier()
    const deps: InboundProcessorDeps = {
      storage,
      inboundMail: new FakeInboundMail(),
      mailRepo,
      inboundRepo,
      adminReportRepo,
      notifications: notifier,
    }
    const container = {
      env: { USE_FAKE_CHAT: true },
      storage,
      inboundStorage: storage,
      getDb: () => {
        throw new Error("this harness has no DB: every dep is injected")
      },
    } as unknown as Container
    return { storage, mailRepo, inboundRepo, adminReportRepo, notifier, deps, container }
  }

  it("a first attempt that THROWS is retried by the next run and applies its effects exactly once", async () => {
    const h = redriveHarness()
    const reportId = "report-redrive"
    h.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = h.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    h.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "pw@lacity.gov" })

    let fail = true
    const realGetReport = h.adminReportRepo.getReport.bind(h.adminReportRepo)
    h.adminReportRepo.getReport = (id) => {
      if (fail) {
        fail = false
        return Promise.reject(new Error("db down"))
      }
      return realGetReport(id)
    }

    await h.storage.put(`${INBOUND_PENDING_PREFIX}redrive.eml`, reply("Crew dispatched."))
    const first = await runInboundSweep(h.container, {
      deps: h.deps,
      now: () => new Date(Date.UTC(2026, 0, 1)),
    })

    expect(first.processed).toBe(1)
    expect(first.effectsRedriven).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
    const stored = h.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")
    expect(stored?.effectsAppliedAt).toBeNull()

    const second = await runInboundSweep(h.container, {
      deps: h.deps,
      effectsMinAgeMs: 0,
      now: () => new Date(Date.UTC(2030, 0, 1)),
    })

    expect(second.effectsRedriven).toBe(1)
    expect(second.effectsErrors).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    const timeline = h.adminReportRepo.timeline.get(reportId) ?? []
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.note).toBe(JURISDICTION_REPLY_NOTE)

    const third = await runInboundSweep(h.container, {
      deps: h.deps,
      effectsMinAgeMs: 0,
      now: () => new Date(Date.UTC(2030, 0, 1)),
    })
    expect(third.effectsRedriven).toBe(0)
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
  })

  it("never re-drives an UNAFFILIATED message, however often the sweep runs", async () => {
    const h = redriveHarness()
    const reportId = "report-unaffiliated"
    h.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = h.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    h.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "pw@lacity.gov" })
    h.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "Send me the resident's details.",
      unaffiliated: true,
    })

    const res = await runInboundSweep(h.container, {
      deps: h.deps,
      effectsMinAgeMs: 0,
      now: () => new Date(Date.UTC(2030, 0, 1)),
    })

    expect(res.effectsRedriven).toBe(0)
    expect(res.effectsErrors).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(0)
  })

  it("reports a re-drive failure as a counted error instead of swallowing it", async () => {
    const h = redriveHarness()
    const reportId = "report-hard-fail"
    h.adminReportRepo.seedReport({ id: reportId, status: "published", reporter: null })
    const thread = h.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    h.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "pw@lacity.gov" })
    h.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "Crew dispatched.",
    })
    h.adminReportRepo.getReport = () => Promise.reject(new Error("db down"))

    const res = await runInboundSweep(h.container, {
      deps: h.deps,
      effectsMinAgeMs: 0,
      now: () => new Date(Date.UTC(2030, 0, 1)),
    })

    expect(res.effectsErrors).toBe(1)
    expect(res.effectsRedriven).toBe(0)
    const stored = h.mailRepo.messagesOf(thread.id).find((m) => m.direction === "in")
    expect(stored?.effectsAppliedAt).toBeNull()
  })
})

describe("runInboundSweep: crash-safe lease + idempotent re-drive (B4)", () => {
  const TOKEN = "0123456789abcdef01234567"

  function harness() {
    const storage = new FakeStorage()
    const mailRepo = new InMemoryMailRepository()
    const inboundRepo = new InMemoryInboundRepository()
    const adminReportRepo = new InMemoryAdminReportRepository()
    const notifier = new RecordingNotifier()
    const deps: InboundProcessorDeps = {
      storage,
      inboundMail: new FakeInboundMail(),
      mailRepo,
      inboundRepo,
      adminReportRepo,
      notifications: notifier,
    }
    const container = {
      env: { USE_FAKE_CHAT: true },
      storage,
      inboundStorage: storage,
      getDb: () => {
        throw new Error("this harness has no DB: every dep is injected")
      },
    } as unknown as Container
    return { mailRepo, adminReportRepo, notifier, deps, container }
  }

  function seed(h: ReturnType<typeof harness>, reportId: string) {
    h.adminReportRepo.seedReport({
      id: reportId,
      status: "published",
      reporter: {
        id: "u-1",
        name: "Jane",
        handle: "jane",
        emailVerified: true,
        hasOauth: false,
        joinedAt: new Date("2025-01-01T00:00:00Z"),
      },
    })
    const thread = h.mailRepo.seedThread({ threadToken: TOKEN, reportId, status: "sent" })
    h.mailRepo.seedMessage({ threadId: thread.id, direction: "out", toAddr: "pw@lacity.gov" })
    const inbound = h.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "Crew dispatched.",
      messageId: "<b4@lacity.gov>",
    })
    return { thread, inbound }
  }

  function sweepAt(h: ReturnType<typeof harness>, at: Date) {
    return runInboundSweep(h.container, { deps: h.deps, effectsMinAgeMs: 0, now: () => at })
  }

  it("a runner that DIES after claiming is re-driven once the lease expires — exactly once", async () => {
    const h = harness()
    const reportId = "report-crash"
    const { inbound } = seed(h, reportId)

    expect(
      await h.mailRepo.claimMessageEffects(inbound.id, {
        leaseBefore: new Date(Date.UTC(2026, 0, 1)),
      }),
    ).toBe(0)

    const withinLease = new Date(Date.UTC(2026, 0, 1, 0, 5))
    expect((await sweepAt(h, withinLease)).effectsRedriven).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")

    const afterLease = new Date(Date.UTC(2026, 0, 1, 1, 0))
    const reclaimed = await sweepAt(h, afterLease)
    expect(reclaimed.effectsRedriven).toBe(1)
    expect(reclaimed.effectsErrors).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(1)

    const later = new Date(Date.UTC(2026, 0, 1, 3, 0))
    expect((await sweepAt(h, later)).effectsRedriven).toBe(0)
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(1)
  })

  it("a throw AFTER the timeline write re-drives without duplicating the timeline row or the push", async () => {
    const h = harness()
    const reportId = "report-partial"
    seed(h, reportId)

    h.notifier.failNext = true

    const first = await sweepAt(h, new Date(Date.UTC(2026, 0, 1, 1, 0)))
    expect(first.effectsErrors).toBe(1)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(0)

    const second = await sweepAt(h, new Date(Date.UTC(2026, 0, 1, 1, 1)))
    expect(second.effectsRedriven).toBe(1)
    expect(second.effectsErrors).toBe(0)

    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(1)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("in_progress")

    const third = await sweepAt(h, new Date(Date.UTC(2026, 0, 1, 2, 0)))
    expect(third.effectsRedriven).toBe(0)
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(1)
    expect(h.notifier.sent).toHaveLength(1)
  })

  it("B1: a settled pre-migration row is never re-driven", async () => {
    const h = harness()
    const reportId = "report-legacy"
    const { inbound } = seed(h, reportId)

    await h.mailRepo.setMessageEffectsStage(inbound.id, 3)
    await h.mailRepo.markMessageEffectsApplied(inbound.id)

    const res = await sweepAt(h, new Date(Date.UTC(2026, 0, 2)))

    expect(res.effectsRedriven).toBe(0)
    expect(res.effectsErrors).toBe(0)
    expect(h.adminReportRepo.reports.get(reportId)?.record.status).toBe("published")
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(0)
    expect(h.notifier.sent).toHaveLength(0)
    expect((await h.mailRepo.getThreadRecord(inbound.threadId))?.status).toBe("sent")
  })

  it("a live claim by another runner is left alone", async () => {
    const h = harness()
    const reportId = "report-leased"
    const { inbound } = seed(h, reportId)

    await h.mailRepo.claimMessageEffects(inbound.id, {
      leaseBefore: new Date(Date.UTC(2026, 0, 1)),
    })

    const res = await sweepAt(h, new Date(Date.UTC(2026, 0, 1, 0, 1)))
    expect(res.effectsRedriven).toBe(0)
    expect(res.effectsErrors).toBe(0)
    expect(h.adminReportRepo.timeline.get(reportId) ?? []).toHaveLength(0)
  })
})
