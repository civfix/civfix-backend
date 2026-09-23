import { afterEach, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import { InboxFeedResponseSchema, type InboxFeedResponse } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboxFeedRepository } from "../../src/services/admin/inbox-feed-repository.memory.js"

const OPERATOR = "ops@civfix.org"

interface Harness {
  app: FastifyInstance
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  inbound: InMemoryInboundRepository
  mail: InMemoryMailRepository
  token: string
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.app.close()
  harness = undefined
})

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const services = buildAuthServices({
    stores,
    cache: new InMemoryCacheClient(() => Date.now()),
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR })
  const app = await buildServer({ env, authServices: services })
  const inbound = new InMemoryInboundRepository()
  const mail = new InMemoryMailRepository()
  const feed = new InMemoryInboxFeedRepository(inbound, mail)
  app.adminInboxOverrides = { repo: inbound, storage: new FakeStorage(), feed }
  const user = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const token = await services.sessions.createSession(user.id, ["operator"])
  return { app, services, stores, inbound, mail, token }
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 5, 1, 0, minute, 0))

async function seedEmail(
  h: Harness,
  minute: number,
  opts: { recipient: string; verdict?: string },
): Promise<string> {
  const { id } = await h.inbound.insertIdempotent({
    messageId: `<email-${minute}@x>`,
    fromAddr: "someone@example.com",
    toAddr: opts.recipient,
    recipient: opts.recipient,
    subject: `Email ${minute}`,
    bodyText: "Hello",
    bodyHtml: null,
    headers: opts.verdict === undefined ? {} : { "x-civfix-auth-verdict": opts.verdict },
    attachments: [],
    receivedAt: at(minute),
  })
  return id
}

async function seedMailbox(h: Harness): Promise<Record<string, string>> {
  const e1 = await seedEmail(h, 1, { recipient: "support@civfix.org", verdict: "fail" })
  const e2 = await seedEmail(h, 3, { recipient: "reports@civfix.org" })
  await h.inbound.setStatus(e2, "archived", null)
  const report = h.mail.seedThread({
    reportId: "report-1",
    org: "Streets Dept",
    status: "needs_action",
    unread: true,
  })
  const event = h.mail.seedThread({ cleanupId: "cleanup-1", org: "Parks" })
  const replied = h.mail.seedThread({ reportId: "report-2", org: "Water", status: "replied" })
  const loose = h.mail.seedThread({ org: "Lighting" })
  const reply = (
    threadId: string,
    minute: number,
    over: { unaffiliated?: boolean; applied?: boolean; verdict?: "pass" | "fail" } = {},
  ): string =>
    h.mail.seedMessage({
      threadId,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      subject: `Reply ${minute}`,
      body: "On it.",
      unaffiliated: over.unaffiliated ?? false,
      effectsAppliedAt: over.applied === true ? at(minute) : null,
      authVerdict: over.verdict ?? "pass",
      createdAt: at(minute),
    }).id
  h.mail.seedMessage({ threadId: report.id, direction: "out", createdAt: at(0) })
  return {
    e1,
    e2,
    withheld: reply(report.id, 2, { unaffiliated: true, verdict: "fail" }),
    pending: reply(event.id, 4),
    published: reply(report.id, 5, { applied: true }),
    repliedWithheld: reply(replied.id, 6, { unaffiliated: true }),
    loose: reply(loose.id, 7, { unaffiliated: true }),
    reportThread: report.id,
  }
}

async function feed(h: Harness, qs = ""): Promise<InboxFeedResponse> {
  const res = await h.app.inject({
    method: "GET",
    url: `/v1/admin/inbox/feed${qs}`,
    headers: { authorization: `Bearer ${h.token}` },
  })
  expect(res.statusCode, qs).toBe(200)
  return InboxFeedResponseSchema.parse(res.json())
}

const ids = async (h: Harness, qs: string): Promise<string[]> =>
  (await feed(h, qs)).items.map((item) => item.id)

