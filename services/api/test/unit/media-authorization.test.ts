import { describe, it, expect } from "vitest"
import { FakeStorage, FakeJobs } from "@civfix/shared/fakes"
import type { CreateMediaUploadRequest } from "@civfix/shared"
import {
  makeMediaIntakeService,
  MEDIA_PRIVATE_GET_URL_TTL_SEC,
  MEDIA_GET_URL_TTL_SEC,
  quotaSubjects,
  type MediaIntakeService,
  type MediaAssetView,
  type MediaOwner,
} from "../../src/services/media-intake-service.js"
import {
  makeUnboundOnlyMediaViewAuthorizer,
  UNBOUND_GRACE_MS,
  type MediaAccessDecision,
  type MediaViewAuthorizer,
} from "../../src/services/media-authorization.js"
import { InMemoryByteMeter } from "../../src/services/media-byte-quota.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const SHA = "c".repeat(64)

function imageReq(over: Partial<CreateMediaUploadRequest> = {}): CreateMediaUploadRequest {
  return { kind: "image", contentType: "image/jpeg", byteSize: 1024, sha256: SHA, ...over }
}

class RecordingStorage extends FakeStorage {
  readonly presignCalls: { key: string; ttlSec: number; forceSigned: boolean }[] = []
  override presignGet(
    key: string,
    ttlSec: number,
    opts?: { forceSigned?: boolean },
  ): Promise<string> {
    this.presignCalls.push({ key, ttlSec, forceSigned: opts?.forceSigned === true })
    return super.presignGet(key, ttlSec)
  }
}

function harness(authorizer?: MediaViewAuthorizer) {
  const repo = new InMemoryMediaRepository()
  const storage = new RecordingStorage()
  const jobs = new FakeJobs()
  const service: MediaIntakeService = makeMediaIntakeService({
    repo,
    storage,
    jobs,
    ...(authorizer ? { authorizer } : {}),
  })
  return { repo, storage, jobs, service }
}

async function readyMedia(h: ReturnType<typeof harness>, patch: Partial<MediaAssetView> = {}) {
  const { uploadId } = await h.service.createUpload(imageReq(), {})
  const row = (await h.repo.findByUploadId(uploadId))!
  h.repo.patch(row.id, { status: "ready", servedKey: `processed/${row.r2Key}`, ...patch })
  return (await h.repo.findById(row.id))!
}

const ANON: MediaOwner = {}
const VIEWER: MediaOwner = { userId: "viewer-1" }

