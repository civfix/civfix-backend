import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer, FakeStorage } from "@civfix/shared/fakes"
import type { MailAttachment } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import { MEDIA_GET_URL_TTL_SEC } from "../../src/services/media-intake-service.js"

/**
 * HTTP tests for the admin INBOX router (`src/routes/admin/inbox.routes.ts`), which had none: every other
 * admin router has a unit HTTP test, while the inbox had only a repository integration test. So the whole
 * route layer was unexercised — the list filters, the detail 404, the attachment presigning + its
 * MAX_INBOX_ATTACHMENTS cap, and the L6 operator threading on the status mutation.
 *
 * These run against the REAL Fastify stack (app.inject) with in-memory auth (stores + cache + an
 * ADMIN_EMAILS allowlist) and `app.adminInboxOverrides` supplying an in-memory InboundRepository plus a
 * recording Storage — no DB, no R2, no Docker. The operator authenticates with a BEARER token, which is
 * CSRF-exempt by transport (see auth/csrf.ts), so the mutation is reachable without a cookie dance; the
 * cookie/CSRF half of the admin surface is covered in admin-auth-guard.test.ts.
 */

const OPERATOR = "ops@civfix.org"
/** Mirrors MAX_INBOX_ATTACHMENTS in inbox.routes.ts (module-private there, by design). */
const ATTACHMENT_CAP = 50

/** A Storage that records what was presigned (and with which TTL) so the cap is observable. */
class RecordingStorage extends FakeStorage {
  readonly signed: { key: string; ttlSec: number }[] = []
  override presignGet(key: string, ttlSec: number): Promise<string> {
    this.signed.push({ key, ttlSec })
    return super.presignGet(key, ttlSec)
  }
}

interface Harness {
  app: FastifyInstance
  repo: InMemoryInboundRepository
  storage: RecordingStorage
  services: AuthServices
  stores: ReturnType<typeof makeInMemoryStores>
  /** Bearer token for an allowlisted operator. */
  token: string
  operatorId: string
}

async function makeHarness(): Promise<Harness> {
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const services = buildAuthServices({
    stores,
    cache,
    mailer: new FakeMailer(),
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })
  const env = loadEnv({ NODE_ENV: "test", ADMIN_EMAILS: OPERATOR })
  const app = await buildServer({ env, authServices: services })
  const repo = new InMemoryInboundRepository()
  const storage = new RecordingStorage()
  app.adminInboxOverrides = { repo, storage }
  const user = await stores.users.create(OPERATOR, {
    displayName: "Ops",
    role: "operator",
    emailVerified: true,
  })
  const token = await services.sessions.createSession(user.id, ["operator"])
  return { app, repo, storage, services, stores, token, operatorId: user.id }
}

let harness: Harness | undefined
afterEach(async () => {
  if (harness) {
    await harness.app.close()
    harness = undefined
  }
})

/** Insert one inbound email; `minute` orders rows deterministically (received_at DESC on the wire). */
async function seed(
  h: Harness,
  opts: {
    messageId: string
    from?: string
    recipient?: string
    subject?: string
    bodyText?: string | null
    bodyHtml?: string | null
    attachments?: MailAttachment[]
    minute?: number
  },
): Promise<string> {
  const { id } = await h.repo.insertIdempotent({
    messageId: opts.messageId,
    fromAddr: opts.from ?? "clerk@lacity.gov",
    toAddr: opts.recipient ?? "support@civfix.org",
    recipient: opts.recipient ?? "support@civfix.org",
    subject: opts.subject ?? "Re: pothole",
    bodyText: opts.bodyText === undefined ? "Body text here." : opts.bodyText,
    bodyHtml: opts.bodyHtml ?? null,
    headers: {},
    attachments: opts.attachments ?? [],
    receivedAt: new Date(Date.UTC(2026, 5, 1, 0, opts.minute ?? 0, 0)),
  })
  return id
}

