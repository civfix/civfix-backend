import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Container } from "../../src/di.js"
import { RecordingNotifier } from "../helpers/notifications.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import { applyInboundEffects } from "../../src/services/admin/inbound-thread-correlation.js"
import {
  makeMailReplyPublishService,
  MAIL_REPLY_NOT_FOUND,
  MAIL_REPLY_NOT_PUBLISHABLE,
} from "../../src/services/admin/mail-reply-publish-service.js"
import type { ReportTimelineEvent } from "../../src/services/report-timeline-event.js"

const REPORT_ID = "report-1"
const OPERATOR_ID = "operator-1"

function harness() {
  const repo = new InMemoryMailRepository()
  const reports = new InMemoryAdminReportRepository()
  const cleanups = new InMemoryCleanupRepository()
  const notifier = new RecordingNotifier()
  const emitted: ReportTimelineEvent[] = []
  const chat = { fail: false }
  const warnings: (string | undefined)[] = []
  reports.seedReport({
    id: REPORT_ID,
    status: "published",
    reporter: {
      id: "reporter-1",
      name: "Jane",
      handle: "jane",
      emailVerified: true,
      hasOauth: false,
      joinedAt: new Date("2025-01-01T00:00:00Z"),
    },
  })
  const effects = {
    reportRepo: reports,
    cleanupRepo: cleanups,
    notifications: notifier,
    chatEmitter: {
      emit: (event: ReportTimelineEvent) => {
        if (chat.fail) return Promise.reject(new Error("chat insert failed"))
        emitted.push(event)
        return Promise.resolve()
      },
    },
  }
  const container = { env: {} } as unknown as Container
  const service = makeMailReplyPublishService({
    repo,
    applyEffects: (thread, message, publishedBy) =>
      applyInboundEffects(container, effects, repo, thread, message, { publishedBy }),
    logger: { warn: (_obj, msg) => warnings.push(msg) },
  })
  const withheld = (link: { reportId?: string; cleanupId?: string }) => {
    const thread = repo.seedThread({ ...link, status: "needs_action" })
    const message = repo.seedMessage({
      threadId: thread.id,
      direction: "in",
      fromAddr: "clerk@pw.lacity.gov",
      body: "Crew scheduled for Friday.",
      unaffiliated: true,
      authVerdict: "fail",
    })
    return { threadId: thread.id, messageId: message.id, message, actorId: OPERATOR_ID }
  }
  return {
    repo,
    reports,
    cleanups,
    notifier,
    emitted,
    chat,
    warnings,
    service,
    withheld,
    container,
    effects,
  }
}

