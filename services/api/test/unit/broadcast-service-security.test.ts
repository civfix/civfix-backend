import { describe, expect, it } from "vitest"
import type { BroadcastKind } from "@civfix/shared"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import {
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
} from "../../src/services/host/broadcast-capability-token.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"
const ATTENDEE = "00000000-0000-0000-0000-0000000000bb"
const KEY = "unsubscribe-signing-key-for-tests-0123456789"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 4,
  emailRatePerSec: 10,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: KEY,
  webBaseUrl: "http://localhost:3000",
  apiBaseUrl: "http://localhost:8080",
  eventUpdatePerEventPerHour: 3,
}

function build() {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent({
    cleanupId: EVENT,
    title: "Beach Cleanup",
    pageSlug: "beach-cleanup",
    scheduledAt: new Date("2026-02-01T17:00:00Z"),
    endsAt: null,
    timezone: "UTC",
    address: null,
    status: "cancelled",
    organizerUserId: HOST,
    replyTo: null,
    replyToVerified: false,
  })
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  const service = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  return { repo, service }
}

async function seed(
  repo: InMemoryBroadcastRepository,
  kind: BroadcastKind,
  status: "draft" | "sending",
): Promise<string> {
  const automated = kind === "event_cancelled" || kind === "event_updated"
  const record = await repo.create({
    cleanupId: EVENT,
    createdBy: automated ? null : HOST,
    kind,
    subject: "The cleanup is off",
    bodyMd: "Sorry, we had to cancel.",
    segment: { kind: "all_registered" },
    channels: ["email"],
  })
  if (status === "sending") {
    await repo.transition(record.id, ["draft"], "sending", { startedAt: new Date() })
  }
  return record.id
}

describe("critical automated notices cannot be stopped by an event team member", () => {
  it("refuses to cancel an event_cancelled notice mid-send with a 409", async () => {
    const { repo, service } = build()
    const id = await seed(repo, "event_cancelled", "sending")

    await expect(service.cancel(EVENT, id)).rejects.toMatchObject({
      code: "CONFLICT",
      httpStatus: 409,
      message: "Automatic messages can't be cancelled.",
    })
    expect((await repo.findById(id))?.status).toBe("sending")
  })

  it("refuses to cancel an event_updated notice", async () => {
    const { repo, service } = build()
    const id = await seed(repo, "event_updated", "sending")

    await expect(service.cancel(EVENT, id)).rejects.toMatchObject({ httpStatus: 409 })
    expect((await repo.findById(id))?.status).toBe("sending")
  })

  it("refuses to edit or delete a critical notice even while it is a draft", async () => {
    const { repo, service } = build()
    const id = await seed(repo, "event_cancelled", "draft")

    await expect(
      service.update(EVENT, HOST, { id: EVENT, broadcastId: id, subject: "Never mind" }),
    ).rejects.toMatchObject({ httpStatus: 409, message: "Automatic messages can't be edited." })
    await expect(service.remove(EVENT, id)).rejects.toMatchObject({
      httpStatus: 409,
      message: "Automatic messages can't be deleted.",
    })
    const after = await repo.findById(id)
    expect(after?.subject).toBe("The cleanup is off")
  })

  it("still lets a host cancel their own message mid-send", async () => {
    const { repo, service } = build()
    const id = await seed(repo, "host_broadcast", "sending")

    const cancelled = await service.cancel(EVENT, id)

    expect(cancelled.status).toBe("cancelled")
  })
})

describe("one-click unsubscribe write failures", () => {
  it("surfaces the failure for a verified token instead of reporting success", async () => {
    const { repo, service } = build()
    repo.recordUnsubscribe = () => Promise.reject(new Error("db down"))
    const token = mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: ATTENDEE,
        cleanupId: EVENT,
        expiresAtMs: unsubscribeExpiryFrom(Date.now()),
      },
      KEY,
    )

    await expect(service.unsubscribe(token)).rejects.toThrow("db down")
  })

  it("never touches the store for a token it cannot verify", async () => {
    const { repo, service } = build()
    let writes = 0
    repo.recordUnsubscribe = () => {
      writes += 1
      return Promise.reject(new Error("db down"))
    }

    await expect(service.unsubscribe("v1.forged.token")).resolves.toEqual({ ok: true })
    expect(writes).toBe(0)
  })
})
