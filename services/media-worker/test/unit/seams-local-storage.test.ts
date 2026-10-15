import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/shared/fakes"
import { LocalDiskStorage } from "@civfix/api/adapters/storage-local"
import { makeSeams } from "../../src/seams.js"

const PUBLIC_API_URL = "http://localhost:8080"
const SIGNING_KEY = "worker-test-local-storage-signing-key"

let directory: string

function makeApiMediaStore(): LocalDiskStorage {
  return new LocalDiskStorage({
    rootDirectory: directory,
    namespace: "media",
    publicApiUrl: PUBLIC_API_URL,
    signingKey: SIGNING_KEY,
    nodeEnv: "test",
  })
}

function source(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    USE_FAKE_ABUSE_NSFW: "1",
    LOCAL_STORAGE_DIR: directory,
    LOCAL_STORAGE_SIGNING_KEY: SIGNING_KEY,
    PUBLIC_API_URL,
    ...overrides,
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "civfix-worker-local-storage-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("media-worker local-disk storage seam", () => {
  it("selects the local-disk adapter over the in-memory fake", async () => {
    const seams = await makeSeams(source())
    try {
      expect(seams.storage).toBeInstanceOf(LocalDiskStorage)
    } finally {
      await seams.close()
    }
  })

  it("falls back to the fake when no local directory is configured", async () => {
    const seams = await makeSeams({ NODE_ENV: "test", USE_FAKE_ABUSE_NSFW: "1" })
    try {
      expect(seams.storage).toBeInstanceOf(FakeStorage)
    } finally {
      await seams.close()
    }
  })

  it("reads back objects the API process wrote to the same directory", async () => {
    const api = makeApiMediaStore()
    await api.put("uploads/2026/07/cross-process", Buffer.from("shared bytes"), {
      contentType: "image/jpeg",
    })

    const seams = await makeSeams(source())
    try {
      const bytes = await seams.storage.getObject("uploads/2026/07/cross-process")
      expect(Buffer.from(bytes ?? new Uint8Array()).toString()).toBe("shared bytes")
      expect((await seams.storage.head("uploads/2026/07/cross-process"))?.contentType).toBe(
        "image/jpeg",
      )

      await seams.storage.put("thumbs/uploads/2026/07/cross-process.jpg", Buffer.from("thumb"), {
        contentType: "image/jpeg",
      })
      expect((await api.head("thumbs/uploads/2026/07/cross-process.jpg"))?.size).toBe(5)

      await seams.storage.delete("uploads/2026/07/cross-process")
      expect(await api.head("uploads/2026/07/cross-process")).toBeNull()
    } finally {
      await seams.close()
    }
  })

  it("mints a presigned GET the API can verify, so download.ts keeps working", async () => {
    const api = makeApiMediaStore()
    const seams = await makeSeams(source())
    try {
      const url = new URL(await seams.storage.presignGet("uploads/2026/07/downloadable", 120))
      expect(url.origin).toBe(PUBLIC_API_URL)
      expect(
        api.verifySignedRequest(
          {
            method: "GET",
            key: "uploads/2026/07/downloadable",
            expiresAtSec: Number(url.searchParams.get("exp")),
            contentType: "",
            byteSize: 0,
            signature: url.searchParams.get("sig") ?? "",
          },
          Math.floor(Date.now() / 1000),
        ),
      ).toBe("valid")
    } finally {
      await seams.close()
    }
  })

  it("refuses to build the local-disk seam in production", async () => {
    await expect(makeSeams(source({ NODE_ENV: "production" }))).rejects.toThrow(
      /DEVELOPMENT ONLY|production/i,
    )
  })
})