describe("makeMailReplyPublishService", () => {
  it("approves, audits and publishes a withheld report reply exactly once", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })

    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect(h.reports.reports.get(REPORT_ID)?.record.status).toBe("in_progress")
    expect(h.emitted.map((e) => e.body)).toEqual(["Crew scheduled for Friday."])
    expect(h.notifier.sent).toHaveLength(1)
    expect((await h.repo.getThreadRecord(input.threadId))?.status).toBe("replied")
    expect(h.repo.audits).toEqual([
      {
        actorId: OPERATOR_ID,
        action: "mail.reply_published",
        target: `mail:${input.threadId}`,
        meta: {
          messageId: input.messageId,
          reportId: REPORT_ID,
          cleanupId: null,
          authVerdict: "fail",
          fromDomain: "pw.lacity.gov",
        },
      },
    ])

    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect([h.repo.audits.length, h.emitted.length, h.notifier.sent.length]).toEqual([1, 1, 1])
  })

  it("answers pending when the effects fail and lets a retry or the sweep finish", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })
    h.chat.fail = true

    expect(await h.service.publish(input)).toEqual({ publication: "pending" })
    expect(h.warnings).toEqual([
      "mail: publishing an approved reply failed (claim released; the sweep re-drives it)",
    ])
    expect(input.message).toMatchObject({ unaffiliated: false, effectsClaimedAt: null })
    const owed = await h.repo.findMessagesPendingEffects({
      before: new Date(Date.now() + 60_000),
      leaseBefore: new Date(),
      limit: 10,
    })
    expect(owed.map((p) => p.message.id)).toEqual([input.messageId])

    h.chat.fail = false
    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect([h.repo.audits.length, h.emitted.length]).toEqual([1, 1])
  })

  it("answers pending without publishing while another runner holds the effects lease", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })
    input.message.effectsClaimedAt = new Date()

    expect(await h.service.publish(input)).toEqual({ publication: "pending" })
    expect(h.emitted).toHaveLength(0)
  })

  it("keeps the thread in review until its last withheld reply is published", async () => {
    const h = harness()
    const first = h.withheld({ reportId: REPORT_ID })
    const second = h.repo.seedMessage({
      threadId: first.threadId,
      direction: "in",
      fromAddr: "crew@pw.lacity.gov",
      body: "Done.",
      unaffiliated: true,
      authVerdict: "fail",
    })
    const status = async () => (await h.repo.getThreadRecord(first.threadId))?.status

    expect(await h.service.publish(first)).toEqual({ publication: "published" })
    expect(await status()).toBe("needs_action")
    expect(await h.service.publish({ ...first, messageId: second.id })).toEqual({
      publication: "published",
    })
    expect(await status()).toBe("replied")
  })

  it("adds a withheld event reply to the event timeline", async () => {
    const h = harness()
    const input = h.withheld({ cleanupId: "cleanup-1" })

    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect(h.cleanups.timeline.map((t) => [t.cleanupId, t.kind])).toEqual([
      ["cleanup-1", "city_reply"],
    ])
    expect((await h.repo.getThreadRecord(input.threadId))?.status).toBe("replied")
  })

  it("refuses a message that is not an inbound reply on the thread, and an unlinked thread", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })
    const other = h.repo.seedThread({ reportId: "report-2" })
    const outbound = h.repo.seedMessage({ threadId: input.threadId, direction: "out" })
    const loose = h.withheld({})

    await expect(h.service.publish({ ...input, threadId: other.id })).rejects.toMatchObject({
      httpStatus: 404,
      message: MAIL_REPLY_NOT_FOUND,
    })
    await expect(h.service.publish({ ...input, messageId: outbound.id })).rejects.toMatchObject({
      httpStatus: 404,
    })
    await expect(h.service.publish({ ...input, threadId: randomUUID() })).rejects.toMatchObject({
      httpStatus: 404,
    })
    await expect(h.service.publish(loose)).rejects.toMatchObject({
      httpStatus: 409,
      message: MAIL_REPLY_NOT_PUBLISHABLE,
    })
    expect(h.repo.audits).toHaveLength(0)
    expect([input.message.unaffiliated, loose.message.unaffiliated]).toEqual([true, true])
  })

  it("audits the operator who publishes a verified reply whose effects are still owed", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })
    input.message.unaffiliated = false
    input.message.authVerdict = "pass"

    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect(await h.service.publish({ ...input, actorId: "operator-2" })).toEqual({
      publication: "published",
    })
    expect(h.repo.audits).toEqual([
      expect.objectContaining({
        actorId: OPERATOR_ID,
        action: "mail.reply_published",
        meta: expect.objectContaining({ messageId: input.messageId, authVerdict: "pass" }),
      }),
    ])
  })

  it("writes one publish audit row when operators publish the same reply at once", async () => {
    const h = harness()
    const verified = h.withheld({ reportId: REPORT_ID })
    verified.message.unaffiliated = false
    const withheld = h.withheld({ cleanupId: "cleanup-1" })

    for (const input of [verified, withheld]) {
      const racers = ["operator-2", "operator-3"].map((actorId) =>
        h.service.publish({ ...input, actorId }),
      )
      await Promise.all(racers)
      expect(input.message.effectsAppliedAt).not.toBeNull()
    }
    const published = h.repo.audits.map((a) => a.meta?.["messageId"])
    expect(published.sort()).toEqual([verified.messageId, withheld.messageId].sort())
  })

  it("leaves no operator audit on a reply the sweep published", async () => {
    const h = harness()
    const input = h.withheld({ reportId: REPORT_ID })
    input.message.unaffiliated = false
    const thread = (await h.repo.getThreadRecord(input.threadId))!
    await applyInboundEffects(h.container, h.effects, h.repo, thread, input.message)

    expect(await h.service.publish(input)).toEqual({ publication: "published" })
    expect(h.repo.audits).toHaveLength(0)
  })
})