/** GET as the operator. */
function get(h: Harness, url: string): Promise<{ statusCode: number; json: () => unknown }> {
  return h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${h.token}` } })
}

describe("GET /admin/inbox (list)", () => {
  it("returns the inbox newest-first with the projected list fields", async () => {
    harness = await makeHarness()
    await seed(harness, { messageId: "<a@x>", subject: "Older", minute: 1 })
    const newer = await seed(harness, {
      messageId: "<b@x>",
      subject: "Newer",
      minute: 2,
      from: "mayor@lacity.gov",
      recipient: "reports@civfix.org",
      bodyText: "  Multi\nline   body  ",
      attachments: [{ key: "inbound-emails/b/photo.jpg", filename: "photo.jpg", size: 12 }],
    })

    const res = await get(harness, "/v1/admin/inbox")
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      items: {
        id: string
        from: string
        recipient: string
        localPart: string
        subject: string
        preview: string
        status: string
        unread: boolean
        hasAttachments: boolean
      }[]
      nextCursor: string | null
    }
    expect(body.items.map((i) => i.subject)).toEqual(["Newer", "Older"])
    expect(body.nextCursor).toBeNull()
    const top = body.items[0]!
    expect(top.id).toBe(newer)
    expect(top.from).toBe("mayor@lacity.gov")
    expect(top.recipient).toBe("reports@civfix.org")
    expect(top.localPart).toBe("reports")
    expect(top.preview).toBe("Multi line body")
    expect(top.status).toBe("unread")
    expect(top.unread).toBe(true)
    expect(top.hasAttachments).toBe(true)
    // The list projection never ships bodies or attachment keys.
    expect(top).not.toHaveProperty("bodyHtml")
    expect(top).not.toHaveProperty("attachments")
  })

  it("filters by status, by recipient local-part, and by q (from/subject/recipient)", async () => {
    harness = await makeHarness()
    const a = await seed(harness, {
      messageId: "<a@x>",
      subject: "Pothole on 3rd",
      recipient: "support@civfix.org",
      minute: 1,
    })
    const b = await seed(harness, {
      messageId: "<b@x>",
      subject: "Graffiti",
      from: "clerk@sfgov.org",
      recipient: "reports@civfix.org",
      minute: 2,
    })
    await harness.repo.setStatus(b, "archived", harness.operatorId)

    const ids = async (qs: string): Promise<string[]> => {
      const res = await get(harness as Harness, `/v1/admin/inbox${qs}`)
      expect(res.statusCode).toBe(200)
      return (res.json() as { items: { id: string }[] }).items.map((i) => i.id)
    }
    expect(await ids("?status=unread")).toEqual([a])
    expect(await ids("?status=archived")).toEqual([b])
    expect(await ids("?status=all")).toEqual([b, a])
    expect(await ids("?localPart=reports")).toEqual([b])
    expect(await ids("?localPart=support")).toEqual([a])
    expect(await ids("?q=pothole")).toEqual([a]) // subject, case-insensitive
    expect(await ids("?q=sfgov")).toEqual([b]) // from address
    expect(await ids("?q=nomatch")).toEqual([])
  })

  it("pages with the keyset cursor (no overlap, cursor null on the last page)", async () => {
    harness = await makeHarness()
    for (let i = 0; i < 5; i++) {
      await seed(harness, { messageId: `<m${i}@x>`, subject: `S${i}`, minute: i })
    }
    const first = await get(harness, "/v1/admin/inbox?limit=2")
    expect(first.statusCode).toBe(200)
    const p1 = first.json() as { items: { id: string }[]; nextCursor: string | null }
    expect(p1.items).toHaveLength(2)
    expect(p1.nextCursor).not.toBeNull()

    const second = await get(
      harness,
      `/v1/admin/inbox?limit=2&cursor=${encodeURIComponent(p1.nextCursor ?? "")}`,
    )
    const p2 = second.json() as { items: { id: string }[]; nextCursor: string | null }
    expect(p2.items).toHaveLength(2)
    const firstIds = new Set(p1.items.map((i) => i.id))
    expect(p2.items.every((i) => !firstIds.has(i.id))).toBe(true)

    const third = await get(
      harness,
      `/v1/admin/inbox?limit=2&cursor=${encodeURIComponent(p2.nextCursor ?? "")}`,
    )
    const p3 = third.json() as { items: unknown[]; nextCursor: string | null }
    expect(p3.items).toHaveLength(1)
    expect(p3.nextCursor).toBeNull()
  })

  it("422s a malformed query instead of 500ing or silently ignoring it", async () => {
    harness = await makeHarness()
    for (const qs of ["?limit=abc", "?limit=0", "?limit=101", "?status=bogus"]) {
      const res = await get(harness, `/v1/admin/inbox${qs}`)
      expect(res.statusCode, qs).toBe(422)
      expect((res.json() as { code: string }).code).toBe("VALIDATION")
    }
  })
})

describe("GET /admin/inbox/:id (detail)", () => {
  it("returns the full email with every attachment key replaced by a presigned URL", async () => {
    harness = await makeHarness()
    const id = await seed(harness, {
      messageId: "<detail@x>",
      subject: "Permit attached",
      bodyText: "See attached.",
      bodyHtml: "<p>See attached.</p>",
      attachments: [
        { key: "inbound-emails/d/permit.pdf", filename: "permit.pdf", size: 2048 },
        { key: "inbound-emails/d/map.png", filename: "map.png", size: 512 },
      ],
    })

    const res = await get(harness, `/v1/admin/inbox/${id}`)
    expect(res.statusCode).toBe(200)
    const dto = res.json() as {
      id: string
      bodyText: string
      bodyHtml: string | null
      messageId: string | null
      attachments: MailAttachment[]
    }
    expect(dto.id).toBe(id)
    expect(dto.bodyText).toBe("See attached.")
    expect(dto.bodyHtml).toBe("<p>See attached.</p>")
    expect(dto.messageId).toBe("<detail@x>")
    // The RAW R2 key never reaches the wire; it is swapped for a time-limited GET URL, and the filename +
    // size ride along unchanged so the console can render the link.
    expect(dto.attachments).toEqual([
      { key: "memory://inbound-emails/d/permit.pdf", filename: "permit.pdf", size: 2048 },
      { key: "memory://inbound-emails/d/map.png", filename: "map.png", size: 512 },
    ])
    expect(harness.storage.signed).toEqual([
      { key: "inbound-emails/d/permit.pdf", ttlSec: MEDIA_GET_URL_TTL_SEC },
      { key: "inbound-emails/d/map.png", ttlSec: MEDIA_GET_URL_TTL_SEC },
    ])
  })

  it("presigns AT MOST 50 attachments and elides the rest (crafted multi-part mail)", async () => {
    harness = await makeHarness()
    const attachments: MailAttachment[] = Array.from({ length: 60 }, (_, i) => ({
      key: `inbound-emails/cap/part-${i}.bin`,
      filename: `part-${i}.bin`,
      size: i,
    }))
    const id = await seed(harness, { messageId: "<cap@x>", attachments })

    const res = await get(harness, `/v1/admin/inbox/${id}`)
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { attachments: MailAttachment[]; hasAttachments: boolean }
    expect(dto.hasAttachments).toBe(true)
    expect(dto.attachments).toHaveLength(ATTACHMENT_CAP)
    // The FIRST 50 in order, each presigned; the tail is neither signed nor shipped.
    expect(dto.attachments[0]?.key).toBe("memory://inbound-emails/cap/part-0.bin")
    expect(dto.attachments[ATTACHMENT_CAP - 1]?.key).toBe(
      `memory://inbound-emails/cap/part-${ATTACHMENT_CAP - 1}.bin`,
    )
    expect(harness.storage.signed).toHaveLength(ATTACHMENT_CAP)
    expect(harness.storage.signed.map((s) => s.key)).not.toContain(
      `inbound-emails/cap/part-${ATTACHMENT_CAP}.bin`,
    )
  })

  it("404s an unknown id and 422s a non-uuid id (never a SQL-layer 500)", async () => {
    harness = await makeHarness()
    const missing = await get(harness, "/v1/admin/inbox/2f9d3c11-0000-4000-8000-000000000000")
    expect(missing.statusCode).toBe(404)
    expect(missing.json() as { code: string; message: string }).toMatchObject({
      code: "NOT_FOUND",
      message: "Inbound email not found.",
    })
    expect(harness.storage.signed).toHaveLength(0)

    const malformed = await get(harness, "/v1/admin/inbox/not-a-uuid")
    expect(malformed.statusCode).toBe(422)
  })
})

