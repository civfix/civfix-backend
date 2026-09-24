import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { publishMediaAsReady } from "../helpers/media-pg.js"
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
    // No injected repo, so the routes use the Drizzle-backed MediaRepository.
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
    // Intake keys the object by the server-minted uploadId (uploads/YYYY/MM/<uploadId>), NOT the
    // client-claimed sha256: trusting the client's hash as the physical path would let a caller
    // collide/overwrite another object. The worker later promotes verified bytes to the content-
    // addressed uploads/YYYY/MM/<sha256> key for dedup (see media-worker-repo).
    expect(rows[0]!.r2_key).toMatch(new RegExp(`^uploads/\\d{4}/\\d{2}/${uploadId}$`))
    expect(Number(rows[0]!.byte_size)).toBe(1024)
  })

  it("finalize sets status validating and enqueues the media.checks worker job", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/png", byteSize: 2048, sha256: "d".repeat(64) },
    })
    const { uploadId } = createRes.json()

    const [row] = await h.sql<{ id: string; r2_key: string }[]>`
      SELECT id, r2_key FROM media_assets WHERE upload_id = ${uploadId}
    `
    await storage.put(row!.r2_key, new Uint8Array(2048), { contentType: "image/png" })

    const finRes = await app.inject({ method: "POST", url: `/v1/media/${uploadId}/finalize` })
    expect(finRes.statusCode).toBe(200)
    expect(finRes.json().status).toBe("validating")
    expect(finRes.json().mediaId).toBe(row!.id)

    // Only the worker promotes to ready, after stripping EXIF/GPS and moderating.
    const [after] = await h.sql<{ status: string }[]>`
      SELECT status FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(after!.status).toBe("validating")

    const checks = jobs.jobsFor(MEDIA_CHECKS_JOB).filter((j) => {
      const d = j.data as { uploadId?: string }
      return d.uploadId === uploadId
    })
    expect(checks).toHaveLength(1)
  })

  it("F087: a repeat finalize is idempotent: finalized_at is stamped ONCE and no second media.checks job is enqueued", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/png", byteSize: 4096, sha256: "e".repeat(64) },
    })
    const { uploadId } = createRes.json()
    const [row] = await h.sql<{ id: string; r2_key: string }[]>`
      SELECT id, r2_key FROM media_assets WHERE upload_id = ${uploadId}
    `
    await storage.put(row!.r2_key, new Uint8Array(4096), { contentType: "image/png" })

    const first = await app.inject({ method: "POST", url: `/v1/media/${uploadId}/finalize` })
    expect(first.statusCode).toBe(200)
    const [stamped] = await h.sql<{ finalized_at: Date | null }[]>`
      SELECT finalized_at FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(stamped!.finalized_at).not.toBeNull()

    // A status CAS could not catch this: the row is 'validating' for the whole processing window.
    for (let i = 0; i < 3; i++) {
      const again = await app.inject({ method: "POST", url: `/v1/media/${uploadId}/finalize` })
      expect(again.statusCode).toBe(200)
      expect(again.json()).toEqual(first.json())
    }
    const [after] = await h.sql<{ finalized_at: Date | null; status: string }[]>`
      SELECT finalized_at, status FROM media_assets WHERE upload_id = ${uploadId}
    `
    expect(after!.finalized_at).toEqual(stamped!.finalized_at)
    expect(after!.status).toBe("validating")

    const checks = jobs.jobsFor(MEDIA_CHECKS_JOB).filter((j) => {
      const d = j.data as { uploadId?: string }
      return d.uploadId === uploadId
    })
    expect(checks).toHaveLength(1)
  })

  it("getMedia returns a ready row and 404s a validating row", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/webp", byteSize: 4096, sha256: "e".repeat(64) },
    })
    const { uploadId } = createRes.json()
    const [row] = await h.sql<{ id: string }[]>`
      SELECT id FROM media_assets WHERE upload_id = ${uploadId}
    `

    const notReady = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(notReady.statusCode).toBe(404)

    // A ready row whose served_key is still NULL stays a 404: that is the pre-0097 state
    // db:backfill-served-key adopts.
    const servedKey = await publishMediaAsReady(h.sql, row!.id)
    await h.sql`UPDATE media_assets SET width = 800, height = 600 WHERE id = ${row!.id}`
    const ready = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(ready.statusCode).toBe(200)
    const dto = ready.json()
    expect(dto.status).toBe("ready")
    expect(dto.url).toBe(`memory://${servedKey}`)
    expect(dto.width).toBe(800)
  })
})
