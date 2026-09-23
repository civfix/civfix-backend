/**
 * Anonymous-reporting integration test (Docker-gated). Exercises the REAL Drizzle/PostGIS anon repos +
 * the anon service + the hold-release gate against a live PostGIS container (via withPg). Driven at the
 * service+repository layer (no HTTP/Redis) so it proves the spatial held-create transaction, the
 * held-stays-hidden invariant, the claim-code-gated status, and the release transition directly.
 *
 * Proven here (held items stay hidden):
 *   - a held anon report has reporter_user_id NULL, anon_session_id = the token id, status 'held',
 *     published_at NULL, the resolved jurisdiction, geom round-trips, and a submitted+held timeline;
 *   - it is ABSENT from the report-service map candidates (published+public only) and 404s a stranger
 *     via getReport, while its status is visible via anonReportStatus with the right claim code;
 *   - releaseAnonHoldIfReady flips it to published once its media are ready + clean;
 *   - claimReport links it to a user (single-use code) - matching on the stored SHA-256 only, since
 *     the plaintext code is never written to reports.claim_code (0091);
 *   - the idempotency snapshot is owner-scoped: another anon session reusing the key gets the
 *     retryable 409, never the first submitter's snapshot + claim code (0078+0079).
 *
 * Skips wholesale when Docker is unavailable (describe.skipIf), keeping the local suite green.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { signAnonToken, ANON_TOKEN_REPORT_CAP } from "../../src/abuse/anon-token.js"
import { sha256Hex } from "../../src/auth/crypto.js"
import { makeAnonService, type AnonService } from "../../src/services/anon-service.js"
import { makeClaimService, type ClaimService } from "../../src/services/claim-service.js"
import {
  makeDrizzleAnonReportRepository,
  makeDrizzleClaimRepository,
} from "../../src/services/anon-repository.drizzle.js"
import { makeDrizzleAnonHoldReleaseRepository } from "../../src/services/anon-hold-release-repository.drizzle.js"
import { releaseAnonHoldIfReady } from "../../src/services/anon-hold-release.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import { PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"
import type { AnonReportRequest } from "@civfix/shared"

const pg = await withPg()
const SIGNING_KEY = "integration-anon-signing-key"

describe.skipIf(!pg)("anon reporting (integration: real transaction path)", () => {
  let h: PgHarness
  let anon: AnonService
  let claim: ClaimService
  let reports: ReportService

  beforeAll(() => {
    h = pg as PgHarness
    const resolveJurisdictionGeoid = async (lat: number, lng: number): Promise<string | null> => {
      const rows = await h.sql<{ geoid: string }[]>`
        SELECT geoid FROM jurisdictions
        WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
        ORDER BY CASE layer WHEN 'place' THEN 0 WHEN 'county' THEN 1 ELSE 2 END
        LIMIT 1
      `
      return rows[0]?.geoid ?? null
    }
    const presignMedia = (r2Key: string, thumbKey: string | null) =>
      Promise.resolve(
        thumbKey === null
          ? { url: `memory://${r2Key}` }
          : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
      )

    reports = makeReportService({
      repo: makeDrizzleReportRepository(h.sql),
      resolveJurisdictionGeoid,
      presignMedia,
    })
    anon = makeAnonService({
      repo: makeDrizzleAnonReportRepository(h.sql),
      abuseChecks: new FakeAbuseChecks(),
      counters: new InMemoryCounterStore(() => 0),
      anonTokenSigningKey: SIGNING_KEY,
      resolveJurisdictionGeoid,
    })
    claim = makeClaimService({
      repo: makeDrizzleClaimRepository(h.sql),
      anonTokenSigningKey: SIGNING_KEY,
      getReportForOwner: (reportId, owner) => reports.getReport(reportId, owner),
    })
  })

  afterAll(async () => {
    await h.teardown()
  })

  function req(over: Partial<AnonReportRequest> = {}): AnonReportRequest {
    return {
      idempotencyKey: over.idempotencyKey ?? randomUUID(),
      turnstileToken: "ok",
      category: over.category ?? "trash",
      type: over.type ?? "dump",
      lat: over.lat ?? PROBE_INSIDE_CITY.lat,
      lng: over.lng ?? PROBE_INSIDE_CITY.lng,
      geomSource: "device",
      mediaUploadIds: over.mediaUploadIds ?? [],
      // Forward a presented anon token when the caller supplies one (the per-token cap test relies on all
      // submits presenting the SAME seeded token; without this the token was dropped and every submit
      // minted a fresh one, so the per-token cap was never actually exercised).
      ...(over.anonToken !== undefined ? { anonToken: over.anonToken } : {}),
    }
  }

  /** Seed a finalized media asset attached to a report, at the given status. */
  async function attachMedia(reportId: string, status: string): Promise<string> {
    const uploadId = randomUUID()
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, report_id, kind, r2_key, status, byte_size)
      VALUES (${uploadId}, ${reportId}, 'image', ${`uploads/2026/06/${"a".repeat(64)}`}, ${status}, 1024)
      RETURNING id
    `
    return row!.id
  }

  it("creates a HELD anon report hidden from map + getReport, visible via status", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.5", cfGeo: {} })
    expect(response.status).toBe("held")

    const [row] = await h.sql<
      {
        reporter_user_id: string | null
        anon_session_id: string | null
        status: string
        published_at: Date | null
        jurisdiction_geoid: string | null
      }[]
    >`
      SELECT reporter_user_id, anon_session_id, status, published_at, jurisdiction_geoid
      FROM reports WHERE id = ${response.reportId}
    `
    expect(row!.reporter_user_id).toBeNull()
    expect(row!.anon_session_id).toBeTruthy()
    expect(row!.status).toBe("held")
    expect(row!.published_at).toBeNull()
    expect(row!.jurisdiction_geoid).toBeTruthy()

    const tl = await h.sql<{ status: string }[]>`
      SELECT status FROM report_timeline WHERE report_id = ${response.reportId} ORDER BY created_at ASC, id ASC
    `
    expect(tl.map((t) => t.status)).toEqual(["submitted", "held"])

    // Absent from the public map candidates (a wide bbox around the point).
    const bbox = {
      west: PROBE_INSIDE_CITY.lng - 0.5,
      south: PROBE_INSIDE_CITY.lat - 0.5,
      east: PROBE_INSIDE_CITY.lng + 0.5,
      north: PROBE_INSIDE_CITY.lat + 0.5,
    }
    const map = await reports.listReportsInBBox(bbox, null, null, 16)
    expect(map.pins.some((p) => p.id === response.reportId)).toBe(false)

    await expect(
      reports.getReport(response.reportId, { userId: "stranger" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    const status = await anon.anonReportStatus(response.reportId, response.claimCode)
    expect(status.status).toBe("held")
    await expect(anon.anonReportStatus(response.reportId, "wrong")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("F087e: REJECTS a held-report submit whose media is VALIDATING but never finalized", async () => {
    const uploadId = randomUUID()
    const [asset] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, byte_size)
      VALUES (${uploadId}, 'image', ${`uploads/2026/06/${uploadId}`}, 'validating', 1024)
      RETURNING id
    `

    // Worst case on this lane: a held anon report waits for every attached asset to leave 'validating'
    // before it can publish. An unfinalized asset has no media.checks job behind it and no sweep
    // coverage once it is bound, so the report would sit in media_pending for good.
    await expect(
      anon.submitAnonReport(req({ mediaUploadIds: [uploadId] }), { ip: "203.0.113.9", cfGeo: {} }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: "One or more media uploads are unavailable." },
    })
    const [unbound] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${asset!.id}
    `
    expect(unbound!.report_id).toBeNull()

    await h.sql`UPDATE media_assets SET finalized_at = now() WHERE id = ${asset!.id}`
    const { response } = await anon.submitAnonReport(req({ mediaUploadIds: [uploadId] }), {
      ip: "203.0.113.9",
      cfGeo: {},
    })
    const [bound] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${asset!.id}
    `
    expect(bound!.report_id).toBe(response.reportId)
  })

  it("releases a held report to published once its media are ready + clean", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.6", cfGeo: {} })
    await attachMedia(response.reportId, "ready")

    const holdRepo = makeDrizzleAnonHoldReleaseRepository(h.sql)
    const result = await releaseAnonHoldIfReady(response.reportId, {
      repo: holdRepo,
      abuseChecks: new FakeAbuseChecks(),
    })
    expect(result.outcome).toBe("published")

    const [row] = await h.sql<{ status: string; published_at: Date | null }[]>`
      SELECT status, published_at FROM reports WHERE id = ${response.reportId}
    `
    expect(row!.status).toBe("published")
    expect(row!.published_at).not.toBeNull()
    // Now it surfaces on the map. The bbox must be STREET-LEVEL: the map query clamps the effective zoom to what
    // the bbox extent can imply (effectiveMapZoom), so the old +/-0.5 degree box implied zoom 10 and
    // returned clusters only, so `pins` would have been empty regardless of visibility.
    const bbox = {
      west: PROBE_INSIDE_CITY.lng - 0.02,
      south: PROBE_INSIDE_CITY.lat - 0.01,
      east: PROBE_INSIDE_CITY.lng + 0.02,
      north: PROBE_INSIDE_CITY.lat + 0.01,
    }
    const map = await reports.listReportsInBBox(bbox, null, null, 16)
    expect(map.pins.some((p) => p.id === response.reportId)).toBe(true)

    // The same released report is also COUNTED (not dropped) when the viewport is wide enough to cluster.
    // +/-1 degree implies zoom 9; the old +/-0.5 box implies 10, which is now the per-pin threshold.
    const wide = await reports.listReportsInBBox(
      {
        west: PROBE_INSIDE_CITY.lng - 1,
        south: PROBE_INSIDE_CITY.lat - 1,
        east: PROBE_INSIDE_CITY.lng + 1,
        north: PROBE_INSIDE_CITY.lat + 1,
      },
      null,
      null,
      16,
    )
    expect(wide.pins).toHaveLength(0)
    expect(wide.clusters.reduce((n, c) => n + c.count, 0)).toBeGreaterThanOrEqual(1)
  })

  it("stays held when a media is rejected (no publish)", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.7", cfGeo: {} })
    await attachMedia(response.reportId, "rejected")
    const result = await releaseAnonHoldIfReady(response.reportId, {
      repo: makeDrizzleAnonHoldReleaseRepository(h.sql),
      abuseChecks: new FakeAbuseChecks(),
    })
    expect(result.outcome).toBe("media_blocked")
    const [row] = await h.sql<
      { status: string }[]
    >`SELECT status FROM reports WHERE id = ${response.reportId}`
    expect(row!.status).toBe("held")
  })

  it("claims a held anon report into a user (single-use) by hash match, then mine=true", async () => {
    const submit = await anon.submitAnonReport(req(), { ip: "203.0.113.8", cfGeo: {} })
    const [u] = await h.sql<
      { id: string }[]
    >`INSERT INTO users (display_name) VALUES ('Claimer') RETURNING id`
    const userId = u!.id

    const res = await claim.claimReport(submit.response.claimCode, userId)
    expect(res.report.id).toBe(submit.response.reportId)
    expect(res.report.mine).toBe(true)

    const [row] = await h.sql<{ reporter_user_id: string | null }[]>`
      SELECT reporter_user_id FROM reports WHERE id = ${submit.response.reportId}
    `
    expect(row!.reporter_user_id).toBe(userId)

    // Single-use: the code is consumed.
    await expect(claim.claimReport(submit.response.claimCode, userId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("replays the original response for a duplicate idempotency key from the SAME anon session", async () => {
    const key = randomUUID()
    const first = await anon.submitAnonReport(req({ idempotencyKey: key }), {
      ip: "203.0.113.9",
      cfGeo: {},
    })
    // The retry carries the token the first submit issued: the stored snapshot is owner-scoped by it.
    const second = await anon.submitAnonReport(
      req({ idempotencyKey: key, anonToken: first.issuedAnonToken! }),
      { ip: "203.0.113.9", cfGeo: {} },
    )
    expect(second.response).toEqual({ ...first.response, claimCode: expect.any(String) })
    const countRows = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(countRows[0]!.n).toBe(1)
  })

  it("F028: a DIFFERENT anon session reusing the key gets a 409, never the first session's snapshot", async () => {
    const key = randomUUID()
    const first = await anon.submitAnonReport(req({ idempotencyKey: key }), {
      ip: "203.0.113.20",
      cfGeo: {},
    })

    // A second session (its own freshly issued token) presenting the squatted key must NOT be handed
    // the first submitter's reportId + claim code; the owner-scoped snapshot read misses and the
    // globally-unique reports.idempotency_key turns the create into the retryable conflict.
    await expect(
      anon.submitAnonReport(req({ idempotencyKey: key }), { ip: "203.0.113.21", cfGeo: {} }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    const countRows = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(countRows[0]!.n).toBe(1)
    const owners = await h.sql<{ user_or_anon: string | null }[]>`
      SELECT user_or_anon FROM idempotency_keys WHERE key = ${key}
    `
    expect(owners).toHaveLength(1)
    const [report] = await h.sql<{ anon_session_id: string | null }[]>`
      SELECT anon_session_id FROM reports WHERE id = ${first.response.reportId}
    `
    expect(report!.anon_session_id).toBe(owners[0]!.user_or_anon)
  })

  it("F150: persists ONLY sha256(claim code) - reports.claim_code stays NULL on every new row", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.22", cfGeo: {} })

    const [row] = await h.sql<{ claim_code: string | null; claim_code_hash: string | null }[]>`
      SELECT claim_code, claim_code_hash FROM reports WHERE id = ${response.reportId}
    `
    expect(row!.claim_code).toBeNull()
    expect(row!.claim_code_hash).toBe(await sha256Hex(response.claimCode))

    // The digest resolves the code on both read paths, and a wrong code still 404s.
    const status = await anon.anonReportStatus(response.reportId, response.claimCode)
    expect(status.status).toBe("held")
    await expect(anon.anonReportStatus(response.reportId, "wrong")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    // No plaintext code is recoverable from the database for this report.
    const [leak] = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM reports WHERE claim_code = ${response.claimCode}
    `
    expect(leak!.n).toBe(0)
  })

  it("F150: a pre-0091 plaintext row whose hash was BACKFILLED stays claimable by its old code", async () => {
    const [u] = await h.sql<
      { id: string }[]
    >`INSERT INTO users (display_name) VALUES ('Legacy') RETURNING id`
    const legacyCode = `legacy-${randomUUID()}`
    const [seeded] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell, claim_code)
      VALUES (
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(${PROBE_INSIDE_CITY.lng}, ${PROBE_INSIDE_CITY.lat}), 4326),
        'device', 'trash', 'dump', 'held', '8a2830828767fff', ${legacyCode}
      )
      RETURNING id
    `
    // Exactly 0091's backfill statement.
    await h.sql`
      UPDATE reports
      SET claim_code_hash = encode(sha256(claim_code::bytea), 'hex')
      WHERE id = ${seeded!.id} AND claim_code IS NOT NULL AND claim_code_hash IS NULL
    `

    const claimed = await claim.claimReport(legacyCode, u!.id)
    expect(claimed.report.id).toBe(seeded!.id)

    // Consumed: BOTH columns are cleared, so no stale plaintext survives the claim.
    const [after] = await h.sql<{ claim_code: string | null; claim_code_hash: string | null }[]>`
      SELECT claim_code, claim_code_hash FROM reports WHERE id = ${seeded!.id}
    `
    expect(after!.claim_code).toBeNull()
    expect(after!.claim_code_hash).toBeNull()
    await expect(claim.claimReport(legacyCode, u!.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("F150: the nudge mints a FRESH code (it cannot read one back) and that code claims the report", async () => {
    const submit = await anon.submitAnonReport(req(), { ip: "203.0.113.23", cfGeo: {} })
    const [u] = await h.sql<
      { id: string }[]
    >`INSERT INTO users (display_name) VALUES ('Nudged') RETURNING id`

    const nudge = await claim.claimNudge(submit.issuedAnonToken!)
    expect(nudge.reportId).toBe(submit.response.reportId)
    expect(nudge.claimCode).not.toBe(submit.response.claimCode)

    const [row] = await h.sql<{ claim_code: string | null; claim_code_hash: string | null }[]>`
      SELECT claim_code, claim_code_hash FROM reports WHERE id = ${submit.response.reportId}
    `
    expect(row!.claim_code).toBeNull()
    expect(row!.claim_code_hash).toBe(await sha256Hex(nudge.claimCode))

    // The superseded code no longer claims; the nudged one does.
    await expect(claim.claimReport(submit.response.claimCode, u!.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const claimed = await claim.claimReport(nudge.claimCode, u!.id)
    expect(claimed.report.id).toBe(submit.response.reportId)
  })

  it("bugs P0-1: concurrent submits on one token never exceed the per-token cap (atomic UPDATE)", async () => {
    // Seed an anon token directly with exactly ONE slot left, then fire many concurrent submits (distinct
    // idempotency keys, distinct IPs so only the per-token cap can bound). The tx-level
    // UPDATE ... WHERE report_count < cap RETURNING makes the check-and-consume atomic, so exactly one
    // submit wins and report_count lands on the cap, never above.
    const tokenId = randomUUID()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await h.sql`
      INSERT INTO anon_tokens (id, expires_at, report_count, flagged)
      VALUES (${tokenId}, ${expiresAt}, ${ANON_TOKEN_REPORT_CAP - 1}, ${false})
    `
    const signed = signAnonToken(tokenId, SIGNING_KEY)

    const N = 8
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_unused, i) =>
        anon.submitAnonReport(req({ idempotencyKey: randomUUID(), anonToken: signed }), {
          ip: `10.2.0.${i}`,
          cfGeo: {},
        }),
      ),
    )
    const created = results.filter((r) => r.status === "fulfilled").length
    expect(created).toBe(1)

    const [tok] = await h.sql<{ report_count: number }[]>`
      SELECT report_count FROM anon_tokens WHERE id = ${tokenId}
    `
    expect(tok!.report_count).toBe(ANON_TOKEN_REPORT_CAP) // never overshoots
    const [rep] = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM reports WHERE anon_session_id = ${tokenId}
    `
    expect(rep!.n).toBe(1)
  })
})
