import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import type { AnonReportRequest } from "@civfix/shared"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeAnonService, type AnonService } from "../../src/services/anon-service.js"
import { makeClaimService, type ClaimService } from "../../src/services/claim-service.js"
import {
  makeDrizzleAnonReportRepository,
  makeDrizzleClaimRepository,
} from "../../src/services/anon-repository.drizzle.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService } from "../../src/services/report-service.js"
import { PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const SIGNING_KEY = "integration-anon-claim-code-signing-key"

describe.skipIf(!pg)("anonymous claim code at rest (integration)", () => {
  let h: PgHarness
  let anon: AnonService
  let claim: ClaimService

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
    const reports = makeReportService({
      repo: makeDrizzleReportRepository(h.sql),
      resolveJurisdictionGeoid,
      presignMedia: (r2Key: string) => Promise.resolve({ url: `memory://${r2Key}` }),
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

  function req(idempotencyKey: string, anonToken?: string): AnonReportRequest {
    return {
      idempotencyKey,
      turnstileToken: "ok",
      category: "trash",
      type: "dump",
      lat: PROBE_INSIDE_CITY.lat,
      lng: PROBE_INSIDE_CITY.lng,
      geomSource: "device",
      mediaUploadIds: [],
      ...(anonToken !== undefined ? { anonToken } : {}),
    }
  }

  it("keeps the plaintext code out of the idempotency snapshot", async () => {
    const key = randomUUID()
    const { response } = await anon.submitAnonReport(req(key), { ip: "203.0.113.40", cfGeo: {} })

    const rows = await h.sql<{ snapshot: string }[]>`
      SELECT response_snapshot::text AS snapshot FROM idempotency_keys WHERE key = ${key}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.snapshot).toContain(response.reportId)
    expect(rows[0]!.snapshot).not.toContain(response.claimCode)
  })

  it("a replay hands back a fresh code that claims the report, and retires the first one", async () => {
    const key = randomUUID()
    const first = await anon.submitAnonReport(req(key), { ip: "203.0.113.41", cfGeo: {} })
    const replay = await anon.submitAnonReport(req(key, first.issuedAnonToken!), {
      ip: "203.0.113.41",
      cfGeo: {},
    })
    expect(replay.response.reportId).toBe(first.response.reportId)
    expect(replay.response.claimCode).not.toBe(first.response.claimCode)

    const [u] = await h.sql<
      { id: string }[]
    >`INSERT INTO users (display_name) VALUES ('Replayer') RETURNING id`
    await expect(claim.claimReport(first.response.claimCode, u!.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const claimed = await claim.claimReport(replay.response.claimCode, u!.id)
    expect(claimed.report.id).toBe(first.response.reportId)
  })

  it("a replay after the report was claimed answers a conflict instead of a dead code", async () => {
    const key = randomUUID()
    const first = await anon.submitAnonReport(req(key), { ip: "203.0.113.42", cfGeo: {} })
    const [u] = await h.sql<
      { id: string }[]
    >`INSERT INTO users (display_name) VALUES ('Claimer') RETURNING id`
    await claim.claimReport(first.response.claimCode, u!.id)

    await expect(
      anon.submitAnonReport(req(key, first.issuedAnonToken!), { ip: "203.0.113.42", cfGeo: {} }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })
})
