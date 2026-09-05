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


const TOKEN = "0123456789abcdef01234567"

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

function ctx(sqlHandlers: SqlHandler[] = [], env: Record<string, unknown> = {}): Ctx {
  const storage = new FakeStorage()
  const inboundMail = new FakeInboundMail()
  const mailRepo = new InMemoryMailRepository()
  const inboundRepo = new InMemoryInboundRepository()
  const jobs = new FakeJobs()
  const db = makeFakeSql(sqlHandlers)
  const deps: InboundProcessorDeps = { storage, inboundMail, mailRepo, inboundRepo }
  const container = {
    env,
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
    expect(verdict).toBe("unknown")
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
    expect((await c.mailRepo.getThreadRecord(thread.id))?.status).toBe("bounced")
    const stamp = c.db.statements.find((s) =>
      /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql),
    )
    expect(stamp?.values).toContain(failed)
    expect(c.jobs.jobsFor("jurisdiction.discovery")[0]?.data).toMatchObject({ geoid })
  })
})

describe("DSN/bounce: only the receiving domain or our own provider can report a failure", () => {
  const geoid = "0644000"
  const failed = "clerk@lacity.gov"

  function threadedCtx(env: Record<string, unknown> = {}): Ctx {
    const c = ctx(bounceSqlHandlers(geoid), env)
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
    return c
  }

  function bouncedAtStamped(c: Ctx): boolean {
    return c.db.statements.some((s) =>
      /UPDATE\s+jurisdiction_contacts\s+SET\s+bounced_at/i.test(s.sql),
    )
  }

  it("REFUSES a spoofed DSN from an unrelated domain that echoes a real outbound Message-ID", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}spoof-unrelated.eml`,
      dsn({
        from: "mailer-daemon@vendor.example",
        messageId: "<spoof-unrelated@vendor.example>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(false)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(false)
    expect(c.jobs.jobsFor("jurisdiction.discovery")).toHaveLength(0)
    expect(c.inboundRepo.rows).toHaveLength(1)
  })

  it("REFUSES a DSN whose domain aligns but whose DMARC verdict is a hard fail", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}spoof-dmarc-fail.eml`,
      dsn({
        from: "mailer-daemon@lacity.gov",
        messageId: "<spoof-dmarc-fail@lacity.gov>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
        authResults: "mx.civfix.org; dmarc=fail header.from=lacity.gov",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(false)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(false)
  })

  it("ACCEPTS a DSN from a SUBDOMAIN of the failed recipient's domain", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}subdomain-dsn.eml`,
      dsn({
        from: "mailer-daemon@mx1.lacity.gov",
        messageId: "<subdomain-dsn@mx1.lacity.gov>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(true)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
  })

  it("ACCEPTS a DSN from a known PROVIDER daemon domain (Google-Workspace-hosted jurisdictions)", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}google-dsn.eml`,
      dsn({
        from: "mailer-daemon@googlemail.com",
        messageId: "<google-dsn@googlemail.com>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(true)
    expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(true)
  })

  it("ACCEPTS a DSN from a Microsoft 365 bounce host", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}m365-dsn.eml`,
      dsn({
        from: "postmaster@eur01.protection.outlook.com",
        messageId: "<m365-dsn@protection.outlook.com>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(true)
  })

  it("REFUSES a consumer mailbox on a provider domain (only daemon local-parts qualify)", async () => {
    for (const [name, from] of [
      ["hotmail", "attacker@hotmail.com"],
      ["outlook", "attacker@outlook.com"],
      ["gmail", "attacker@googlemail.com"],
    ] as const) {
      const c = threadedCtx()
      await verdictFor(
        c,
        `${INBOUND_PENDING_PREFIX}consumer-${name}.eml`,
        dsn({
          from,
          messageId: `<consumer-${name}@example.invalid>`,
          failedRecipient: failed,
          originalMessageId: "<out-42@civfix.org>",
        }),
      )
      expect(bouncedAtStamped(c)).toBe(false)
      expect(c.mailRepo.events.some((e) => e.type === "bounced")).toBe(false)
    }
  })

  it("still REFUSES a provider-shaped daemon on an unrelated domain", async () => {
    const c = threadedCtx()
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}fake-provider-dsn.eml`,
      dsn({
        from: "mailer-daemon@googlemail.com.evil.example",
        messageId: "<fake-provider@evil.example>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(false)
  })

  it("ACCEPTS a DSN generated by our OWN mail provider domain", async () => {
    const c = threadedCtx({
      MAIL_FROM_OUTREACH: "outreach@civfix.org",
      MAIL_REPLY_DOMAIN: "civfix.org",
    })
    await verdictFor(
      c,
      `${INBOUND_PENDING_PREFIX}own-dsn.eml`,
      dsn({
        from: "mailer-daemon@civfix.org",
        messageId: "<own-dsn@civfix.org>",
        failedRecipient: failed,
        originalMessageId: "<out-42@civfix.org>",
      }),
    )

    expect(bouncedAtStamped(c)).toBe(true)
  })
})