describe("GET /admin/inbox/feed", () => {
  it("merges unmatched mail and threaded replies newest-first with their links and state", async () => {
    harness = await makeHarness()
    const s = await seedMailbox(harness)
    const page = await feed(harness)

    expect(page.items.map((i) => [i.source, i.id])).toEqual([
      ["reply", s.loose],
      ["reply", s.repliedWithheld],
      ["reply", s.published],
      ["reply", s.pending],
      ["email", s.e2],
      ["reply", s.withheld],
      ["email", s.e1],
    ])
    expect(page.items.find((i) => i.id === s.withheld)).toMatchObject({
      threadId: s.reportThread,
      reportId: "report-1",
      cleanupId: null,
      org: "Streets Dept",
      threadStatus: "needs_action",
      unread: true,
      authVerdict: "fail",
      publication: "withheld",
    })
    expect(page.items.find((i) => i.id === s.e1)).toMatchObject({ authVerdict: "fail" })
    expect(page.items.find((i) => i.id === s.e2)).toMatchObject({ authVerdict: null })
    const publication = Object.fromEntries(
      page.items.flatMap((i) => (i.source === "reply" ? [[i.id, i.publication]] : [])),
    )
    expect(publication).toEqual({
      [s.loose!]: null,
      [s.repliedWithheld!]: "withheld",
      [s.published!]: "published",
      [s.pending!]: "pending",
      [s.withheld!]: "withheld",
    })
  })

  it("applies each filter to exactly its source rows", async () => {
    harness = await makeHarness()
    const s = await seedMailbox(harness)
    expect(await ids(harness, "?filter=unread")).toEqual([s.published, s.withheld, s.e1])
    expect(await ids(harness, "?filter=replies")).toEqual([
      s.loose,
      s.repliedWithheld,
      s.published,
      s.pending,
      s.withheld,
    ])
    expect(await ids(harness, "?filter=review")).toEqual([s.withheld])
    expect(await ids(harness, "?filter=unmatched")).toEqual([s.e2, s.e1])
    expect(await ids(harness, "?filter=archived")).toEqual([s.e2])
    expect(await ids(harness, "?q=support")).toEqual([s.e1])
    expect(await ids(harness, "?q=streets")).toEqual([s.published, s.withheld])
  })

  it("pages across both sources under one cursor with no gap or repeat", async () => {
    harness = await makeHarness()
    await seedMailbox(harness)
    await seedEmail(harness, 5, { recipient: "support@civfix.org" })
    const all = await ids(harness, "")
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const qs: string = `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`
      const page = await feed(harness, qs)
      walked.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(walked).toEqual(all)
    expect(new Set(walked).size).toBe(8)
  })

  it("leaves the inbox detail route reachable and refuses bad input and non-operators", async () => {
    harness = await makeHarness()
    const s = await seedMailbox(harness)
    const detail = await harness.app.inject({
      method: "GET",
      url: `/v1/admin/inbox/${s.e1}`,
      headers: { authorization: `Bearer ${harness.token}` },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ id: s.e1, authVerdict: "fail" })

    const bogus = await harness.app.inject({
      method: "GET",
      url: "/v1/admin/inbox/feed?filter=bogus",
      headers: { authorization: `Bearer ${harness.token}` },
    })
    expect(bogus.statusCode).toBe(422)

    const citizen = await harness.stores.users.create("neighbor@example.com", {
      displayName: "Neighbor",
      role: "citizen",
      emailVerified: true,
    })
    const citizenToken = await harness.services.sessions.createSession(citizen.id, ["citizen"])
    const url = "/v1/admin/inbox/feed"
    expect((await harness.app.inject({ method: "GET", url })).statusCode).toBe(401)
    const asCitizen = await harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${citizenToken}` },
    })
    expect(asCitizen.statusCode).toBe(403)
  })
})
