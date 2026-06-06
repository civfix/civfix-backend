/**
 * Inbound-mail webhook integration test (Docker-gated). Exercises the webhook HTTP route end-to-end with
 * the REAL Drizzle MailRepository against a live Postgres container via withPg (mail_threads /
 * mail_messages / mail_events created by the canonical migration), plus the FakeInboundMail parser + a
 * FakeStorage. Proves the full ingress path writes the real schema:
 *   - a valid secret + reply+{token} body upserts the thread, inserts the inbound mail_messages row,
 *     marks the thread unread, and records a mail_events row;
 *   - the thread + message round-trip back through getThread.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeInboundMail, FakeStorage } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  registerInboundMailWebhook,
  CF_WEBHOOK_SECRET_HEADER,
} from "../../src/routes/webhooks/inbound-mail.routes.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { Container } from "../../src/di.js"

const pg = await withPg()

const SECRET = "cf-webhook-secret-value"

/** Build a minimal RFC822 message the FakeInboundMail subset parses. */
function rfc822(opts: { from: string; to: string; subject?: string; body?: string }): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to}`]
  if (opts.subject !== undefined) lines.push(`Subject: ${opts.subject}`)
  lines.push("", opts.body ?? "")
  return Buffer.from(lines.join("\n"), "utf8")
}

describe.skipIf(!pg)("inbound-mail webhook (integration: real schema)", () => {
  let h: PgHarness
  let app: FastifyInstance

  beforeAll(async () => {
    h = pg as PgHarness
    const container = {
      env: { CF_EMAIL_WEBHOOK_SECRET: SECRET },
      inboundMail: new FakeInboundMail(),
    } as unknown as Container
    app = Fastify()
    app.setErrorHandler(makeErrorHandler())
    // Use the REAL Drizzle mail repo (against the container DB) + a FakeStorage for attachments.
    app.decorate("inboundMailOverrides", {
      repo: makeDrizzleMailRepository(h.sql),
      storage: new FakeStorage(),
    })
    await registerInboundMailWebhook(app, container)
    await app.ready()
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, outreach_state RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await app.close()
    await h.teardown()
  })

  it("threads an inbound reply onto an existing thread, marks unread, records an event", async () => {
    // Seed the outbound thread the reply belongs to (token tok-la).
    const seeded = await makeDrizzleMailRepository(h.sql).createThread({
      threadToken: "tok-la",
      subject: "Pothole",
    })

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: SECRET },
      payload: rfc822({
        from: "clerk@lacity.gov",
        to: "reply+tok-la@civfix.org",
        subject: "Re: Pothole",
        body: "We are on it.",
      }),
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, threaded: true, threadId: seeded.id })

    const repo = makeDrizzleMailRepository(h.sql)
    const dto = await repo.getThread(seeded.id)
    expect(dto?.messages).toHaveLength(1)
    expect(dto?.messages[0]?.dir).toBe("in")
    expect(dto?.messages[0]?.body).toBe("We are on it.")
    expect((await repo.getThreadRecord(seeded.id))?.unread).toBe(true)

    const events = await h.sql<{ type: string }[]>`SELECT type FROM mail_events WHERE thread_id = ${seeded.id}`
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("delivered")
  })

  it("rejects a wrong secret (401) and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/inbound-mail",
      headers: { "content-type": "message/rfc822", [CF_WEBHOOK_SECRET_HEADER]: "wrong" },
      payload: rfc822({ from: "clerk@city.gov", to: "reply+tok-la@civfix.org", body: "x" }),
    })
    expect(res.statusCode).toBe(401)
    const threads = await h.sql<{ id: string }[]>`SELECT id FROM mail_threads`
    expect(threads).toHaveLength(0)
  })
})
