import { describe, expect, it, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"
import { registerAdminEventPageRoutes } from "../../src/routes/admin/pages.routes.js"
import { registerAdminMediaRoutes } from "../../src/routes/admin/media.routes.js"
import { registerAdminLegalRoutes } from "../../src/routes/admin/legal.routes.js"
import { registerAdminBroadcastRoutes } from "../../src/routes/admin/broadcasts.routes.js"
import { registerAdminOrgRoutes } from "../../src/routes/admin/orgs.routes.js"
import type { AdminEventPageRow } from "../../src/services/host/admin-pages-repository.drizzle.js"
import { InMemoryBroadcastRepository } from "../../src/services/host/broadcast-repository.memory.js"
import { InMemoryOrganizationRepository } from "../../src/services/host/organization-repository.memory.js"
import type { MediaAssetView, MediaRepository } from "../../src/services/media-intake-service.js"

const OPERATOR = "11111111-1111-1111-1111-111111111111"
const CLEANUP = "22222222-2222-2222-2222-222222222222"
const MEDIA = "33333333-3333-3333-3333-333333333333"
const HOST = "44444444-4444-4444-4444-444444444444"

function pageRow(patch: Partial<AdminEventPageRow> = {}): AdminEventPageRow {
  return {
    pageId: "55555555-5555-5555-5555-555555555555",
    cleanupId: CLEANUP,
    slug: "beach-sweep",
    title: "Beach sweep",
    status: "published",
    visibility: "public",
    organizerId: HOST,
    organizerName: "Ada",
    organizerHandle: "ada",
    organizerJoined: new Date("2026-01-01T00:00:00.000Z"),
    orgName: "Reach Out LA",
    viewCount: 12,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
    flaggedAt: null,
    flagReason: null,
    flaggedById: null,
    flaggedByName: null,
    flaggedByHandle: null,
    flaggedByJoined: null,
    sortAt: new Date("2026-08-01T00:00:00.000Z"),
    ...patch,
  }
}

function mediaAsset(patch: Partial<MediaAssetView> = {}): MediaAssetView {
  return {
    id: MEDIA,
    uploadId: "66666666-6666-6666-6666-666666666666",
    kind: "image",
    codec: null,
    r2Key: "uploads/raw.jpg",
    servedKey: "media/served.jpg",
    thumbKey: "media/thumb.jpg",
    status: "ready",
    width: 800,
    height: 600,
    byteSize: 1234,
    purpose: "verification",
    ...patch,
  }
}

interface Harness {
  app: FastifyInstance
  pages: AdminEventPageRow[]
  audits: { action: string; target?: string | null }[]
  broadcasts: InMemoryBroadcastRepository
  orgs: InMemoryOrganizationRepository
  mails: { to: string; vars: Record<string, unknown> }[]
  notes: { userId: string; type: string }[]
}

async function harness(options: { media?: MediaAssetView | null } = {}): Promise<Harness> {
  const pages: AdminEventPageRow[] = [pageRow()]
  const audits: { action: string; target?: string | null }[] = []
  const broadcasts = new InMemoryBroadcastRepository()
  const orgs = new InMemoryOrganizationRepository()
  const mails: { to: string; vars: Record<string, unknown> }[] = []
  const notes: { userId: string; type: string }[] = []

  const container = {
    env: {
      NODE_ENV: "test",
      WEB_ORIGINS: ["https://civfix.org"],
      PAYMENTS_ENABLED: false,
    },
    storage: new FakeStorage(),
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    getDb: () => ({
      sql: Object.assign(
        (_strings: TemplateStringsArray, ..._values: unknown[]) =>
          Promise.resolve([{ id: "77777777-7777-4777-8777-777777777777" }]),
        { json: (value: unknown) => value },
      ),
    }),
  } as unknown as Container

  const mediaRepo = {
    findById: (id: string) =>
      Promise.resolve(
        options.media === undefined
          ? id === MEDIA
            ? mediaAsset()
            : null
          : options.media,
      ),
  } as unknown as MediaRepository

  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const alwaysAllowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", alwaysAllowed)
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: OPERATOR, roles: ["operator"] }
    done()
  })
  app.decorate("adminReadAuditOverrides", {
    sink: (input: { action: string; target?: string | null }) => {
      audits.push(input)
      return Promise.resolve()
    },
  })
  app.decorate("adminEventPageOverrides", {
    repo: {
      list: () => Promise.resolve(pages),
      get: (cleanupId: string) =>
        Promise.resolve(pages.find((p) => p.cleanupId === cleanupId) ?? null),
      setFlagged: (cleanupId: string, input: { flagged: boolean; reason: string | null }) => {
        const row = pages.find((p) => p.cleanupId === cleanupId)
        if (row === undefined) return Promise.resolve(null)
        row.flaggedAt = input.flagged ? new Date("2026-09-01T00:00:00.000Z") : null
        row.flagReason = input.flagged ? input.reason : null
        return Promise.resolve(row)
      },
      unpublish: (cleanupId: string) => {
        const row = pages.find((p) => p.cleanupId === cleanupId)
        if (row === undefined) return Promise.resolve(null)
        row.status = "unpublished"
        return Promise.resolve(row)
      },
    },
  })
  app.decorate("adminMediaOverrides", { repo: mediaRepo })
  app.decorate("adminBroadcastOverrides", { repo: broadcasts })
  app.decorate("organizationOverrides", {
    repo: orgs,
    mailer: {
      sendTransactional: (to: string, _template: string, vars: Record<string, unknown>) => {
        mails.push({ to, vars })
        return Promise.resolve()
      },
    },
    notifier: {
      createNotification: (userId: string, input: { type: string }) => {
        notes.push({ userId, type: input.type })
        return Promise.resolve()
      },
    },
  })

  await registerAdminEventPageRoutes(app, container)
  await registerAdminMediaRoutes(app, container)
  await registerAdminLegalRoutes(app, container)
  await registerAdminBroadcastRoutes(app, container)
  await registerAdminOrgRoutes(app, container)
  await app.ready()

  return { app, pages, audits, broadcasts, orgs, mails, notes }
}

