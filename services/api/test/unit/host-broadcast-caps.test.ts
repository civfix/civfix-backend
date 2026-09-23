import { describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCounterStore, type CounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import {
  BroadcastCapError,
  capError,
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const HOST = "00000000-0000-0000-0000-0000000000aa"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 2,
  recipientsPerDay: 10,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 4,
  emailRatePerSec: 10,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: "unsubscribe-signing-key-for-tests-0123456789",
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

function build(
  overrides: {
    config?: Partial<BroadcastConfig>
    host?: Parameters<InMemoryBroadcastRepository["seedHost"]>[1]
    counters?: CounterStore
  } = {},
) {
  const repo = new InMemoryBroadcastRepository()
  repo.seedEvent({
    cleanupId: EVENT,
    title: "Beach Cleanup",
    pageSlug: "beach-cleanup",
    scheduledAt: new Date("2026-02-01T17:00:00Z"),
    endsAt: null,
    timezone: "UTC",
    address: null,
    status: "upcoming",
    organizerUserId: HOST,
    replyTo: null,
    replyToVerified: false,
  })
  repo.seedHost(HOST, { accountCreatedAt: new Date("2020-01-01T00:00:00Z"), ...overrides.host })
  const counters = overrides.counters ?? new InMemoryCounterStore()
  const service = makeBroadcastService({
    repo,
    counters,
    config: { ...CONFIG, ...overrides.config },
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  return { repo, counters, service }
}

async function capKind(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return "none"
  } catch (err) {
    if (err instanceof BroadcastCapError) return err.kind
    throw err
  }
}

describe("broadcast caps", () => {
  it("refuses when the global kill switch is on", async () => {
    const { service } = build({ config: { killSwitch: true } })
    expect(await capKind(() => service.assertComposeAllowed(EVENT, HOST))).toBe("kill_switch")
  })

  it("refuses a per-host suspension", async () => {
    const { service } = build({ host: { suspended: true } })
    expect(await capKind(() => service.assertComposeAllowed(EVENT, HOST))).toBe("suspended")
  })

  it("refuses an unverified email address", async () => {
    const { service } = build({ host: { emailVerified: false } })
    expect(await capKind(() => service.assertComposeAllowed(EVENT, HOST))).toBe("unverified_email")
  })

  it("refuses an account younger than the minimum age", async () => {
    const { service } = build({ host: { accountCreatedAt: new Date() } })
    expect(await capKind(() => service.assertComposeAllowed(EVENT, HOST))).toBe("account_too_new")
  })

  it("refuses a second send inside the cooldown window", async () => {
    const { service } = build()
    await service.reserveSendSlot(EVENT, HOST)
    expect(await capKind(() => service.reserveSendSlot(EVENT, HOST))).toBe("cooldown")
  })

  it("refuses past the per-event daily limit, across hosts", async () => {
    const counters = new InMemoryCounterStore()
    const first = build({ config: { perEventPerDay: 1 }, counters })
    const secondHost = "00000000-0000-0000-0000-0000000000bb"
    first.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    await first.service.reserveSendSlot(EVENT, HOST)
    expect(await capKind(() => first.service.reserveSendSlot(EVENT, secondHost))).toBe(
      "per_event_per_day",
    )
  })

  it("does not spend the host's cooldown on a send the per-event limit refused", async () => {
    const counters = new InMemoryCounterStore()
    const first = build({ config: { perEventPerDay: 1 }, counters })
    const secondHost = "00000000-0000-0000-0000-0000000000bb"
    first.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    await first.service.reserveSendSlot(EVENT, HOST)
    expect(await capKind(() => first.service.reserveSendSlot(EVENT, secondHost))).toBe(
      "per_event_per_day",
    )

    const roomier = build({ config: { perEventPerDay: 2 }, counters })
    roomier.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    expect(await capKind(() => roomier.service.reserveSendSlot(EVENT, secondHost))).toBe("none")
  })

  it("does not charge the per-event limit for a send it refused", async () => {
    const counters = new InMemoryCounterStore()
    const first = build({ config: { perEventPerDay: 1 }, counters })
    const hosts = ["00000000-0000-0000-0000-0000000000bb", "00000000-0000-0000-0000-0000000000cc"]
    for (const host of hosts) {
      first.repo.seedHost(host, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    }
    await first.service.reserveSendSlot(EVENT, HOST)
    expect(await capKind(() => first.service.reserveSendSlot(EVENT, hosts[0]!))).toBe(
      "per_event_per_day",
    )

    const roomier = build({ config: { perEventPerDay: 2 }, counters })
    roomier.repo.seedHost(hosts[1]!, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    expect(await capKind(() => roomier.service.reserveSendSlot(EVENT, hosts[1]!))).toBe("none")
  })

  it("leaves no cooldown behind when a double click is refused on both counters", async () => {
    const counters = new InMemoryCounterStore()
    const first = build({ config: { perEventPerDay: 1 }, counters })
    const secondHost = "00000000-0000-0000-0000-0000000000bb"
    first.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    await first.service.reserveSendSlot(EVENT, HOST)
    const kinds = await Promise.all([
      capKind(() => first.service.reserveSendSlot(EVENT, secondHost)),
      capKind(() => first.service.reserveSendSlot(EVENT, secondHost)),
    ])
    expect(kinds.sort()).toEqual(["cooldown", "per_event_per_day"])

    const roomier = build({ config: { perEventPerDay: 2 }, counters })
    roomier.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    expect(await capKind(() => roomier.service.reserveSendSlot(EVENT, secondHost))).toBe("none")
  })

  it("keeps the per-event refusal when the cooldown cannot be given back", async () => {
    const memory = new InMemoryCounterStore()
    const counters: CounterStore = {
      incr: (key, ttl) => memory.incr(key, ttl),
      incrBy: (key, by, ttl) => memory.incrBy(key, by, ttl),
      decrBy: () => Promise.reject(new Error("redis down")),
    }
    const first = build({ config: { perEventPerDay: 1 }, counters })
    const secondHost = "00000000-0000-0000-0000-0000000000bb"
    first.repo.seedHost(secondHost, { accountCreatedAt: new Date("2020-01-01T00:00:00Z") })
    await first.service.reserveSendSlot(EVENT, HOST)
    expect(await capKind(() => first.service.reserveSendSlot(EVENT, secondHost))).toBe(
      "per_event_per_day",
    )
  })

  it("fails CLOSED when the counter store is unavailable", async () => {
    const broken: CounterStore = {
      incr: () => Promise.reject(new Error("redis down")),
      incrBy: () => Promise.reject(new Error("redis down")),
      decrBy: () => Promise.reject(new Error("redis down")),
    }
    const { service } = build({ counters: broken })
    expect(await capKind(() => service.reserveSendSlot(EVENT, HOST))).toBe("counter_unavailable")
  })

  it("fails CLOSED on the recipient budget when the counter store is unavailable", async () => {
    const broken: CounterStore = {
      incr: () => Promise.reject(new Error("redis down")),
      incrBy: () => Promise.reject(new Error("redis down")),
      decrBy: () => Promise.reject(new Error("redis down")),
    }
    const { service } = build({ counters: broken })
    expect(await service.reserveRecipientBudget(HOST, 10)).toBe(false)
  })

  it("reserves the recipient budget atomically and refuses past the limit", async () => {
    const { service } = build({ config: { recipientsPerDay: 10 } })
    expect(await service.reserveRecipientBudget(HOST, 7)).toBe(true)
    expect(await service.reserveRecipientBudget(HOST, 3)).toBe(true)
    expect(await service.reserveRecipientBudget(HOST, 1)).toBe(false)
  })

  it("maps each cap onto a sensible HTTP error code", () => {
    expect(capError("cooldown").code).toBe("RATE_LIMITED")
    expect(capError("per_event_per_day").code).toBe("RATE_LIMITED")
    expect(capError("recipients_per_day").code).toBe("RATE_LIMITED")
    expect(capError("suspended").code).toBe("CONFLICT")
    expect(capError("kill_switch").code).toBe("CONFLICT")
    expect(capError("counter_unavailable").code).toBe("CONFLICT")
    expect(capError("unverified_email").code).toBe("FORBIDDEN")
    expect(capError("account_too_new").code).toBe("FORBIDDEN")
  })
})

describe("org suspension gate (DECISIONS §32)", () => {
  const body = {
    id: EVENT,
    subject: "Bring gloves",
    bodyMd: "See you at the meeting point.",
    segment: { kind: "all_registered" as const },
    channels: ["email" as const],
  }

  it("refuses create, send and schedule for an event linked to a suspended org", async () => {
    const { repo, service } = build()
    const draft = await service.create(EVENT, HOST, body)
    repo.setEventOrganizationSuspended(EVENT, true)
    await expect(service.create(EVENT, HOST, body)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(service.send(EVENT, HOST, draft.id)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      service.schedule(EVENT, HOST, draft.id, new Date(Date.now() + 3_600_000)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Nothing moved: the draft is still a draft and no send slot was consumed.
    expect((await repo.findById(draft.id))?.status).toBe("draft")
    // Lifting the flag restores the lever.
    repo.setEventOrganizationSuspended(EVENT, false)
    const sent = await service.send(EVENT, HOST, draft.id)
    expect(sent.status).toBe("sending")
  })

  it("is a different lever from the per-host messaging suspension", async () => {
    const { repo, service } = build({ host: { suspended: true } })
    repo.setEventOrganizationSuspended(EVENT, false)
    expect(await capKind(() => service.create(EVENT, HOST, body))).toBe("suspended")
  })

  it("404s a broadcast for an event that does not exist", async () => {
    const { service } = build()
    await expect(
      service.create("00000000-0000-0000-0000-0000000000ff", HOST, body),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("broadcast content gates", () => {
  it("refuses a body with a non-https link", async () => {
    const { service } = build()
    await expect(
      service.create(EVENT, HOST, {
        id: EVENT,
        subject: "hi",
        bodyMd: "come to http://civfix.org",
        segment: { kind: "all_registered" },
        channels: ["email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses a CTA url that is an IP literal", async () => {
    const { service } = build()
    await expect(
      service.create(EVENT, HOST, {
        id: EVENT,
        subject: "hi",
        bodyMd: "details below",
        ctaUrl: "https://203.0.113.9/rsvp",
        ctaLabel: "RSVP",
        segment: { kind: "all_registered" },
        channels: ["email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses a CTA url carrying userinfo", async () => {
    const { service } = build()
    await expect(
      service.create(EVENT, HOST, {
        id: EVENT,
        subject: "hi",
        bodyMd: "details below",
        ctaUrl: "https://user:pw@evil.example/rsvp",
        segment: { kind: "all_registered" },
        channels: ["email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses a CTA url outside the host allowlist", async () => {
    const { service } = build({ config: { linkAllowedHosts: ["civfix.org"] } })
    await expect(
      service.create(EVENT, HOST, {
        id: EVENT,
        subject: "hi",
        bodyMd: "details below",
        ctaUrl: "https://elsewhere.example/rsvp",
        segment: { kind: "all_registered" },
        channels: ["email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("counts the CTA url toward the link cap", async () => {
    const { service } = build()
    const fiveLinks = Array.from({ length: 5 }, (_, i) => `https://civfix.org/${i}`).join(" and ")
    await expect(
      service.create(EVENT, HOST, {
        id: EVENT,
        subject: "hi",
        bodyMd: fiveLinks,
        ctaUrl: "https://civfix.org/rsvp",
        segment: { kind: "all_registered" },
        channels: ["email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("re-checks the CTA url at send", async () => {
    const { repo, service } = build()
    const record = await repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "hi",
      bodyMd: "details below",
      ctaUrl: "https://203.0.113.9/rsvp",
      segment: { kind: "all_registered" },
      channels: ["email"],
    })
    await expect(service.send(EVENT, HOST, record.id)).rejects.toMatchObject({
      code: "VALIDATION",
    })
  })

  it("accepts a clean draft", async () => {
    const { service } = build()
    const dto = await service.create(EVENT, HOST, {
      id: EVENT,
      subject: "Bring gloves",
      bodyMd: "See https://civfix.org/e/beach for details.",
      segment: { kind: "all_registered" },
      channels: ["email"],
    })
    expect(dto.status).toBe("draft")
  })
})

describe("send() consumes a slot only after it wins the transition", () => {
  async function draft(repo: InMemoryBroadcastRepository): Promise<string> {
    const record = await repo.create({
      cleanupId: EVENT,
      createdBy: HOST,
      kind: "host_broadcast",
      subject: "Bring gloves",
      bodyMd: "See you at the meeting point.",
      segment: { kind: "all_registered" },
      channels: ["email"],
      status: "draft",
    })
    return record.id
  }

  it("returns CONFLICT on a second send without burning the per-event day cap", async () => {
    const { repo, service, counters } = build({ config: { perEventPerDay: 2 } })
    const dayKey = `bcast:event:${EVENT}:${new Date().toISOString().slice(0, 10)}`
    const id = await draft(repo)
    await service.send(EVENT, HOST, id)

    await expect(service.send(EVENT, HOST, id)).rejects.toMatchObject({ code: "CONFLICT" })

    expect(await counters.incr(dayKey, 60)).toBe(2)
  })

  it("returns the broadcast to draft when the cap is hit after it won the transition", async () => {
    const { repo, service } = build({ config: { perEventPerDay: 0 } })
    const id = await draft(repo)
    expect(await capKind(() => service.send(EVENT, HOST, id))).toBe("per_event_per_day")
    expect((await repo.findById(id))?.status).toBe("draft")
  })
})
