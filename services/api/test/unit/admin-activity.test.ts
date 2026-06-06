import { describe, it, expect } from "vitest"
import { InMemoryActivityRepository } from "../../src/services/admin/activity-repository.memory.js"
import {
  classifyActivity,
  classifyAuditAction,
  describeAuditAction,
  makeActivityService,
  type ActivityService,
} from "../../src/services/admin/activity-service.js"

/**
 * Offline unit tests for the admin activity-feed service over the in-memory ActivityRepository (no DB, no
 * Docker). Cover the PURE classification (audit action -> kind + verb; domain source -> kind/what/hue) and
 * the service wiring (merge + newest-first + relative ts + the standard page envelope with null cursor).
 * The real UNION query is Docker-gated (test/integration/admin-activity.test.ts).
 */

const NOW = new Date("2026-06-15T12:00:00.000Z")

function harness(): { repo: InMemoryActivityRepository; svc: ActivityService } {
  const repo = new InMemoryActivityRepository()
  const svc = makeActivityService({ repo, now: () => NOW })
  return { repo, svc }
}

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000)
}

describe("classifyAuditAction", () => {
  it("maps audit actions to feed kinds", () => {
    expect(classifyAuditAction("gov_claim.approved")).toBe("gov_onboard")
    expect(classifyAuditAction("discovery.contacts_saved")).toBe("discovery_done")
    expect(classifyAuditAction("moderation.removed")).toBe("mod_action")
    expect(classifyAuditAction("mail.sent")).toBe("outreach_open")
    expect(classifyAuditAction("outreach.digest_sent")).toBe("outreach_open")
    expect(classifyAuditAction("user.banned")).toBe("mod_action")
    expect(classifyAuditAction("report.status_changed")).toBe("mod_action")
    // Unknown action still classifies (never dropped).
    expect(classifyAuditAction("something.new")).toBe("mod_action")
  })
})

describe("describeAuditAction", () => {
  it("gives a human verb for known actions and echoes unknown ones", () => {
    expect(describeAuditAction("gov_claim.approved")).toBe("Approved a gov claim")
    expect(describeAuditAction("user.banned")).toBe("Banned an account")
    expect(describeAuditAction("totally.unknown")).toBe("totally.unknown")
  })
})

describe("classifyActivity (per source)", () => {
  it("classifies a new report as a pin", () => {
    const dto = classifyActivity(
      {
        source: "report",
        id: "r1",
        ts: hoursAgo(2),
        who: "Jane",
        where: "Los Angeles",
        subject: "trash",
      },
      NOW,
    )
    expect(dto.kind).toBe("pin")
    expect(dto.who).toBe("Jane")
    expect(dto.what).toBe("New trash report")
    expect(dto.where).toBe("Los Angeles")
    expect(dto.ts).toBe("2h")
    expect(dto.hue).toMatch(/^#/)
  })

  it("classifies a cleanup as cleanup_plan", () => {
    const dto = classifyActivity(
      { source: "cleanup", id: "c1", ts: hoursAgo(1), who: "Bob", where: "Park", subject: "River cleanup" },
      NOW,
    )
    expect(dto.kind).toBe("cleanup_plan")
    expect(dto.what).toBe("Planned: River cleanup")
  })

  it("classifies mail events as bounce vs open vs delivered", () => {
    const bounced = classifyActivity(
      { source: "mail_event", id: "m1", ts: hoursAgo(1), who: "city@x.gov", where: "x", eventType: "bounced" },
      NOW,
    )
    expect(bounced.kind).toBe("outreach_bounce")
    expect(bounced.what).toBe("Outreach bounced")

    const opened = classifyActivity(
      { source: "mail_event", id: "m2", ts: hoursAgo(1), who: "city@x.gov", where: "x", eventType: "opened" },
      NOW,
    )
    expect(opened.kind).toBe("outreach_open")

    const delivered = classifyActivity(
      { source: "mail_event", id: "m3", ts: hoursAgo(1), who: "city@x.gov", where: "x", eventType: "delivered" },
      NOW,
    )
    expect(delivered.kind).toBe("outreach_open")
    expect(delivered.what).toBe("Outreach delivered")
  })

  it("classifies an audit row via the action map", () => {
    const dto = classifyActivity(
      {
        source: "audit",
        id: "a1",
        ts: hoursAgo(3),
        who: "Operator A",
        where: "gov_claim:123",
        action: "gov_claim.approved",
      },
      NOW,
    )
    expect(dto.kind).toBe("gov_onboard")
    expect(dto.who).toBe("Operator A")
    expect(dto.what).toBe("Approved a gov claim")
  })

  it("falls back to neutral who labels per source", () => {
    expect(
      classifyActivity({ source: "report", id: "r", ts: NOW, who: "", where: "" }, NOW).who,
    ).toBe("A neighbor")
    expect(
      classifyActivity({ source: "audit", id: "a", ts: NOW, who: "", where: "", action: "x.y" }, NOW)
        .who,
    ).toBe("Operator")
  })
})

describe("activity service wiring", () => {
  it("merges sources newest-first and returns a null cursor (capped recent window)", async () => {
    const { repo, svc } = harness()
    repo.seedRecord({ source: "report", id: "r1", ts: hoursAgo(5), who: "A", where: "LA", subject: "trash" })
    repo.seedRecord({
      source: "audit",
      id: "a1",
      ts: hoursAgo(1),
      who: "Op",
      where: "report:1",
      action: "report.status_changed",
    })
    repo.seedRecord({
      source: "cleanup",
      id: "c1",
      ts: hoursAgo(3),
      who: "B",
      where: "Park",
      subject: "Cleanup",
    })

    const res = await svc.list({})
    expect(res.items).toHaveLength(3)
    // Newest first: audit (1h) -> cleanup (3h) -> report (5h).
    expect(res.items.map((i) => i.kind)).toEqual(["mod_action", "cleanup_plan", "pin"])
    expect(res.nextCursor).toBeNull()
  })

  it("respects the limit", async () => {
    const { repo, svc } = harness()
    for (let i = 0; i < 5; i++) {
      repo.seedRecord({ source: "report", id: `r${i}`, ts: hoursAgo(i), who: "A", where: "LA", subject: "trash" })
    }
    const res = await svc.list({ limit: 2 })
    expect(res.items).toHaveLength(2)
  })
})
