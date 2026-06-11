/**
 * Media intake integration test (Docker-gated). Boots the real Fastify app against a live PostGIS
 * container (via withPg) with the Drizzle-backed MediaRepository (NO injected repo) and the default
 * FakeStorage/FakeJobs seams, then exercises the intake flow end-to-end through app.inject:
 *
 *   create   -> a media_assets row exists (status validating, report_id null, content-addressed key).
 *   finalize -> status validating + exactly one "media.checks" job enqueued (singletonKey = uploadId).
 *   getMedia -> a ready row renders a MediaDTO with a url; a validating row 404s on the public path.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf) so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { MEDIA_CHECKS_JOB } from "../../src/services/media-intake-service.js"
import type { FakeStorage, FakeJobs } from "@civfix/shared/fakes"

const pg = await withPg()

const SHA = "c".repeat(64)

describe.skipIf(!pg)("media routes (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let storage: FakeStorage
  let jobs: FakeJobs

  beforeAll(async () => {
    h = pg as PgHarness
    // Real DB; storage + jobs stay fakes (they default to fakes outside production). No injected repo,
    // so the routes use the Drizzle-backed MediaRepository against the live database.
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    const container = buildContainer(env)
    app = await buildServer({ env, container })
    storage = container.storage as unknown as FakeStorage
    jobs = container.jobs as unknown as FakeJobs
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  it("create inserts a validating media_assets row with report_id null", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/jpeg", byteSize: 1024, sha256: SHA },
    })
    expect(res.statusCode).toBe(200)
    const { uploadId, putUrl } = res.json()
    expect(putUrl).toMatch(/^memory:\/\/uploads\//)

    const rows = await h.sql<
      { id: string; status: string; report_id: string | null; r2_key: string; byte_size: number }[]
    >`SELECT id, status, report_id, r2_key, byte_size FROM media_assets WHERE upload_id = ${uploadId}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("validating")
    expect(rows[0]!.report_id).toBeNull()
    expect(rows[0]!.r2_key).toMatch(/^uploads\/\d{4}\/\d{2}\/c{64}$/)
    expect(Number(rows[0]!.byte_size)).toBe(1024)
  })

  it("finalize sets status validating and enqueues one media.checks job", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/png", byteSize: 2048, sha256: "d".repeat(64) },
    })
    const { uploadId } = createRes.json()

    const [row] = await h.sql<{ id: string; r2_key: string }[]>`
      SELECT id, r2_key FROM media_assets WHERE upload_id = ${uploadId}
    `
    // Simulate the direct-to-R2 PUT having landed so finalize's HEAD check passes.
    await storage.put(row!.r2_key, new Uint8Array(2048), { contentType: "image/png" })

    const finRes = await app.inject({ method: "POST", url: `/v1/media/${uploadId}/finalize` })
    expect(finRes.statusCode).toBe(200)
    expect(finRes.json().status).toBe("validating")
    expect(finRes.json().mediaId).toBe(row!.id)

    const [after] = await h.sql<{ status: string }[]>`
      SELECT status FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(after!.status).toBe("validating")

    const checks = jobs.jobsFor(MEDIA_CHECKS_JOB).filter((j) => {
      const d = j.data as { uploadId?: string }
      return d.uploadId === uploadId
    })
    expect(checks).toHaveLength(1)
    expect(checks[0]?.opts?.singletonKey).toBe(uploadId)
  })

  it("getMedia returns a ready row and 404s a validating row", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/webp", byteSize: 4096, sha256: "e".repeat(64) },
    })
    const { uploadId } = createRes.json()
    const [row] = await h.sql<{ id: string; r2_key: string }[]>`
      SELECT id, r2_key FROM media_assets WHERE upload_id = ${uploadId}
    `

    // While validating -> 404 on the public path.
    const notReady = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(notReady.statusCode).toBe(404)

    // Flip to ready (as the worker would) and re-fetch.
    await h.sql`UPDATE media_assets SET status = 'ready', width = 800, height = 600 WHERE id = ${row!.id}`
    const ready = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(ready.statusCode).toBe(200)
    const dto = ready.json()
    expect(dto.status).toBe("ready")
    expect(dto.url).toBe(`memory://${row!.r2_key}`)
    expect(dto.width).toBe(800)
  })
})
