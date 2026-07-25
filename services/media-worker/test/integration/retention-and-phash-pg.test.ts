/**
 * The worker's RAW SQL against the canonical migrated schema (Docker-gated; SKIPS without Docker).
 *
 * Two pieces of the worker talk to Postgres in hand-written SQL and were only ever exercised against
 * fakes: runRetentionSweep (four DELETE ... WHERE id IN (SELECT ... LIMIT n) RETURNING statements, spy-
 * tested as STRINGS, so a wrong column or table name was invisible) and makePhashDuplicateLookup (replaced
 * by an injected stub in every unit test, and its interpolated `AND id <> $1` / `AND report_id IS DISTINCT
 * FROM $2` fragments plus ORDER BY created_at are exactly the kind of thing a string spy cannot check).
 * Both are also failure-tolerant in production - the retention sweep counts and continues, the dedupe
 * error is downgraded to a note - so drift would surface as silently-doing-nothing, not as an incident.
 *
 * The phash lookup is reached through buildSeams(), i.e. the real production wiring, because the function
 * itself is private to seams.ts (and how it gets wired is part of what should not break).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { runRetentionSweep } from "../../src/jobs/retention-sweep.js"
import { buildSeams, type WorkerSeams } from "../../src/seams.js"
import { withWorkerPg, type WorkerPgHarness } from "../helpers/pg.js"

const pg = await withWorkerPg()

/**
 * ONE harness for the whole file, torn down once at the very end: a per-describe afterAll would close the
 * clients while the next describe still needs them.
 */
let h: WorkerPgHarness
let userId = ""
let seams: WorkerSeams | undefined

