import { describe, expect, it } from "vitest"
import { FakeInboundMail, FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryInboundRepository } from "../../src/services/admin/inbound-repository.memory.js"
import {
  processInboundObject,
  INBOUND_PENDING_PREFIX,
  type InboundProcessorDeps,
} from "../../src/services/admin/inbound-processor.js"
import type { Container } from "../../src/di.js"
import { makeFakeSql, type FakeSqlControl, type SqlHandler } from "../helpers/fake-sql.js"

/**
 * M7 on the BOUNCE branch: the stored `x-civfix-auth-verdict` must be the REAL verdict.
 *
 * Bounces are routed to the admin Inbox BEFORE the authentication gate, because bounce handling itself is
 * verdict-independent (it only ever reaches the Inbox and the thread's own outbound recipients). But
 * routeInbox used to DEFAULT its verdict parameter to "pass", so every DSN was stored as authenticated —
 * on the single message class that is easiest to forge, and precisely where the console must show its
 * UNVERIFIED badge. The parameter is now required and the bounce branch passes readMailAuthVerdict(mail).
 *
 * The verdict is also stamped LAST into the stored headers, so a sender who sets the header themselves
 * cannot pre-seed it — asserted below.
 */

const TOKEN = "0123456789abcdef01234567"

/**
 * Build a raw RFC822 DSN. `authResults` sets Authentication-Results verbatim; OMIT it for the spoof case
 * (no header at all -> the fail-closed "unknown" verdict).
 */
function dsn(opts: {
  from: string
  to?: string
  messageId: string
  failedRecipient?: string
  originalMessageId?: string
  authResults?: string
  extraHeaders?: Record<string, string>
}): Buffer {
  const lines = [`From: ${opts.from}`, `To: ${opts.to ?? "outreach@civfix.org"}`]
  lines.push(`Message-ID: ${opts.messageId}`)
  if (opts.authResults !== undefined) lines.push(`Authentication-Results: ${opts.authResults}`)
  if (opts.failedRecipient !== undefined) {
    lines.push(`X-Failed-Recipients: ${opts.failedRecipient}`)
  }
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) lines.push(`${k}: ${v}`)
  lines.push(
    "",
    "Your message could not be delivered.",
    ...(opts.originalMessageId !== undefined
      ? [`Original-Message-ID: ${opts.originalMessageId}`]
      : []),
  )
  return Buffer.from(lines.join("\n"), "utf8")
}

interface Ctx {
  container: Container
  deps: InboundProcessorDeps
  storage: FakeStorage
  mailRepo: InMemoryMailRepository
  inboundRepo: InMemoryInboundRepository
  jobs: FakeJobs
  db: FakeSqlControl
}

/** The bounce path's three SQL touches (contact stamp + correlation probe + geoid lookup) are stubbed. */
function ctx(sqlHandlers: SqlHandler[] = []): Ctx {
  const storage = new FakeStorage()
  const inboundMail = new FakeInboundMail()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const deps: InboundProcessorDeps = { storage, inboundMail, mailRepo, inboundRepo }
  const container = {
    env: {},
    storage,
    inboundStorage: storage,
    inboundMail,
    jobs,
    getDb: () => ({ sql: db.sql }),
  } as unknown as Container
  return { container, deps, storage, mailRepo, inboundRepo, jobs, db }
}

function bounceSqlHandlers(geoid = "0644000"): SqlHandler[] {
  return [
    { match: /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i, rows: [] },
    { match: /FROM\s+mail_messages/i, rows: [{ ok: true }] },
    { match: /SELECT\s+geoid\s+FROM\s+jurisdiction_contacts/i, rows: [{ geoid }] },
  ]
}

/** Store the DSN and run the processor; returns the stored inbound row's verdict header. */
async function verdictFor(c: Ctx, key: string, eml: Buffer): Promise<string | undefined> {
  await c.storage.put(key, eml)
  const r = await processInboundObject(c.container, key, c.deps)
  expect(r.outcome).toBe("inbox")
  return c.inboundRepo.rows[0]?.headers?.["x-civfix-auth-verdict"]
}

describe("DSN/bounce: the stored auth verdict is the REAL one, not a default 'pass'", () => {
  it("stamps 'unknown' for a spoofed DSN with NO Authentication-Results header", async () => {
    const c = ctx(bounceSqlHandlers())
    const verdict = await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}spoof-no-auth.eml`,
      dsn({
        from: "mailer-daemon@evil.example",
        messageId: "<spoof-no-auth@evil.example>",
        failedRecipient: "publicworks@city.gov",
      }),
    )
    // FAIL CLOSED: an absent header means our MTA did not stamp a verdict, which is indistinguishable from
    // a message that bypassed it. Anything but "unknown" here is the bug this pins.
    expect(verdict).toBe("unknown")
  })

  it("stamps 'fail' for a DMARC-failing DSN", async () => {
    const c = ctx(bounceSqlHandlers())
    const verdict = await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}dmarc-fail.eml`,
      dsn({
        from: "mailer-daemon@evil.example",
        messageId: "<dmarc-fail@evil.example>",
        failedRecipient: "publicworks@city.gov",
        authResults: "mx.civfix.org; spf=pass; dmarc=fail header.from=evil.example",
      }),
    )
    expect(verdict).toBe("fail")
  })

  it("stamps 'pass' for a genuine DMARC-aligned DSN relayed by our MTA", async () => {
    const c = ctx(bounceSqlHandlers())
    const verdict = await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}dmarc-pass.eml`,
      dsn({
        from: "mailer-daemon@lacity.gov",
        messageId: "<dmarc-pass@lacity.gov>",
        failedRecipient: "clerk@lacity.gov",
        authResults: "mx.civfix.org; dmarc=pass header.from=lacity.gov",
      }),
    )
    expect(verdict).toBe("pass")
  })

  it("OVERWRITES a sender-supplied X-Civfix-Auth-Verdict header (it is stamped last, not merged)", async () => {
    const c = ctx(bounceSqlHandlers())
    const verdict = await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}spoof-header.eml`,
      dsn({
        from: "mailer-daemon@evil.example",
        messageId: "<spoof-header@evil.example>",
        failedRecipient: "publicworks@city.gov",
        // The attacker asserts their own verdict; there is no Authentication-Results, so the truth is
        // "unknown" and the server's own value must win.
        extraHeaders: { "X-Civfix-Auth-Verdict": "pass" },
      }),
    )
    expect(verdict).toBe("unknown")
  })

  it("keeps bounce HANDLING verdict-independent: an 'unknown' DSN correlated to a real thread still fires", async () => {
    const geoid = "0644000"
    const failed = "clerk@lacity.gov"
    const c = ctx(bounceSqlHandlers(geoid))
    const thread = c.mailRepo.seedThread({
      threadToken: TOKEN,
      jurisdictionGeoid: geoid,
      status: "sent",
    })
    c.mailRepo.seedMessage({
      threadId: thread.id,
      direction: "out",
      messageId: "<out-42@civfix.org>",
    })

    const verdict = await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}unknown-real.eml`,
      dsn({
        from: "mailer-daemon@lacity.gov",
        messageId: "<unknown-real@lacity.gov>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )
    // Stored honestly as UNVERIFIED…
    expect(verdict).toBe("unknown")
    // …while the side effects still run, because they only touch the thread's OWN outbound recipients.
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("bounced")
    const stamp = c.db.statements.find((s) =>
      /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql),
    )
    expect(stamp?.values).toContain(failed)
    expect(c.jobs.jobsFor("jurisdiction.discovery")[0]?.data).toMatchObject({ geoid })
  })
})
