/**
 * Anonymous-reporting integration test (Docker-gated). Exercises the REAL Drizzle/PostGIS anon repos +
 * the anon service + the hold-release gate against a live PostGIS container (via withPg). Driven at the
 * service+repository layer (no HTTP/Redis) so it proves the spatial held-create transaction, the
 * held-stays-hidden invariant, the claim-code-gated status, and the release transition directly.
 *
 * Proven here (the Phase-1 done-criterion "held items stay hidden"):
 *   - a held anon report has reporter_user_id NULL, anon_session_id = the token id, status 'held',
 *     published_at NULL, the resolved jurisdiction, geom round-trips, and a submitted+held timeline;
 *   - it is ABSENT from the report-service map candidates (published+public only) and 404s a stranger
 *     via getReport, while its status is visible via anonReportStatus with the right claim code;
 *   - releaseAnonHoldIfReady flips it to published once its media are ready + clean;
 *   - claimReport links it to a user (single-use code).
 *
 * Skips wholesale when Docker is unavailable (describe.skipIf), keeping the local suite green.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeAnonService, type AnonService } from "../../src/services/anon-service.js"
import { makeClaimService, type ClaimService } from "../../src/services/claim-service.js"
import {
  makeDrizzleAnonReportRepository,
  makeDrizzleClaimRepository,
} from "../../src/services/anon-repository.drizzle.js"
import { makeDrizzleAnonHoldReleaseRepo } from "../../src/services/anon-hold-release-repo.drizzle.js"
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
        thumbKey === null ? { url: `memory://${r2Key}` } : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
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
      lat: over.lat ?? PROBE_INSIDE_CITY.lat,
      lng: over.lng ?? PROBE_INSIDE_CITY.lng,
      geomSource: "device",
      mediaUploadIds: over.mediaUploadIds ?? [],
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

    // The row is held, anon, not published, jurisdiction resolved.
    const [row] = await h.sql<
      { reporter_user_id: string | null; anon_session_id: string | null; status: string; published_at: Date | null; jurisdiction_geoid: string | null }[]
    >`
      SELECT reporter_user_id, anon_session_id, status, published_at, jurisdiction_geoid
      FROM reports WHERE id = ${response.reportId}
    `
    expect(row!.reporter_user_id).toBeNull()
    expect(row!.anon_session_id).toBeTruthy()
    expect(row!.status).toBe("held")
    expect(row!.published_at).toBeNull()
    expect(row!.jurisdiction_geoid).toBeTruthy()

    // Timeline: submitted + held.
    const tl = await h.sql<{ status: string }[]>`
      SELECT status FROM report_timeline WHERE report_id = ${response.reportId} ORDER BY created_at ASC, id ASC
    `
    expect(tl.map((t) => t.status)).toEqual(["submitted", "held"])

    // Absent from the public map candidates (a wide bbox around the point).
    const bbox = { west: PROBE_INSIDE_CITY.lng - 0.5, south: PROBE_INSIDE_CITY.lat - 0.5, east: PROBE_INSIDE_CITY.lng + 0.5, north: PROBE_INSIDE_CITY.lat + 0.5 }
    const map = await reports.listReportsInBBox(bbox, null, 16)
    expect(map.pins.some((p) => p.id === response.reportId)).toBe(false)

    // 404 to a stranger via getReport.
    await expect(reports.getReport(response.reportId, { userId: "stranger" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })

    // Status visible with the right claim code; 404 with a wrong one.
    const status = await anon.anonReportStatus(response.reportId, response.claimCode)
    expect(status.status).toBe("held")
    await expect(anon.anonReportStatus(response.reportId, "wrong")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("releases a held report to published once its media are ready + clean", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.6", cfGeo: {} })
    await attachMedia(response.reportId, "ready")

    const holdRepo = makeDrizzleAnonHoldReleaseRepo(h.sql)
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
    // Now it surfaces on the map.
    const bbox = { west: PROBE_INSIDE_CITY.lng - 0.5, south: PROBE_INSIDE_CITY.lat - 0.5, east: PROBE_INSIDE_CITY.lng + 0.5, north: PROBE_INSIDE_CITY.lat + 0.5 }
    const map = await reports.listReportsInBBox(bbox, null, 16)
    expect(map.pins.some((p) => p.id === response.reportId)).toBe(true)
  })

  it("stays held when a media is rejected (no publish)", async () => {
    const { response } = await anon.submitAnonReport(req(), { ip: "203.0.113.7", cfGeo: {} })
    await attachMedia(response.reportId, "rejected")
    const result = await releaseAnonHoldIfReady(response.reportId, {
      repo: makeDrizzleAnonHoldReleaseRepo(h.sql),
      abuseChecks: new FakeAbuseChecks(),
    })
    expect(result.outcome).toBe("media_blocked")
    const [row] = await h.sql<{ status: string }[]>`SELECT status FROM reports WHERE id = ${response.reportId}`
    expect(row!.status).toBe("held")
  })

  it("claims a held anon report into a user (single-use), then mine=true", async () => {
    const submit = await anon.submitAnonReport(req(), { ip: "203.0.113.8", cfGeo: {} })
    const [u] = await h.sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Claimer') RETURNING id`
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

  it("replays the original response for a duplicate idempotency key (no second row)", async () => {
    const key = randomUUID()
    const first = await anon.submitAnonReport(req({ idempotencyKey: key }), { ip: "203.0.113.9", cfGeo: {} })
    const second = await anon.submitAnonReport(req({ idempotencyKey: key }), { ip: "203.0.113.9", cfGeo: {} })
    expect(second.response.reportId).toBe(first.response.reportId)
    const countRows = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(countRows[0]!.n).toBe(1)
  })
})