beforeAll(async () => {
  if (!pg) return
  h = pg
  // users.handle is NOT NULL with a CHECK on ^[A-Za-z0-9_]{3,20}$ (migration 0026).
  const [user] = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle) VALUES ('Retention Owner', 'retentionowner')
    RETURNING id
  `
  userId = user!.id
  // The REAL production wiring: a DATABASE_URL is what makes buildSeams construct the phash lookup at all.
  seams = await buildSeams({
    NODE_ENV: "test",
    DATABASE_URL: h.uri,
    USE_FAKE_STORAGE: "1",
    USE_FAKE_ABUSE_NSFW: "1",
    USE_FAKE_JOBS: "1",
  } as NodeJS.ProcessEnv)
})

afterAll(async () => {
  if (seams) await seams.close()
  if (pg) await pg.teardown()
})

describe.skipIf(!pg)("retention.sweep against the real schema", () => {
  const NOW = new Date("2026-06-20T12:00:00Z")

  /** A deterministic baseline: these four tables hold ONLY what each test puts in them. */
  beforeEach(async () => {
    await h.sql`DELETE FROM email_otps`
    await h.sql`DELETE FROM anon_tokens`
    await h.sql`DELETE FROM sessions`
    await h.sql`DELETE FROM idempotency_keys`
  })

  const at = (ms: number): Date => new Date(NOW.getTime() + ms)
  const HOUR = 60 * 60 * 1000

  async function insertOtp(opts: { expiresAt: Date; consumedAt?: Date }): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO email_otps (email, code_hash, expires_at, consumed_at)
      VALUES (${`u${randomUUID()}@example.com`}, 'hash', ${opts.expiresAt}, ${opts.consumedAt ?? null})
      RETURNING id
    `
    return row!.id
  }

  async function insertAnonToken(expiresAt: Date): Promise<string> {
    const id = `anontok-${randomUUID()}`
    await h.sql`INSERT INTO anon_tokens (id, expires_at) VALUES (${id}, ${expiresAt})`
    return id
  }

  async function insertSession(expiresAt: Date): Promise<string> {
    const id = randomUUID().replace(/-/g, "")
    await h.sql`
      INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, ${expiresAt})
    `
    return id
  }

  async function insertIdempotencyKey(createdAt: Date): Promise<string> {
    const [row] = await h.sql<{ key: string }[]>`
      INSERT INTO idempotency_keys (key, scope, response_snapshot, created_at)
      VALUES (gen_random_uuid(), 'report.create', '{}'::jsonb, ${createdAt})
      RETURNING key
    `
    return row!.key
  }

  it("deletes exactly the expired/consumed rows in all four tables and keeps the live ones", async () => {
    // Doomed: past the 1h grace cutoff, or consumed regardless of expiry.
    const expiredOtp = await insertOtp({ expiresAt: at(-3 * HOUR) })
    const consumedButValidOtp = await insertOtp({ expiresAt: at(3 * HOUR), consumedAt: at(-HOUR) })
    const expiredToken = await insertAnonToken(at(-3 * HOUR))
    const expiredSession = await insertSession(at(-3 * HOUR))
    const oldKey = await insertIdempotencyKey(at(-72 * HOUR))

    // Survivors: still inside the grace window / retention window.
    const liveOtp = await insertOtp({ expiresAt: at(3 * HOUR) })
    const justExpiredOtp = await insertOtp({ expiresAt: at(-30 * 60 * 1000) }) // inside the 1h grace
    const liveToken = await insertAnonToken(at(3 * HOUR))
    const liveSession = await insertSession(at(3 * HOUR))
    const recentKey = await insertIdempotencyKey(at(-2 * HOUR))

    const res = await runRetentionSweep({ sql: h.sql, now: () => NOW, log: () => {} })

    expect(res).toEqual({ otps: 2, anonTokens: 1, sessions: 1, idempotencyKeys: 1, errors: 0 })

    const otps = await h.sql<{ id: string }[]>`SELECT id FROM email_otps ORDER BY expires_at`
    expect(otps.map((r) => r.id).sort()).toEqual([liveOtp, justExpiredOtp].sort())
    expect(otps.map((r) => r.id)).not.toContain(expiredOtp)
    expect(otps.map((r) => r.id)).not.toContain(consumedButValidOtp)

    const tokens = await h.sql<{ id: string }[]>`SELECT id FROM anon_tokens`
    expect(tokens.map((r) => r.id)).toEqual([liveToken])
    expect(tokens.map((r) => r.id)).not.toContain(expiredToken)

    const sessions = await h.sql<{ id: string }[]>`SELECT id FROM sessions`
    expect(sessions.map((r) => r.id)).toEqual([liveSession])
    expect(sessions.map((r) => r.id)).not.toContain(expiredSession)

    const keys = await h.sql<{ key: string }[]>`SELECT key FROM idempotency_keys`
    expect(keys.map((r) => r.key)).toEqual([recentKey])
    expect(keys.map((r) => r.key)).not.toContain(oldKey)
  })

  it("is a no-op on an empty database (no throw, all zeroes)", async () => {
    const res = await runRetentionSweep({ sql: h.sql, now: () => NOW, log: () => {} })
    expect(res).toEqual({ otps: 0, anonTokens: 0, sessions: 0, idempotencyKeys: 0, errors: 0 })
  })

  /**
   * M10 for retention: the sweep used to delete ONE fixed batch per table per DAY, so any table whose daily
   * expiry churn exceeded the batch grew a backlog forever. Real SQL, real LIMIT: five doomed rows against a
   * page size of two must all be gone in one run.
   */
  it("DRAINS across pages rather than stopping after the first batch", async () => {
    for (let i = 0; i < 5; i++) await insertSession(at(-3 * HOUR))
    const keep = await insertSession(at(3 * HOUR))

    const res = await runRetentionSweep({
      sql: h.sql,
      now: () => NOW,
      log: () => {},
      batchSize: 2,
    })

    expect(res.sessions).toBe(5)
    const left = await h.sql<{ id: string }[]>`SELECT id FROM sessions`
    expect(left.map((r) => r.id)).toEqual([keep])
  })

  it("stops at maxPages so one run cannot hold the connection all night", async () => {
    for (let i = 0; i < 5; i++) await insertSession(at(-3 * HOUR))

    const res = await runRetentionSweep({
      sql: h.sql,
      now: () => NOW,
      log: () => {},
      batchSize: 2,
      maxPages: 1,
    })

    expect(res.sessions).toBe(2)
    const left = await h.sql<{ id: string }[]>`SELECT count(*)::int AS n FROM sessions`
    expect((left[0] as unknown as { n: number }).n).toBe(3)
  })

  it("honours a custom idempotency retention window independently of the grace window", async () => {
    const withinCustom = await insertIdempotencyKey(at(-2 * HOUR))
    const beyondCustom = await insertIdempotencyKey(at(-5 * HOUR))

    const res = await runRetentionSweep({
      sql: h.sql,
      now: () => NOW,
      log: () => {},
      idempotencyRetentionMs: 4 * HOUR,
    })

    expect(res.idempotencyKeys).toBe(1)
    const keys = await h.sql<{ key: string }[]>`SELECT key FROM idempotency_keys`
    expect(keys.map((r) => r.key)).toEqual([withinCustom])
    expect(keys.map((r) => r.key)).not.toContain(beyondCustom)
  })
})

