import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import type { FastifyRequest } from "fastify"
import type { FakeStorage } from "@civfix/shared/fakes"
import { signAnonToken } from "../../src/abuse/anon-token.js"
import { resolveAuthContext } from "../../src/auth/context.js"
import type { Sql } from "../../src/db/client.js"
import { quotaSubjects } from "../../src/services/media-intake-service.js"
import { anonUploader, uploaderOf, userUploader } from "../../src/services/media-uploader.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { bearer, makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { InMemoryMediaRepository } from "../helpers/media.js"

const GUEST_TOKEN_ID = "77777777-7777-4777-8777-777777777777"
const REPORT_CLAIM = /UPDATE media_assets\s+SET report_id/
const UPLOAD_REQUEST = {
  kind: "image",
  contentType: "image/jpeg",
  byteSize: 1024,
  sha256: "d".repeat(64),
}

function anonCookie(h: AuthHarness): Record<string, string> {
  const signed = signAnonToken(GUEST_TOKEN_ID, h.env.ANON_TOKEN_SIGNING_KEY)
  return { cookie: `civfix_anon=${encodeURIComponent(signed)}` }
}

function reportRow(values: unknown[]): Record<string, unknown> {
  return {
    id: values[0],
    reporter_user_id: null,
    anon_session_id: null,
    category: "trash",
    type: "dump",
    title: null,
    description: null,
    addr: null,
    addr_source: null,
    addr_precision: null,
    status: "published",
    visibility: "public",
    lng: -118.25,
    lat: 34.05,
    geom_source: "device",
    jurisdiction_geoid: null,
    reference_code: "DUMP-1",
    created_at: new Date(),
    published_at: new Date(),
    deleted_at: null,
  }
}

async function harness() {
  const mediaRepo = new InMemoryMediaRepository()
  // The claim answers only for uploads whose recorded uploader is among the subjects the request bound,
  // which is what the real predicate decides.
  const fake = makeFakeSql([
    { match: /reference_counters/i, rows: [{ next_val: 1 }] },
    {
      match: REPORT_CLAIM,
      rows: (values) =>
        [...mediaRepo.byId.values()]
          .filter((m) => values.includes(m.uploadId) && values.includes(m.uploader))
          .map((m) => ({ upload_id: m.uploadId })),
    },
    { match: /FROM reports WHERE id =/, rows: (values) => [reportRow(values)] },
  ])
  const h = await makeAuthHarness({
    server: {
      mediaRepo,
      reportOverrides: { repo: makeDrizzleReportRepository(fake.sql as unknown as Sql) },
    },
  })
  return { h, mediaRepo }
}

async function guestUpload(h: AuthHarness, mediaRepo: InMemoryMediaRepository): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/media/upload",
    headers: anonCookie(h),
    payload: UPLOAD_REQUEST,
  })
  expect(res.statusCode).toBe(200)
  const { uploadId } = res.json() as { uploadId: string }
  const asset = (await mediaRepo.findByUploadId(uploadId))!
  expect(asset.uploader).toBe(anonUploader(GUEST_TOKEN_ID))
  await (h.container.storage as FakeStorage).put(
    asset.r2Key,
    new Uint8Array(UPLOAD_REQUEST.byteSize),
    { contentType: UPLOAD_REQUEST.contentType },
  )
  return uploadId
}

function fileReport(h: AuthHarness, headers: Record<string, string>, uploadId: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/reports",
    headers,
    payload: {
      idempotencyKey: randomUUID(),
      category: "trash",
      type: "dump",
      lat: 34.05,
      lng: -118.25,
      geomSource: "device",
      mediaUploadIds: [uploadId],
    },
  })
}

describe("a guest's upload once the same browser signs in", () => {
  let h: AuthHarness | undefined
  afterEach(async () => {
    await h?.app.close()
    h = undefined
  })

  it("finalizes and files a report with the upload it made as a guest", async () => {
    const built = await harness()
    h = built.h
    const uploadId = await guestUpload(h, built.mediaRepo)
    const { token } = await h.signIn("guest-turned-member@example.org")
    const sameBrowser = { ...bearer(token), ...anonCookie(h) }

    const finalized = await h.app.inject({
      method: "POST",
      url: `/v1/media/${uploadId}/finalize`,
      headers: sameBrowser,
    })
    expect(finalized.statusCode).toBe(200)

    const filed = await fileReport(h, sameBrowser, uploadId)
    expect(filed.statusCode).toBe(201)
  })

  it("refuses another signed-in account that does not carry the guest's cookie", async () => {
    const built = await harness()
    h = built.h
    const uploadId = await guestUpload(h, built.mediaRepo)
    const { token } = await h.signIn("someone-else@example.org")

    const finalized = await h.app.inject({
      method: "POST",
      url: `/v1/media/${uploadId}/finalize`,
      headers: bearer(token),
    })
    expect(finalized.statusCode).toBe(404)

    const filed = await fileReport(h, bearer(token), uploadId)
    expect(filed.statusCode).toBe(422)
  })
})

describe("the request context of a signed-in browser that still carries its guest cookie", () => {
  let h: AuthHarness | undefined
  afterEach(async () => {
    await h?.app.close()
    h = undefined
  })

  function contextFor(token: string) {
    const signed = signAnonToken(GUEST_TOKEN_ID, h!.env.ANON_TOKEN_SIGNING_KEY)
    const request = {
      server: h!.app,
      headers: bearer(token),
      cookies: { civfix_anon: signed },
    } as unknown as FastifyRequest
    return resolveAuthContext(request)
  }

  it("keeps the guest id apart from the anonymous subject, so only upload ownership sees it", async () => {
    h = await makeAuthHarness()
    const { token, userId } = await h.signIn("member@example.org")

    const context = await contextFor(token)

    expect(context).toMatchObject({ userId, anon: false, guestAnonSessionId: GUEST_TOKEN_ID })
    expect(context.anonSessionId).toBeUndefined()
  })

  it("still stores and charges a new upload to the account alone", () => {
    const owner = { userId: "member-1", guestAnonSessionId: GUEST_TOKEN_ID, ipKey: "203.0.113.9" }

    expect(uploaderOf(owner)).toBe(userUploader("member-1"))
    expect(quotaSubjects(owner)).toEqual([userUploader("member-1")])
  })
})