describe("POST /admin/inbox/:id/status", () => {
  it("sets the triage status and records the acting operator + transition in the audit row (L6)", async () => {
    harness = await makeHarness()
    const id = await seed(harness, { messageId: "<st@x>" })

    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/admin/inbox/${id}/status`,
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { id, status: "archived" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(harness.repo.rows.find((r) => r.id === id)?.status).toBe("archived")
    expect(harness.repo.audits).toEqual([
      {
        actorId: harness.operatorId,
        action: "inbox.status_changed",
        target: `inbound_email:${id}`,
        meta: { status: "archived", priorStatus: "unread" },
      },
    ])
  })

  it("takes the id from the PATH even when the body claims a different one", async () => {
    harness = await makeHarness()
    const target = await seed(harness, { messageId: "<t1@x>", minute: 1 })
    const other = await seed(harness, { messageId: "<t2@x>", minute: 2 })

    const res = await harness.app.inject({
      method: "POST",
      url: `/v1/admin/inbox/${target}/status`,
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { id: other, status: "read" },
    })
    expect(res.statusCode).toBe(200)
    expect(harness.repo.rows.find((r) => r.id === target)?.status).toBe("read")
    expect(harness.repo.rows.find((r) => r.id === other)?.status).toBe("unread")
  })

  it("404s an unknown id, 422s a bad status, and mutates nothing in either case", async () => {
    harness = await makeHarness()
    const id = await seed(harness, { messageId: "<neg@x>" })
    const unknown = "2f9d3c11-0000-4000-8000-000000000000"

    const missing = await harness.app.inject({
      method: "POST",
      url: `/v1/admin/inbox/${unknown}/status`,
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { id: unknown, status: "read" },
    })
    expect(missing.statusCode).toBe(404)

    const badStatus = await harness.app.inject({
      method: "POST",
      url: `/v1/admin/inbox/${id}/status`,
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { id, status: "deleted" },
    })
    expect(badStatus.statusCode).toBe(422)
    expect(
      (badStatus.json() as { code: string; fields?: Record<string, string> }).fields,
    ).toHaveProperty("status")

    expect(harness.repo.rows.find((r) => r.id === id)?.status).toBe("unread")
    expect(harness.repo.audits).toHaveLength(0)
  })
})

describe("inbox routes are operator-gated like every other admin router", () => {
  it("401s an anonymous caller and 403s a citizen session on all three routes", async () => {
    harness = await makeHarness()
    const id = await seed(harness, { messageId: "<gate@x>" })
    const citizen = await harness.stores.users.create("neighbor@example.com", {
      displayName: "Neighbor",
      role: "citizen",
      emailVerified: true,
    })
    const citizenToken = await harness.services.sessions.createSession(citizen.id, ["citizen"])

    const routes: { method: "GET" | "POST"; url: string; payload?: unknown }[] = [
      { method: "GET", url: "/v1/admin/inbox" },
      { method: "GET", url: `/v1/admin/inbox/${id}` },
      { method: "POST", url: `/v1/admin/inbox/${id}/status`, payload: { id, status: "read" } },
    ]
    for (const r of routes) {
      const anon = await harness.app.inject({
        method: r.method,
        url: r.url,
        ...(r.payload ? { payload: r.payload } : {}),
      })
      expect(anon.statusCode, `${r.method} ${r.url} anon`).toBe(401)
      const asCitizen = await harness.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: `Bearer ${citizenToken}` },
        ...(r.payload ? { payload: r.payload } : {}),
      })
      expect(asCitizen.statusCode, `${r.method} ${r.url} citizen`).toBe(403)
    }
    // Nothing leaked and nothing changed.
    expect(harness.storage.signed).toHaveLength(0)
    expect(harness.repo.audits).toHaveLength(0)
    expect(harness.repo.rows[0]?.status).toBe("unread")
  })
})