describe.skipIf(!pg)("phash near-duplicate lookup against the real media_assets", () => {
  /** The lookup buildSeams wired; asserted present because `undefined` here would skip every case. */
  function lookup(
    hash: string,
    opts?: { excludeAssetId?: string; excludeReportId?: string },
  ): Promise<{ dup: boolean; ofReportId?: string | null }> {
    const fn = seams?.findPhashDuplicate
    expect(fn, "buildSeams must wire findPhashDuplicate when DATABASE_URL is set").toBeDefined()
    return fn!(hash, opts)
  }

  beforeEach(async () => {
    await h.sql`DELETE FROM media_assets`
  })

  async function insertReport(): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (
        gen_random_uuid(),
        ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
        'manual', 'trash', 'dump', 'submitted', 'h0'
      )
      RETURNING id
    `
    return row!.id
  }

  async function insertMedia(opts: {
    phash: string | null
    reportId?: string | null
    createdAt?: string
  }): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, phash, report_id, created_at)
      VALUES (
        gen_random_uuid(), 'image', ${`uploads/${randomUUID()}`}, 'ready',
        ${opts.phash}, ${opts.reportId ?? null},
        ${opts.createdAt ?? "2026-06-01T00:00:00Z"}
      )
      RETURNING id
    `
    return row!.id
  }

  const HASH = "0f1e2d3c4b5a6978"

  it("reports a CROSS-report duplicate with the other report's id", async () => {
    const otherReport = await insertReport()
    await insertMedia({ phash: HASH, reportId: otherReport })
    const mineReport = await insertReport()
    const mine = await insertMedia({ phash: HASH, reportId: mineReport })

    await expect(
      lookup(HASH, { excludeAssetId: mine, excludeReportId: mineReport }),
    ).resolves.toEqual({ dup: true, ofReportId: otherReport })
  })

  it("returns the OLDEST matching report (ORDER BY created_at ASC)", async () => {
    const older = await insertReport()
    const newer = await insertReport()
    await insertMedia({ phash: HASH, reportId: newer, createdAt: "2026-06-10T00:00:00Z" })
    await insertMedia({ phash: HASH, reportId: older, createdAt: "2026-06-02T00:00:00Z" })

    await expect(lookup(HASH)).resolves.toEqual({ dup: true, ofReportId: older })
  })

  it("P0-2: never matches the processing asset against its OWN row", async () => {
    const reportId = await insertReport()
    const self = await insertMedia({ phash: HASH, reportId })

    // Without the exclusion this is the bogus self-match (which used to hold a clean upload forever).
    await expect(lookup(HASH, { excludeAssetId: self })).resolves.toEqual({ dup: false })
    // Sanity: the row IS there, and is found when it is not excluded.
    await expect(lookup(HASH)).resolves.toEqual({ dup: true, ofReportId: reportId })
  })

  it("#43: a SIBLING in the same report is not a duplicate, but a third report still is", async () => {
    const shared = await insertReport()
    await insertMedia({ phash: HASH, reportId: shared, createdAt: "2026-06-02T00:00:00Z" })
    const sibling = await insertMedia({ phash: HASH, reportId: shared, createdAt: "2026-06-03T00:00:00Z" })

    await expect(
      lookup(HASH, { excludeAssetId: sibling, excludeReportId: shared }),
    ).resolves.toEqual({ dup: false })

    const third = await insertReport()
    await insertMedia({ phash: HASH, reportId: third, createdAt: "2026-06-04T00:00:00Z" })
    await expect(
      lookup(HASH, { excludeAssetId: sibling, excludeReportId: shared }),
    ).resolves.toEqual({ dup: true, ofReportId: third })
  })

  it("ignores UNATTACHED rows (report_id IS NULL) and rows with a different hash", async () => {
    await insertMedia({ phash: HASH, reportId: null })
    const reportId = await insertReport()
    await insertMedia({ phash: "ffffffffffffffff", reportId })

    await expect(lookup(HASH)).resolves.toEqual({ dup: false })
    await expect(lookup("0000000000000000")).resolves.toEqual({ dup: false })
  })
})
