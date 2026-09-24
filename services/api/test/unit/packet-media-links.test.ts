import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { AdminReportStatus, ReportVisibility } from "@civfix/shared"
import { InMemoryAdminReportRepository } from "../../src/services/admin/admin-report-repository.memory.js"
import type { AdminReportMediaRecord } from "../../src/services/admin/admin-report-types.js"
import { makeAdminReportService } from "../../src/services/admin/admin-report-service.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import {
  makePacketMediaPresigner,
  PACKET_MEDIA_URL_TTL_SEC,
} from "../../src/services/media-presign.js"

class RecordingStorage {
  readonly calls: { key: string; ttlSec: number; forceSigned: boolean }[] = []
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string> {
    const forceSigned = opts?.forceSigned === true
    this.calls.push({ key, ttlSec, forceSigned })
    return Promise.resolve(
      forceSigned ? `https://bucket.r2.test/${key}?X-Amz-Signature=sig` : `https://cdn.test/${key}`,
    )
  }
}

const ONE_PHOTO: AdminReportMediaRecord[] = [
  { id: "m1", kind: "image", r2Key: "processed/uploads/a", thumbKey: "processed/thumbs/a" },
]

async function routeWith(
  status: AdminReportStatus,
  visibility: ReportVisibility,
  media: AdminReportMediaRecord[] = ONE_PHOTO,
) {
  const storage = new RecordingStorage()
  const repo = new InMemoryAdminReportRepository()
  const mailer = new FakeMailer()
  const svc = makeAdminReportService({
    repo,
    outboundMail: makeOutboundMailService({
      repo: new InMemoryMailRepository(),
      mailer,
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    }),
    presignPacketMedia: makePacketMediaPresigner(storage),
  })
  repo.seedReport({
    id: "rep-1",
    status,
    visibility,
    routing: {
      geoid: "0644000",
      dept: "Public Works",
      place: "Los Angeles",
      contact: "311@lacity.gov",
      routed: false,
    },
    media,
  })
  await svc.routeToJurisdiction("rep-1", { note: null, actorId: "op-1" })
  const outbound = mailer.sent.find((m) => m.outbound !== undefined)?.outbound
  return { calls: storage.calls, text: outbound?.text ?? "" }
}

describe("packet photo links", () => {
  it("presigns week-long signed links unless the media is publicly visible", async () => {
    const storage = new RecordingStorage()
    const presign = makePacketMediaPresigner(storage)
    expect(await presign("k-public", true)).toBe("https://cdn.test/k-public")
    expect(await presign("k-private", false)).toContain("X-Amz-Signature")
    expect(storage.calls).toEqual([
      { key: "k-public", ttlSec: PACKET_MEDIA_URL_TTL_SEC, forceSigned: false },
      { key: "k-private", ttlSec: PACKET_MEDIA_URL_TTL_SEC, forceSigned: true },
    ])
  })

  it.each(["published", "acknowledged", "in_progress", "resolved"] as const)(
    "mails the public CDN link for a %s public report",
    async (status) => {
      const { calls, text } = await routeWith(status, "public")
      expect(calls).toEqual([
        { key: "processed/uploads/a", ttlSec: PACKET_MEDIA_URL_TTL_SEC, forceSigned: false },
      ])
      expect(text).toContain("https://cdn.test/processed/uploads/a")
      expect(text).not.toContain("X-Amz-Signature")
    },
  )

  it.each([
    ["submitted", "public"],
    ["held", "public"],
    ["published", "hidden"],
  ] as const)(
    "keeps signed links for a %s %s report, which the public cannot see",
    async (status, visibility) => {
      const { calls, text } = await routeWith(status, visibility)
      expect(calls).toEqual([
        { key: "processed/uploads/a", ttlSec: PACKET_MEDIA_URL_TTL_SEC, forceSigned: true },
      ])
      expect(text).not.toContain("https://cdn.test/")
    },
  )

  it("lists every photo and video in media order, numbered per kind", async () => {
    const { text } = await routeWith("published", "public", [
      { id: "m1", kind: "image", r2Key: "processed/uploads/a", thumbKey: null },
      { id: "m2", kind: "video", r2Key: "processed/uploads/v", thumbKey: null },
      { id: "m3", kind: "image", r2Key: "processed/uploads/b", thumbKey: null },
    ])
    expect(text).toContain(
      [
        "- Photo 1: https://cdn.test/processed/uploads/a",
        "- Video 1: https://cdn.test/processed/uploads/v",
        "- Photo 2: https://cdn.test/processed/uploads/b",
      ].join("\n"),
    )
  })
})
