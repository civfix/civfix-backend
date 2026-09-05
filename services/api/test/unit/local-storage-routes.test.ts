import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { MAX_VIDEO_BYTES } from "@civfix/shared"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { LocalDiskStorage } from "../../src/adapters/storage.local.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const PUBLIC_API_URL = "http://localhost:8080"
const SHA = "c".repeat(64)

interface Harness {
  app: FastifyInstance
  storage: LocalDiskStorage
  inboundStorage: LocalDiskStorage
}

let directory: string
let current: Harness | undefined

function envSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_API_URL,
    LOCAL_STORAGE_DIR: directory,
    LOCAL_STORAGE_SIGNING_KEY: "route-test-local-storage-signing-key",
    ...overrides,
  }
}

async function makeHarness(): Promise<Harness> {
  const env = loadEnv(envSource())
  const container = buildContainer(env)
  const app = await buildServer({ env, container, mediaRepo: new InMemoryMediaRepository() })
  const harness: Harness = {
    app,
    storage: container.storage as LocalDiskStorage,
    inboundStorage: container.inboundStorage as LocalDiskStorage,
  }
  current = harness
  return harness
}

function pathAndQueryOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "civfix-local-storage-routes-"))
})

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
  await rm(directory, { recursive: true, force: true })
})

describe("local-disk storage driver selection", () => {
  it("selects the local-disk adapter over the in-memory fake", async () => {
    const { storage } = await makeHarness()
    expect(storage).toBeInstanceOf(LocalDiskStorage)
  })

  it("refuses to load an environment that enables the driver in production", () => {
    expect(() =>
      loadEnv(
        envSource({
          NODE_ENV: "production",
          WEB_ORIGINS: "https://civfix.org",
          DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
          REDIS_URL: "redis://localhost:6379",
          SESSION_SIGNING_KEY: "a-real-session-signing-key",
          ANON_TOKEN_SIGNING_KEY: "a-real-anon-signing-key",
          USE_FAKE_STORAGE: "1",
          USE_FAKE_MAILER: "1",
          USE_FAKE_CHAT: "1",
          USE_FAKE_JOBS: "1",
          USE_FAKE_PUSH: "1",
          USE_FAKE_USER_CHANNEL: "1",
        }),
      ),
    ).toThrow(/LOCAL_STORAGE_DIR: the local-disk storage driver is DEVELOPMENT ONLY/)
  })

  it("does not mount the local-storage routes when the driver is off", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const container = buildContainer(env)
    const app = await buildServer({ env, container, mediaRepo: new InMemoryMediaRepository() })
    current = {
      app,
      storage: container.storage as LocalDiskStorage,
      inboundStorage: container.inboundStorage as LocalDiskStorage,
    }
    expect(container.developmentOnlyLocalObjectStores).toBeUndefined()
    const res = await app.inject({
      method: "GET",
      url: `/_local-storage/media/uploads/x?exp=1&sig=${"0".repeat(64)}`,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe("presign -> PUT -> GET round trip", () => {
  it("uploads through the presigned PUT and serves the same bytes back", async () => {
    const { app, storage } = await makeHarness()
    const bytes = Buffer.from("a real jpeg would go here")

    const created = await app.inject({
      method: "POST",
      url: "/v1/media/upload",
      payload: {
        kind: "image",
        contentType: "image/jpeg",
        byteSize: bytes.byteLength,
        sha256: SHA,
      },
    })
    expect(created.statusCode).toBe(200)
    const { putUrl, headers } = created.json() as {
      putUrl: string
      headers: Record<string, string>
    }
    expect(putUrl.startsWith(`${PUBLIC_API_URL}/_local-storage/media/uploads/`)).toBe(true)

    const uploaded = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(putUrl),
      headers: { "content-type": headers["content-type"] as string },
      payload: bytes,
    })
    expect(uploaded.statusCode).toBe(200)

    const key = new URL(putUrl).pathname.replace("/_local-storage/media/", "")
    expect((await storage.head(key))?.contentType).toBe("image/jpeg")

    const getUrl = await storage.presignGet(key, 300)
    const fetched = await app.inject({ method: "GET", url: pathAndQueryOf(getUrl) })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.headers["content-type"]).toBe("image/jpeg")
    expect(fetched.headers["cross-origin-resource-policy"]).toBe("cross-origin")
    expect(fetched.rawPayload.equals(bytes)).toBe(true)
  })

  it("serves a byte range so video elements can seek", async () => {
    const { app, storage } = await makeHarness()
    await storage.put("uploads/2026/07/clip", Buffer.from("0123456789"), {
      contentType: "video/mp4",
    })
    const getUrl = await storage.presignGet("uploads/2026/07/clip", 300)

    const partial = await app.inject({
      method: "GET",
      url: pathAndQueryOf(getUrl),
      headers: { range: "bytes=2-5" },
    })
    expect(partial.statusCode).toBe(206)
    expect(partial.headers["content-range"]).toBe("bytes 2-5/10")
    expect(partial.rawPayload.toString()).toBe("2345")

    const unsatisfiable = await app.inject({
      method: "GET",
      url: pathAndQueryOf(getUrl),
      headers: { range: "bytes=99-" },
    })
    expect(unsatisfiable.statusCode).toBe(416)
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */10")
  })

  it("replays a stored content-disposition on the signed GET", async () => {
    const { app, storage } = await makeHarness()
    await storage.put("certificates/service-hours/2026/07/doc.pdf", Buffer.from("%PDF-"), {
      contentType: "application/pdf",
      contentDisposition: 'inline; filename="civfix.pdf"',
    })
    const getUrl = await storage.presignGet("certificates/service-hours/2026/07/doc.pdf", 300)
    const res = await app.inject({ method: "GET", url: pathAndQueryOf(getUrl) })
    expect(res.headers["content-disposition"]).toBe('inline; filename="civfix.pdf"')
  })

  it("emits the object ETag so the dev stack exercises the media version binding", async () => {
    const { app, storage } = await makeHarness()
    const key = "uploads/2026/09/etagged"
    await storage.put(key, Buffer.from("some-bytes"), { contentType: "image/jpeg" })
    const head = await storage.head(key)
    const getUrl = await storage.presignGet(key, 300)

    const res = await app.inject({ method: "GET", url: pathAndQueryOf(getUrl) })

    expect(res.statusCode).toBe(200)
    expect(head?.etag).toBeDefined()
    expect(res.headers.etag).toBe(`"${head!.etag!}"`)
  })

  it("404s a signed GET for an object that was never written", async () => {
    const { app, storage } = await makeHarness()
    const getUrl = await storage.presignGet("uploads/2026/07/absent", 300)
    const res = await app.inject({ method: "GET", url: pathAndQueryOf(getUrl) })
    expect(res.statusCode).toBe(404)
  })

  it("accepts an upload far above the 256 KB server-wide body limit", async () => {
    const { app, storage } = await makeHarness()
    const bytes = Buffer.alloc(700_000, 7)
    const put = await storage.presignPut("uploads/2026/07/large", {
      contentType: "image/jpeg",
      byteSize: bytes.byteLength,
    })
    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "image/jpeg" },
      payload: bytes,
    })
    expect(res.statusCode).toBe(200)
    expect((await storage.head("uploads/2026/07/large"))?.size).toBe(bytes.byteLength)
  })
})