/** Seed an org owned by HOST with one open (pending) verification application. */
async function seedPendingOrg(orgs: InMemoryOrganizationRepository): Promise<string> {
  orgs.seedUser({ id: HOST, displayName: "Ada", handle: "ada", email: "ada@example.org" })
  const org = await orgs.createOrganizationTx({
    organizationId: "88888888-8888-4888-8888-888888888888",
    slug: "reach-out-la",
    name: "Reach Out LA",
    description: null,
    websiteUrl: null,
    logoMediaId: null,
    socialLinks: null,
    createdBy: HOST,
    now: new Date("2026-08-01T00:00:00.000Z"),
  })
  if (typeof org === "string") throw new Error(org)
  await orgs.applyVerificationTx({
    verificationId: "99999999-9999-4999-8999-999999999999",
    organizationId: org.id,
    kind: "nonprofit",
    einNumber: null,
    documentMediaIds: [],
    note: null,
    submittedBy: HOST,
    now: new Date("2026-08-02T00:00:00.000Z"),
  })
  return org.id
}

describe("admin signup-page moderation", () => {
  let h: Harness
  beforeEach(async () => {
    h = await harness()
  })

  it("lists pages with the operator moderation state", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/pages" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: { cleanupId: string; viewCount: number }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.cleanupId).toBe(CLEANUP)
    expect(body.items[0]?.viewCount).toBe(12)
  })

  it("flags a page and records the reason in the audit log, not on the row", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/flag`,
      payload: { flagged: true, reason: "impersonates a city agency" },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { flaggedAt: string | null }).flaggedAt).not.toBeNull()
    expect(h.pages[0]?.flagReason).toBe("impersonates a city agency")
  })

  it("unpublishes a page without touching the event", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/unpublish`,
      payload: { reason: "off-platform payment link" },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe("unpublished")
  })

  it("404s a page that does not exist rather than inventing one", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/admin/pages/99999999-9999-4999-8999-999999999999/unpublish",
      payload: { reason: "spam" },
    })
    expect(res.statusCode).toBe(404)
  })

  it("rejects a flag body with an unknown key rather than dropping it", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/pages/${CLEANUP}/flag`,
      payload: { flagged: true, reasonn: "typo" },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("admin media read", () => {
  it("serves a short-lived signed URL and AUDITS the read", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: `/v1/admin/media/${MEDIA}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { media: { id: string; url: string }; expiresAt: string }
    expect(body.media.id).toBe(MEDIA)
    expect(body.media.url.length).toBeGreaterThan(0)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
    expect(h.audits.map((a) => a.action)).toContain("media.viewed")
    expect(h.audits.at(-1)?.target).toBe(`media:${MEDIA}`)
  })

  it("404s an asset the worker has not published yet (no servedKey)", async () => {
    const h = await harness({ media: mediaAsset({ servedKey: null }) })
    const res = await h.app.inject({ method: "GET", url: `/v1/admin/media/${MEDIA}` })
    expect(res.statusCode).toBe(404)
  })

  it("404s an unknown id", async () => {
    const h = await harness({ media: null })
    const res = await h.app.inject({ method: "GET", url: `/v1/admin/media/${MEDIA}` })
    expect(res.statusCode).toBe(404)
  })
})

