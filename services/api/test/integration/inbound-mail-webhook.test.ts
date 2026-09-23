/**
 * Inbound-mail webhook integration test (Docker-gated). Exercises the pointer + HMAC webhook end-to-end
 * with the REAL Drizzle MailRepository + InboundRepository against a live Postgres container via withPg
 * (mail_threads/mail_messages/mail_events + inbound_emails created by the canonical migrations), plus the
 * FakeInboundMail parser and a FakeStorage seeded with the raw .eml. Proves the full ingress path writes
 * the real schema:
 *   - a reply+{token} message threads into mail_threads (unread + a mail_events row);
 *   - a no-token message lands in inbound_emails (the catch-all inbox);
 *   - the pending R2 object is deleted on success; a wrong signature writes nothing.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real.
 */

import { createHmac } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  registerInboundMailWebhook,
  CF_WEBHOOK_SIGNATURE_HEADER,
} from "../../src/routes/webhooks/inbound-mail.routes.js"
import { INBOUND_PENDING_PREFIX } from "../../src/services/admin/inbound-processor.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { makeDrizzleInboundRepository } from "../../src/services/admin/inbound-repository.drizzle.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"

const pg = await withPg()
const SECRET = "cf-webhook-secret-value"

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex")
}

/**
 * `auth` is the RFC 8601 `Authentication-Results` header our MTA stamps. M7 made the threading path
 * FAIL CLOSED on anything but a DMARC-aligned pass — an ABSENT header is `unknown`, not `pass` — because
 * threading is what grants a message authority (report status transitions, an "official city reply"
 * mirrored into the PUBLIC report chat, a push to the reporter). So a fixture that wants those effects
 * MUST carry a passing verdict; omit `auth` to exercise the unauthenticated lane.
 */
