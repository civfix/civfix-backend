import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { MAX_IMAGE_BYTES } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryMediaRepository } from "../helpers/media.js"
import { MEDIA_CHECKS_JOB } from "../../src/services/media-intake-service.js"
import type { FakeStorage, FakeJobs } from "@civfix/shared/fakes"

/**
 * Route-level tests for the media plugin, run with NO database: an in-memory MediaRepository is
 * injected into buildServer (opts.mediaRepo) and the container's storage/jobs are the default fakes.
 * Exercised through the real Fastify app via app.inject. The DB-backed Drizzle repo is covered by the
 * Docker-gated integration test instead.
 */

const SHA = "b".repeat(64)

interface Harness {
  app: FastifyInstance
  repo: InMemoryMediaRepository
  storage: FakeStorage
  jobs: FakeJobs
}

let current: Harness | undefined

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const container = buildContainer(env)
  const repo = new InMemoryMediaRepository()
  const app = await buildServer({ env, container, mediaRepo: repo })
  const h: Harness = {
    app,
    repo,
    storage: container.storage as unknown as FakeStorage,
    jobs: container.jobs as unknown as FakeJobs,
  }
  current = h
  return h
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("POST /media/upload", () => {
  it("creates an upload: inserts a row and returns putUrl + echo headers", async () => {
    const { app, repo } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/jpeg", byteSize: 1024, sha256: SHA },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.uploadId).toBe("string")
    expect(body.putUrl).toMatch(/^memory:\/\/uploads\//)
    expect(body.headers["content-type"]).toBe("image/jpeg")
    expect(body.headers["content-length"]).toBe("1024")
    expect(repo.byId.size).toBe(1)
  })

  it("rejects an oversize image with the 422 MEDIA_REJECTED envelope", async () => {
    const { app, repo } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/jpeg", byteSize: MAX_IMAGE_BYTES + 1, sha256: SHA },
    })
    // The shared schema caps byteSize at MAX_VIDEO_BYTES and the superRefine enforces the per-kind cap,
    // so an oversize-for-image (but <= video cap) value is a VALIDATION (422) failure at the boundary.
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(repo.byId.size).toBe(0)
  })

  it("rejects a disallowed contentType with 422 MEDIA_REJECTED", async () => {
    const { app, repo } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/gif", byteSize: 1024, sha256: SHA },
    })
    // contentType shape passes the schema (any non-empty string), so the service's allowlist rejects it.
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("MEDIA_REJECTED")
    expect(repo.byId.size).toBe(0)
  })

  it("rejects a malformed body (missing sha256) with the 422 validation envelope", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/jpeg", byteSize: 1024 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("POST /media/:uploadId/finalize", () => {
  it("finalizes after upload: marks the media validating and enqueues the media.checks worker job", async () => {
    const { app, repo, storage, jobs } = await makeHarness()

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/jpeg", byteSize: 2048, sha256: SHA },
    })
    const { uploadId } = createRes.json()
    const row = await repo.findByUploadId(uploadId)
    // Simulate the direct-to-R2 PUT having landed.
    await storage.put(row!.r2Key, new Uint8Array(2048), { contentType: "image/jpeg" })

    const finRes = await app.inject({ method: "POST", url: `/v1/media/${uploadId}/finalize` })
    expect(finRes.statusCode).toBe(200)
    const fin = finRes.json()
    expect(fin.status).toBe("validating")
    expect(fin.mediaId).toBe(row!.id)
    // The row stays VALIDATING until the worker strips EXIF/GPS + runs moderation, then promotes to ready.
    expect((await repo.findByUploadId(uploadId))!.status).toBe("validating")

    // finalize enqueues exactly one media.checks job (deduped by uploadId) for the worker to process.
    const enqueued = jobs.jobsFor(MEDIA_CHECKS_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toMatchObject({ uploadId })
  })

  it("404s when finalizing an unknown uploadId", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/00000000-0000-0000-0000-000000000000/finalize",
    })
    expect(res.statusCode).toBe(404)
  })

  it("422s when the uploadId path param is not a UUID", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "POST", url: "/v1/media/not-a-uuid/finalize" })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("GET /media/:id", () => {
  it("returns a MediaDTO with a presigned url for ready media", async () => {
    const { app, repo } = await makeHarness()
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/png", byteSize: 4096, sha256: SHA },
    })
    const { uploadId } = createRes.json()
    const row = await repo.findByUploadId(uploadId)
    repo.patch(row!.id, { status: "ready", width: 640, height: 480 })

    const res = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(res.statusCode).toBe(200)
    const dto = res.json()
    expect(dto.id).toBe(row!.id)
    expect(dto.status).toBe("ready")
    expect(dto.url).toBe(`memory://${row!.r2Key}`)
    expect(dto.width).toBe(640)
  })

  it("404s for not-yet-ready (validating) media on the public path", async () => {
    const { app, repo } = await makeHarness()
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: { kind: "image", contentType: "image/png", byteSize: 4096, sha256: SHA },
    })
    const { uploadId } = createRes.json()
    const row = await repo.findByUploadId(uploadId)
    const res = await app.inject({ method: "GET", url: `/v1/media/${row!.id}` })
    expect(res.statusCode).toBe(404)
  })
})
