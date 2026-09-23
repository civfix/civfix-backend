import { describe, it, expect } from "vitest"
import { FakeAbuseChecks } from "@civfix/shared/fakes"
import { releaseAnonHoldIfReady } from "../../src/services/anon-hold-release.js"
import { InMemoryAnonStore } from "../helpers/anon.js"

function harness() {
  const store = new InMemoryAnonStore()
  const abuse = new FakeAbuseChecks()
  const release = (reportId: string) =>
    releaseAnonHoldIfReady(reportId, { repo: store.holdReleaseRepo(), abuseChecks: abuse })
  return { store, abuse, release }
}

describe("releaseAnonHoldIfReady: publishes when ready + clean", () => {
  it("flips a held anon report to published once its single media is ready and clean", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })

    const res = await release(r.id)
    expect(res).toEqual({ outcome: "published", published: true })

    const updated = store.reports.get(r.id)!
    expect(updated.status).toBe("published")
    expect(updated.publishedAt).not.toBeNull()
    expect(store.timeline.some((t) => t.reportId === r.id && t.status === "published")).toBe(true)
  })

  it("publishes a media-less held report (nothing to validate)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    const res = await release(r.id)
    expect(res.outcome).toBe("published")
    expect(store.reports.get(r.id)!.status).toBe("published")
  })

  it("publishes when every one of several media is ready", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    store.seedMedia({ reportId: r.id, status: "ready" })
    const res = await release(r.id)
    expect(res.published).toBe(true)
  })
})

describe("releaseAnonHoldIfReady: stays held", () => {
  it("stays held when a media is HELD (nsfw)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    store.seedMedia({ reportId: r.id, status: "held" })
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "media_blocked", published: false })
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("stays held when a media is REJECTED", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "rejected" })
    const res = await release(r.id)
    expect(res.outcome).toBe("media_blocked")
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("stays held while a media is still validating (not done yet)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    store.seedMedia({ reportId: r.id, status: "validating" })
    const res = await release(r.id)
    expect(res.outcome).toBe("media_pending")
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("stays held when an OPEN abuse_flag exists for the report (dup)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    store.seedOpenFlag("report", r.id, "phash_dup")
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "flagged", published: false })
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("stays held when an OPEN abuse_flag exists for one of its media", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    const m = store.seedMedia({ reportId: r.id, status: "ready" })
    store.seedOpenFlag("media", m.id, "nsfw")
    const res = await release(r.id)
    expect(res.outcome).toBe("flagged")
  })

  it("stays held when the EXIF GPS cross-check is implausible (> ~50 km)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
      lat: 34.1,
      lng: -118.35,
    })
    store.seedMedia({ reportId: r.id, status: "ready", exifGeo: { lat: 37.77, lng: -122.42 } })
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "gps_implausible", published: false })
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("publishes when the EXIF GPS is consistent with the report point", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: null,
      anonSessionId: "anontok-1",
      publishedAt: null,
      lat: 34.1,
      lng: -118.35,
    })
    store.seedMedia({ reportId: r.id, status: "ready", exifGeo: { lat: 34.12, lng: -118.36 } })
    const res = await release(r.id)
    expect(res.published).toBe(true)
  })
})

describe("releaseAnonHoldIfReady: no-ops", () => {
  it("is a no-op for an already-published report", async () => {
    const { store, release } = harness()
    const r = store.seedReport({ status: "published", reporterUserId: null })
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "not_held", published: false })
  })

  it("is a no-op for a missing report", async () => {
    const { release } = harness()
    const res = await release("ghost")
    expect(res.outcome).toBe("not_held")
  })

  it("is a no-op for a soft-deleted held report", async () => {
    const { store, release } = harness()
    const r = store.seedReport({ status: "held", reporterUserId: null, deletedAt: new Date() })
    const res = await release(r.id)
    expect(res.outcome).toBe("not_held")
  })

  it("does NOT touch a held report that was never anonymous (no anon_session_id)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: "user-1",
      anonSessionId: null,
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "not_anon", published: false })
    expect(store.reports.get(r.id)!.status).toBe("held")
  })

  it("F059: releases a CLAIMED-but-still-held anon report (reporter set, anon_session_id preserved)", async () => {
    const { store, release } = harness()
    const r = store.seedReport({
      status: "held",
      reporterUserId: "user-1",
      anonSessionId: "anontok-1",
      publishedAt: null,
    })
    store.seedMedia({ reportId: r.id, status: "ready" })
    const res = await release(r.id)
    expect(res).toEqual({ outcome: "published", published: true })
    expect(store.reports.get(r.id)!.status).toBe("published")
  })
})
