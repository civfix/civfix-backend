import { describe, expect, it, vi } from "vitest"
import { drizzle } from "drizzle-orm/postgres-js"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import type { Db, Sql } from "../../src/db/client.js"
import { makeMediaIntakeService } from "../../src/services/media-intake-service.js"
import { makeDrizzleMediaRepository } from "../../src/services/media-repository.drizzle.js"
import { makeDrizzleMediaWorkerRepo } from "../../src/services/media-worker-repo.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const SHA = "b".repeat(64)
const BYTES = 4096
const RAW_ETAG = '"5D41402ABC4B2A76B9719D911017C592"'
const NORMALIZED_ETAG = "5d41402abc4b2a76b9719d911017c592"
const MEDIA_ID = "11111111-1111-1111-1111-111111111111"
const UPLOAD_ID = "22222222-2222-2222-2222-222222222222"

interface Call {
  query: string
  params: unknown[]
}

function stubDb(rowsFor: (query: string) => unknown[][]) {
  const calls: Call[] = []
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      calls.push({ query, params })
      const rows = rowsFor(query)
      return Object.assign(Promise.resolve([]), { values: () => Promise.resolve(rows) })
    },
    begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client)
    },
  }
  const db = drizzle(client as never) as unknown as Db
  return { db, calls }
}

async function finalizeWithEtag(repo: InMemoryMediaRepository, headEtag: string | undefined) {
  const storage = new FakeStorage()
  const head = storage.head.bind(storage)
  storage.head = async (key: string) => {
    const found = await head(key)
    return found && headEtag !== undefined ? { ...found, etag: headEtag } : found
  }
  const jobs = new FakeJobs()
  const service = makeMediaIntakeService({ repo, storage, jobs })
  const created = await service.createUpload(
    { kind: "image", contentType: "image/jpeg", byteSize: BYTES, sha256: SHA },
    {},
  )
  const asset = (await repo.findByUploadId(created.uploadId))!
  await storage.put(asset.r2Key, new Uint8Array(BYTES), { contentType: "image/jpeg" })
  await service.finalize({ uploadId: created.uploadId }, {})
  return created.uploadId
}

describe("finalize records the upload etag on the media row", () => {
  it("hands the normalized HEAD etag to markFinalized", async () => {
    const repo = new InMemoryMediaRepository()
    const markFinalized = vi.spyOn(repo, "markFinalized")

    const uploadId = await finalizeWithEtag(repo, RAW_ETAG)

    expect(markFinalized).toHaveBeenCalledWith(uploadId, NORMALIZED_ETAG)
  })

  it("passes null when storage reports no etag, so the overwrite check stays off as before", async () => {
    const repo = new InMemoryMediaRepository()
    const markFinalized = vi.spyOn(repo, "markFinalized")

    const uploadId = await finalizeWithEtag(repo, undefined)

    expect(markFinalized).toHaveBeenCalledWith(uploadId, null)
  })

  it("the drizzle repository writes the etag in the same claim that sets finalized_at", async () => {
    const { db, calls } = stubDb(() => [])
    const repo = makeDrizzleMediaRepository(db)

    await repo.markFinalized(UPLOAD_ID, NORMALIZED_ETAG)

    const update = calls.find((c) => /update "media_assets"/.test(c.query))
    expect(update?.query).toMatch(/"upload_etag" = \$\d+/)
    expect(update?.query).toMatch(/"finalized_at" is null/)
    expect(update?.params).toContain(NORMALIZED_ETAG)
  })
})

describe("the stuck sweep reads the stored upload etag", () => {
  it("returns upload_etag with every stuck row it claims", async () => {
    const { db, calls } = stubDb((query) =>
      /^select/.test(query)
        ? [[MEDIA_ID]]
        : [[MEDIA_ID, UPLOAD_ID, "uploads/2026/09/x", null, null, "image", 2, NORMALIZED_ETAG]],
    )
    const repo = makeDrizzleMediaWorkerRepo(db, {} as Sql)

    const rows = await repo.findStuckValidating(new Date(), 10)

    const update = calls.find((c) => /update "media_assets"/.test(c.query))
    expect(update?.query).toMatch(/returning .*"upload_etag"/)
    expect(rows).toEqual([
      {
        id: MEDIA_ID,
        uploadId: UPLOAD_ID,
        r2Key: "uploads/2026/09/x",
        servedKey: null,
        thumbKey: null,
        kind: "image",
        checkCount: 2,
        uploadEtag: NORMALIZED_ETAG,
      },
    ])
  })
})