describe("namespace isolation", () => {
  it("keeps raw inbound mail out of the media namespace entirely", async () => {
    const { app, storage, inboundStorage } = await makeHarness()
    expect(inboundStorage).toBeInstanceOf(LocalDiskStorage)
    expect(inboundStorage).not.toBe(storage)

    const key = "inbound/pending/private.eml"
    await inboundStorage.put(key, Buffer.from("From: citizen\r\n\r\nprivate"), {
      contentType: "message/rfc822",
    })
    expect(await storage.head(key)).toBeNull()

    const mediaGrant = new URL(await storage.presignGet(key, 300))
    const replayedOnInbound = `/_local-storage/inbound/${key}${mediaGrant.search}`
    expect((await app.inject({ method: "GET", url: replayedOnInbound })).statusCode).toBe(403)
    expect(
      (await app.inject({ method: "GET", url: pathAndQueryOf(mediaGrant.toString()) })).statusCode,
    ).toBe(404)

    const inboundGrant = await inboundStorage.presignGet(key, 300)
    const served = await app.inject({ method: "GET", url: pathAndQueryOf(inboundGrant) })
    expect(served.statusCode).toBe(200)
    expect(served.headers["content-type"]).toBe("message/rfc822")
  })

  it("404s an unknown namespace", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: `/_local-storage/secrets/uploads/a?exp=9999999999&sig=${"0".repeat(64)}`,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe("presigned request rejection", () => {
  it("rejects a tampered signature on both verbs", async () => {
    const { app, storage } = await makeHarness()
    const put = await storage.presignPut("uploads/2026/07/tampered", {
      contentType: "image/jpeg",
      byteSize: 3,
    })
    const tamperedPut = pathAndQueryOf(put.url).replace(/sig=[0-9a-f]{64}/, `sig=${"0".repeat(64)}`)
    const putRes = await app.inject({
      method: "PUT",
      url: tamperedPut,
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from("abc"),
    })
    expect(putRes.statusCode).toBe(403)

    const get = await storage.presignGet("uploads/2026/07/tampered", 300)
    const tamperedGet = pathAndQueryOf(get).replace(/sig=[0-9a-f]{64}/, `sig=${"0".repeat(64)}`)
    expect((await app.inject({ method: "GET", url: tamperedGet })).statusCode).toBe(403)
  })

  it("rejects an expired signature", async () => {
    const { app, storage } = await makeHarness()
    await storage.put("uploads/2026/07/stale", Buffer.from("x"), { contentType: "image/jpeg" })
    const stale = await storage.presignGet("uploads/2026/07/stale", 1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await app.inject({ method: "GET", url: pathAndQueryOf(stale) })).statusCode).toBe(403)
  })

  it("rejects a malformed signature without a 500", async () => {
    const { app, storage } = await makeHarness()
    const base = pathAndQueryOf(await storage.presignGet("uploads/2026/07/stale", 300))
    for (const signature of ["not-hex", "\u00e9".repeat(64), "A".repeat(64), ""]) {
      const url = base.replace(/sig=[0-9a-f]{64}/, `sig=${encodeURIComponent(signature)}`)
      const res = await app.inject({ method: "GET", url })
      expect([403, 422], signature).toContain(res.statusCode)
    }
  })

  it("rejects a traversal key before the signature is even considered", async () => {
    const { app } = await makeHarness()
    const query = `exp=9999999999&sig=${"0".repeat(64)}`
    for (const path of [
      "/_local-storage/media/../../etc/passwd",
      "/_local-storage/media/uploads/..%2f..%2fetc%2fpasswd",
      "/_local-storage/media/uploads%2f..%2f..%2fetc",
      "/_local-storage/media/uploads/2026/07/a%00b",
    ]) {
      const res = await app.inject({ method: "GET", url: `${path}?${query}` })
      expect(res.statusCode, path).toBe(404)
    }

    const safeKeyBadSignature = await app.inject({
      method: "GET",
      url: `/_local-storage/media/uploads/2026/07/well-formed?${query}`,
    })
    expect(safeKeyBadSignature.statusCode).toBe(403)
  })

  it("rejects a PUT whose content type does not match the presign", async () => {
    const { app, storage } = await makeHarness()
    const put = await storage.presignPut("uploads/2026/07/wrong-type", {
      contentType: "image/jpeg",
      byteSize: 3,
    })
    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "image/png" },
      payload: Buffer.from("abc"),
    })
    expect(res.statusCode).toBe(422)
    expect(await storage.head("uploads/2026/07/wrong-type")).toBeNull()
  })

  it("rejects a PUT whose body size does not match the presigned length", async () => {
    const { app, storage } = await makeHarness()
    const put = await storage.presignPut("uploads/2026/07/wrong-size", {
      contentType: "image/jpeg",
      byteSize: 3,
    })
    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "image/jpeg" },
      payload: Buffer.from("far too many bytes"),
    })
    expect(res.statusCode).toBe(422)
    expect(await storage.head("uploads/2026/07/wrong-size")).toBeNull()
  })

  it("verifies the PUT signature exactly once across the onRequest hook and the handler", async () => {
    const { app, storage } = await makeHarness()
    const bytes = Buffer.from("verify-once")
    const put = await storage.presignPut("uploads/2026/07/verify-once", {
      contentType: "image/jpeg",
      byteSize: bytes.byteLength,
    })
    const verify = vi.spyOn(storage, "verifySignedRequest")

    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "image/jpeg" },
      payload: bytes,
    })

    expect(res.statusCode).toBe(200)
    expect(verify).toHaveBeenCalledTimes(1)
    verify.mockRestore()
  })

  it("aborts an oversize chunked PUT that carries no content-length before storing it", async () => {
    const { app, storage } = await makeHarness()
    const put = await storage.presignPut("uploads/2026/07/chunked-oversize", {
      contentType: "image/jpeg",
      byteSize: 8,
    })

    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "image/jpeg" },
      payload: Readable.from([Buffer.alloc(64, 1), Buffer.alloc(64, 2)]),
    })

    expect(res.statusCode).toBe(422)
    expect(await storage.head("uploads/2026/07/chunked-oversize")).toBeNull()
  })

  it("rejects a presign request above the video size ceiling", async () => {
    const { app, storage } = await makeHarness()
    const put = await storage.presignPut("uploads/2026/07/oversize", {
      contentType: "video/mp4",
      byteSize: MAX_VIDEO_BYTES + 1,
    })
    const res = await app.inject({
      method: "PUT",
      url: pathAndQueryOf(put.url),
      headers: { "content-type": "video/mp4" },
      payload: Buffer.from("x"),
    })
    expect(res.statusCode).toBe(422)
  })
})