function rfc822(opts: {
  from: string
  to: string
  subject?: string
  body?: string
  auth?: string
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.auth !== undefined) lines.push(`Authentication-Results: ${opts.auth}`)
  if (opts.subject !== undefined) lines.push(`Subject: ${opts.subject}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

/** A DMARC-aligned pass, as Cloudflare Email Routing's MTA stamps it. */
const DMARC_PASS = "mx.cloudflare.net; spf=pass; dkim=pass header.d=lacity.gov; dmarc=pass header.from=lacity.gov"

describe.skipIf(!pg)("inbound-mail webhook (integration: real schema)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let storage: FakeStorage

  beforeAll(async () => {
    h = pg as PgHarness
    storage = new FakeStorage()
    const container = {
      env: { CF_EMAIL_WEBHOOK_SECRET: SECRET },
      inboundMail: new FakeInboundMail(),
    } as unknown as Container
    app = Fastify()
    app.setErrorHandler(makeErrorHandler())
    app.decorate("inboundMailOverrides", {
      storage,
      inboundMail: new FakeInboundMail(),
      mailRepo: makeDrizzleMailRepository(h.sql),
      inboundRepo: makeDrizzleInboundRepository(h.sql),
    })
    await registerInboundMailWebhook(app, container)
    await app.ready()
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, inbound_emails, outreach_state RESTART IDENTITY CASCADE`
    storage.reset()
  })

  afterAll(async () => {
    await app.close()
    await h.teardown()
  })

  async function ingest(eml: Buffer, key: string) {
    await storage.put(key, eml)
    const body = JSON.stringify({ key })
    return app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "application/json", [CF_WEBHOOK_SIGNATURE_HEADER]: sign(body) },
      payload: body,
    })
  }

  it("threads an inbound reply onto an existing thread, marks unread, records an event", async () => {
    const seeded = await makeDrizzleMailRepository(h.sql).createThread({ threadToken: "0a0a0a0a0a0a0a0a0a0a0a0a", subject: "Pothole" })
    const key = `${INBOUND_PENDING_PREFIX}reply-1.eml`
    const res = await ingest(
      rfc822({
        from: "clerk@lacity.gov",
        to: "reply+0a0a0a0a0a0a0a0a0a0a0a0a@civfix.org",
        subject: "Re: Pothole",
        body: "We are on it.",
        auth: DMARC_PASS,
      }),
      key,
    )
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "threaded" })

    const repo = makeDrizzleMailRepository(h.sql)
    const dto = await repo.getThread(seeded.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("in")
    expect((await repo.getThreadRecord(seeded.id))?.unread).toBe(true)
    const events = await h.sql<{ type: string }[]>`SELECT type FROM mail_events WHERE thread_id = ${seeded.id}`
    expect(events[0]?.type).toBe("delivered")
    // Pending object consumed.
    expect(storage.get(key)).toBeNull()
  })

  // --- M7 message-authentication gate --------------------------------------------------------------
  // A valid thread token used to be sufficient to reach the THREADED path, so anyone who learned a token
  // could forge `From: publicworks@lacity.gov` and drive the whole side-effect chain: report status ->
  // in_progress, their text mirrored into the PUBLIC report chat as an official city reply, and a push to
  // the reporter. The gate now files anything that is not authenticated as UNAFFILIATED with no side
  // effects, and FAILS CLOSED on a missing header (which is indistinguishable from a bypassed MTA).

  it("M7: a spoofed reply with a VALID token but NO Authentication-Results is filed on its thread as unaffiliated", async () => {
    const seeded = await makeDrizzleMailRepository(h.sql).createThread({
      threadToken: "0b0b0b0b0b0b0b0b0b0b0b0b",
      subject: "Pothole",
    })
    const key = `${INBOUND_PENDING_PREFIX}spoof-unknown.eml`
    const res = await ingest(
      rfc822({
        from: "publicworks@lacity.gov",
        to: "reply+0b0b0b0b0b0b0b0b0b0b0b0b@civfix.org",
        subject: "Re: Pothole",
        body: "Marking this resolved.",
      }),
      key,
    )
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "threaded" })

    const msgs = await h.sql<{ direction: string; unaffiliated: boolean }[]>`
      SELECT direction, unaffiliated FROM mail_messages WHERE thread_id = ${seeded.id}
    `
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ direction: "in", unaffiliated: true })
    const events = await h.sql<{ type: string; verdict: string | null }[]>`
      SELECT type, meta->>'authVerdict' AS verdict FROM mail_events WHERE thread_id = ${seeded.id}
    `
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "delivered", verdict: "unknown" })
    expect((await makeDrizzleMailRepository(h.sql).getThreadRecord(seeded.id))?.unread).toBe(true)
    const inbox = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM inbound_emails`
    expect(inbox[0]!.n).toBe(0)
  })

  it("M7: an explicit dmarc=fail with a valid token is likewise filed unaffiliated, stamped 'fail'", async () => {
    const seeded = await makeDrizzleMailRepository(h.sql).createThread({
      threadToken: "0c0c0c0c0c0c0c0c0c0c0c0c",
      subject: "Graffiti",
    })
    const key = `${INBOUND_PENDING_PREFIX}spoof-fail.eml`
    const res = await ingest(
      rfc822({
        from: "publicworks@lacity.gov",
        to: "reply+0c0c0c0c0c0c0c0c0c0c0c0c@civfix.org",
        subject: "Re: Graffiti",
        body: "nope",
        auth: "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail header.from=lacity.gov",
      }),
      key,
    )
    expect(res.json()).toMatchObject({ accepted: true, outcome: "threaded" })
    const rows = await h.sql<{ unaffiliated: boolean; verdict: string | null }[]>`
      SELECT m.unaffiliated, e.meta->>'authVerdict' AS verdict
      FROM mail_messages m JOIN mail_events e ON e.message_id = m.id
      WHERE m.thread_id = ${seeded.id}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ unaffiliated: true, verdict: "fail" })
    const inbox = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM inbound_emails`
    expect(inbox[0]!.n).toBe(0)
  })

  it("lands a no-token message in inbound_emails (catch-all inbox)", async () => {
    const key = `${INBOUND_PENDING_PREFIX}cold-1.eml`
    const res = await ingest(
      rfc822({ from: "resident@example.com", to: "support@civfix.org", subject: "Help", body: "a question" }),
      key,
    )
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, outcome: "inbox" })

    const rows = await h.sql<{ recipient: string; status: string }[]>`
      SELECT recipient, status FROM inbound_emails
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.recipient).toBe("support@civfix.org")
    expect(rows[0]?.status).toBe("unread")
    expect(storage.get(key)).toBeNull()
  })

  it("rejects a wrong signature (401) and writes nothing", async () => {
    const key = `${INBOUND_PENDING_PREFIX}nope.eml`
    await storage.put(key, rfc822({ from: "c@city.gov", to: "support@civfix.org", body: "x" }))
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "application/json", [CF_WEBHOOK_SIGNATURE_HEADER]: "deadbeef" },
      payload: JSON.stringify({ key }),
    })
    expect(res.statusCode).toBe(401)
    const rows = await h.sql<{ id: string }[]>`SELECT id FROM inbound_emails`
    expect(rows).toHaveLength(0)
  })
})