describe("admin legal versions", () => {
  it("serves the same document set the public route does, under /admin", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/legal/versions" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { documents: { type: string; version: string; sha256: string }[] }
    expect(body.documents.length).toBeGreaterThan(0)
    for (const doc of body.documents) {
      expect(doc.version.length).toBeGreaterThan(0)
      expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe("admin org verification decision", () => {
  // The decision's operator audit is written INSIDE the repository transaction (decideVerificationTx ->
  // writeHostAudit), not by the route like the sibling admin mutations. These tests pin that the row exists
  // with the operator as actor, the org as target and the decision detail as meta, so the route's lack of a
  // second writeAudit call is a deliberate no-double-write, not a gap.
  it("approves, audits the operator + decision, and notifies the owner", async () => {
    const h = await harness()
    const id = await seedPendingOrg(h.orgs)
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/orgs/${id}/verification`,
      payload: { decision: "verified" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id, verifiedStatus: "verified", verifiedKind: "nonprofit" })

    const audit = h.orgs.audits.filter((a) => a.action === "org.verification_verified")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorId: OPERATOR,
      target: `organization:${id}`,
      meta: { kind: "nonprofit", reason: null },
    })

    expect(h.mails).toHaveLength(1)
    expect(h.mails[0]?.to).toBe("ada@example.org")
    expect(h.notes).toEqual([{ userId: HOST, type: "system" }])
  })

  it("rejects with a reason, audits it, and tells the owner why", async () => {
    const h = await harness()
    const id = await seedPendingOrg(h.orgs)
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/orgs/${id}/verification`,
      payload: { decision: "rejected", reason: "no determination letter" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id, verifiedStatus: "rejected", verifiedKind: null })

    const audit = h.orgs.audits.filter((a) => a.action === "org.verification_rejected")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorId: OPERATOR,
      target: `organization:${id}`,
      meta: { reason: "no determination letter" },
    })
    expect(String(h.mails[0]?.vars.message)).toContain("no determination letter")
    expect(h.notes).toEqual([{ userId: HOST, type: "system" }])
  })

  it("422s a rejection without a reason and writes no audit row or notification", async () => {
    const h = await harness()
    const id = await seedPendingOrg(h.orgs)
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/admin/orgs/${id}/verification`,
      payload: { decision: "rejected" },
    })
    expect(res.statusCode).toBe(422)
    expect(h.orgs.audits.filter((a) => a.action.startsWith("org.verification_"))).toHaveLength(1)
    expect(h.orgs.audits[0]?.action).toBe("org.verification_submitted")
    expect(h.mails).toHaveLength(0)
    expect(h.notes).toHaveLength(0)
  })
})

describe("admin host list", () => {
  it("returns a suspended host even with no broadcast activity in the window", async () => {
    const h = await harness()
    await h.broadcasts.setHostMessagingSuspended(HOST, true)

    const res = await h.app.inject({ method: "GET", url: "/v1/admin/hosts" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      items: { host: { id: string }; messagingSuspended: boolean; broadcastCount: number; windowDays: number }[]
    }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.host.id).toBe(HOST)
    expect(body.items[0]?.messagingSuspended).toBe(true)
    expect(body.items[0]?.broadcastCount).toBe(0)
    expect(body.items[0]?.windowDays).toBe(30)
  })

  it("filters to the suspended set when asked", async () => {
    const h = await harness()
    await h.broadcasts.setHostMessagingSuspended(HOST, true)

    const suspended = await h.app.inject({ method: "GET", url: "/v1/admin/hosts?suspended=true" })
    expect((suspended.json() as { items: unknown[] }).items).toHaveLength(1)

    const active = await h.app.inject({ method: "GET", url: "/v1/admin/hosts?suspended=false" })
    expect((active.json() as { items: unknown[] }).items).toHaveLength(0)
  })

  it("rejects an activity window longer than a year", async () => {
    const h = await harness()
    const res = await h.app.inject({ method: "GET", url: "/v1/admin/hosts?windowDays=400" })
    expect(res.statusCode).toBe(422)
  })
})
