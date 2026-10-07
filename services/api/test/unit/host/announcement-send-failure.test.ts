import { describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../helpers/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../../src/services/host/broadcast-service.js"
import { makeAnnouncementService } from "../../../src/services/host/announcement-service.js"
import type { AnnouncementIdentityRepository } from "../../../src/services/host/announcement-identity-repository.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 2,
  emailRatePerSec: 1000,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

const identities: AnnouncementIdentityRepository = {
  authorsFor: () => Promise.resolve(new Map()),
  organizationFor: () => Promise.resolve(null),
}

function harness(enqueuePlan: () => Promise<void>) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent({
    cleanupId: EVENT,
    title: "Beach Cleanup",
    pageSlug: "beach-cleanup",
    scheduledAt: new Date("2026-02-01T17:00:00Z"),
    endsAt: null,
    timezone: "America/Los_Angeles",
    address: null,
    status: "upcoming",
    organizerUserId: HOST,
    replyTo: null,
    replyToVerified: false,
  })
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const broadcasts = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan,
  })
  const service = makeAnnouncementService({ repo, identities, broadcasts, config: CONFIG, logger })
  return { repo, service, logger }
}

const body = { id: EVENT, bodyMd: "Meet at the pavilion.", audience: { kind: "all_registered" } }

describe("announcement create when the plan job cannot be enqueued", () => {
  it("rethrows and leaves no announcement behind that would still be sent", async () => {
    const h = harness(() => Promise.reject(new Error("queue down")))
    await expect(h.service.create(EVENT, HOST, body as never)).rejects.toThrow("queue down")
    expect(await h.repo.countAnnouncementsSince(EVENT, new Date(0))).toBe(0)
    const { items } = await h.service.list(EVENT, { id: EVENT }, { host: true })
    expect(items).toHaveLength(0)
  })

  it("logs a draft it could not clean up and still surfaces the original failure", async () => {
    const h = harness(() => Promise.reject(new Error("queue down")))
    h.repo.deleteDraft = () => Promise.reject(new Error("db down"))
    await expect(h.service.create(EVENT, HOST, body as never)).rejects.toThrow("queue down")
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
  })
})
