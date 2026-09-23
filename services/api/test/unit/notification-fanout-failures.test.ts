import { describe, expect, it } from "vitest"
import { FakePushSender } from "@civfix/shared/fakes"
import { makeNotificationService } from "../../src/services/notification-service.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"

const OK_USER = "11111111-1111-1111-1111-111111111111"
const BROKEN_USER = "22222222-2222-2222-2222-222222222222"
const OTHER_USER = "33333333-3333-3333-3333-333333333333"

function repoFailingFor(userId: string): InMemoryNotificationRepository {
  const repo = new InMemoryNotificationRepository()
  const insert = repo.insertNotification.bind(repo)
  repo.insertNotification = (args) =>
    args.userId === userId ? Promise.reject(new Error("insert failed")) : insert(args)
  return repo
}

describe("fan-out notifications report the recipients whose row was never written", () => {
  it("names exactly the recipient whose insert failed, so a caller can retry only them", async () => {
    const repo = repoFailingFor(BROKEN_USER)
    const service = makeNotificationService({ repo, pushSender: new FakePushSender() })

    const result = await service.createNotificationsReportingFailures(
      [OK_USER, BROKEN_USER, OTHER_USER],
      {
        type: "event_broadcast",
        title: "Parking moved",
        body: "Use the north lot",
        link: "/e/abc",
      },
    )

    expect(result.failed).toEqual([BROKEN_USER])
    expect(repo.notifications.map((n) => n.userId).sort()).toEqual([OK_USER, OTHER_USER].sort())
  })

  it("counts a deduped recipient as delivered, not as a failure", async () => {
    const repo = new InMemoryNotificationRepository()
    const service = makeNotificationService({ repo, pushSender: new FakePushSender() })
    const input = {
      type: "event_broadcast" as const,
      title: "Parking moved",
      body: "Use the north lot",
      link: "/e/abc",
      dedupeWindowMs: 60_000,
    }

    await service.createNotificationsReportingFailures([OK_USER], input)
    const again = await service.createNotificationsReportingFailures([OK_USER], input)

    expect(again.failed).toEqual([])
    expect(repo.notifications).toHaveLength(1)
  })

  it("reports no failures for an empty recipient list", async () => {
    const service = makeNotificationService({
      repo: new InMemoryNotificationRepository(),
      pushSender: new FakePushSender(),
    })

    await expect(
      service.createNotificationsReportingFailures([], { type: "event_broadcast", title: "x" }),
    ).resolves.toEqual({ failed: [] })
  })
})

describe("deduped notifications written concurrently", () => {
  it("writes one row when two writers race on the same dedupe key", async () => {
    const repo = new InMemoryNotificationRepository()
    const service = makeNotificationService({ repo, pushSender: new FakePushSender() })
    const input = {
      type: "event_broadcast" as const,
      title: "Parking moved",
      body: "Use the north lot",
      link: "/e/abc",
      dedupeWindowMs: 60_000,
    }

    await Promise.all([
      service.createNotification(OK_USER, input),
      service.createNotification(OK_USER, input),
    ])

    expect(repo.notifications).toHaveLength(1)
  })
})