describe("getMedia authorization (H9)", () => {
  it("serves an unbound, fresh upload (the pre-commit capability window) as a SIGNED short-lived url", async () => {
    const h = harness()
    const asset = await readyMedia(h)

    const dto = await h.service.getMedia(asset.id, ANON)

    expect(dto.id).toBe(asset.id)
    const call = h.storage.presignCalls.at(-1)!
    expect(call.forceSigned).toBe(true)
    expect(call.ttlSec).toBe(MEDIA_PRIVATE_GET_URL_TTL_SEC)
  })

  it("404s an unbound upload once it is past the capability window (a deleted report NULLs report_id)", async () => {
    const h = harness()
    const stale = new Date(Date.now() - UNBOUND_GRACE_MS - 1000)
    const asset = await readyMedia(h, { createdAt: stale })

    await expect(h.service.getMedia(asset.id, ANON)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s (never 403) when the authorizer denies, so the endpoint is not an existence oracle", async () => {
    const denyAll: MediaViewAuthorizer = {
      authorize: (): Promise<MediaAccessDecision> =>
        Promise.resolve({ allowed: false, private: true }),
    }
    const h = harness(denyAll)
    const asset = await readyMedia(h)

    await expect(h.service.getMedia(asset.id, VIEWER)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Media not found",
    })
  })

  it("issues a CDN-eligible, longer-lived url only when the authorizer says the asset is public", async () => {
    const allowPublic: MediaViewAuthorizer = {
      authorize: (): Promise<MediaAccessDecision> =>
        Promise.resolve({ allowed: true, private: false }),
    }
    const h = harness(allowPublic)
    const asset = await readyMedia(h)

    await h.service.getMedia(asset.id, VIEWER)

    const call = h.storage.presignCalls.at(-1)!
    expect(call.forceSigned).toBe(false)
    expect(call.ttlSec).toBe(MEDIA_GET_URL_TTL_SEC)
  })

  it("still 404s not-yet-ready media before authorization runs", async () => {
    const h = harness()
    const { uploadId } = await h.service.createUpload(imageReq(), {})
    const row = (await h.repo.findByUploadId(uploadId))!

    await expect(h.service.getMedia(row.id, VIEWER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("404s verification media on the public path", async () => {
    const h = harness()
    const asset = await readyMedia(h, { purpose: "verification" })

    await expect(h.service.getMedia(asset.id, VIEWER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("makeUnboundOnlyMediaViewAuthorizer (the fail-closed default)", () => {
  const base: MediaAssetView = {
    id: "m1",
    uploadId: "u1",
    kind: "image",
    codec: null,
    r2Key: "uploads/2026/07/u1",
    servedKey: "processed/uploads/2026/07/u1",
    thumbKey: null,
    status: "ready",
    width: null,
    height: null,
    byteSize: 1,
    reportId: null,
    chatMessageId: null,
    postId: null,
    createdAt: new Date(),
  }

  it("DENIES every bound asset: a wiring that forgets the real authorizer serves nothing", async () => {
    const auth = makeUnboundOnlyMediaViewAuthorizer()
    for (const binding of [
      { reportId: "r1" },
      { chatMessageId: "c1" },
      { postId: "p1" },
    ] as Partial<MediaAssetView>[]) {
      const decision = await auth.authorize({ ...base, ...binding }, VIEWER)
      expect(decision.allowed).toBe(false)
    }
  })

  it("denies an asset with no createdAt (cannot be proven fresh)", async () => {
    const auth = makeUnboundOnlyMediaViewAuthorizer()
    const decision = await auth.authorize({ ...base, createdAt: null }, VIEWER)
    expect(decision.allowed).toBe(false)
  })
})

describe("presigned-byte quota (M10)", () => {
  function quotaService(
    meter: { add: (s: string, b: number) => Promise<number> },
    limitBytes: number,
  ): MediaIntakeService {
    return makeMediaIntakeService({
      repo: new InMemoryMediaRepository(),
      storage: new FakeStorage(),
      jobs: new FakeJobs(),
      byteQuota: { limitBytes, charge: (s, b) => meter.add(s, b) },
    })
  }

  it("rejects once cumulative presigned BYTES exceed the per-subject window budget", async () => {
    const repo = new InMemoryMediaRepository()
    const storage = new FakeStorage()
    const jobs = new FakeJobs()
    const meter = new InMemoryByteMeter()
    const service = makeMediaIntakeService({
      repo,
      storage,
      jobs,
      byteQuota: { limitBytes: 2048, charge: (s, b) => meter.add(s, b) },
    })
    const owner: MediaOwner = { ipKey: "203.0.113.9" }

    await service.createUpload(imageReq({ byteSize: 1024 }), owner)
    await service.createUpload(imageReq({ byteSize: 1024 }), owner)
    await expect(service.createUpload(imageReq({ byteSize: 1024 }), owner)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("meters a signed-in user by ACCOUNT, so rotating IPs does not reset the budget", () => {
    expect(quotaSubjects({ userId: "u1", ipKey: "1.1.1.1" })).toEqual(["u:u1"])
    expect(quotaSubjects({ userId: "u1", ipKey: "2.2.2.2" })).toEqual(["u:u1"])
  })

  it("F016: an anon caller is metered by IP as well as by the client-chosen anon cookie", () => {
    expect(quotaSubjects({ anonSessionId: "a1", ipKey: "1.1.1.1" })).toEqual(["a:a1", "ip:1.1.1.1"])
    expect(quotaSubjects({ ipKey: "1.1.1.1" })).toEqual(["ip:1.1.1.1"])
    expect(quotaSubjects({})).toEqual(["ip:unknown"])
  })

  it("F016: rotating the civfix_anon cookie does NOT reset the budget (the IP bucket still caps)", async () => {
    const meter = new InMemoryByteMeter()
    const service = quotaService(meter, 2048)
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      anonSessionId: "rotating-1",
      ipKey: "203.0.113.9",
    })
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      anonSessionId: "rotating-2",
      ipKey: "203.0.113.9",
    })
    await expect(
      service.createUpload(imageReq({ byteSize: 1024 }), {
        anonSessionId: "rotating-3",
        ipKey: "203.0.113.9",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("F016: the anon bucket still caps a single browser that rotates its IP", async () => {
    const meter = new InMemoryByteMeter()
    const service = quotaService(meter, 2048)
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      anonSessionId: "sticky",
      ipKey: "203.0.113.1",
    })
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      anonSessionId: "sticky",
      ipKey: "203.0.113.2",
    })
    await expect(
      service.createUpload(imageReq({ byteSize: 1024 }), {
        anonSessionId: "sticky",
        ipKey: "203.0.113.3",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("F016: an over-budget anon bucket does not shield the IP bucket from being charged", async () => {
    const charged: string[] = []
    const meter = new InMemoryByteMeter()
    const service = quotaService(
      {
        add: (subject, bytes) => {
          charged.push(subject)
          return meter.add(subject, bytes)
        },
      },
      1024,
    )
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      anonSessionId: "a1",
      ipKey: "203.0.113.9",
    })
    await expect(
      service.createUpload(imageReq({ byteSize: 1024 }), {
        anonSessionId: "a1",
        ipKey: "203.0.113.9",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
    expect(charged).toEqual(["a:a1", "ip:203.0.113.9", "a:a1", "ip:203.0.113.9"])
  })

  it("meters a signed-in user on the account bucket ONLY (no IP bucket to share with strangers)", async () => {
    const charged: string[] = []
    const service = quotaService(
      {
        add: (subject, bytes) => {
          charged.push(subject)
          return Promise.resolve(bytes)
        },
      },
      2048,
    )
    await service.createUpload(imageReq({ byteSize: 1024 }), {
      userId: "u1",
      anonSessionId: "a1",
      ipKey: "203.0.113.9",
    })
    expect(charged).toEqual(["u:u1"])
  })
})
