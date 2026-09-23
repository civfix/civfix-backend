import { describe, it, expect } from "vitest"
import { FakeJobs, FakeMailer } from "@civfix/shared/fakes"
import { InMemoryJurisdictionContactsRepository } from "../../src/services/admin/jurisdiction-contacts-repository.memory.js"
import { InMemoryMailRepository } from "../../src/services/admin/mail-repository.memory.js"
import { InMemoryOutreachRepository } from "../../src/services/admin/outreach-repository.memory.js"
import { makeOutboundMailService } from "../../src/services/admin/outbound-mail-service.js"
import { makeOutreachService } from "../../src/services/admin/outreach-service.js"
import type { OutreachStateRecord } from "../../src/services/admin/mail-repository.drizzle.js"
import {
  makeJurisdictionContactsService,
  coverageLabel,
  directoryMethod,
  directoryStatus,
  hasAnyContact,
  OUTREACH_DIGEST_JOB,
  type JurisdictionContactsService,
  type JurisdictionDirectoryRecord,
} from "../../src/services/admin/jurisdiction-contacts-service.js"

/**
 * Offline unit tests for the admin jurisdiction-contacts service over the in-memory repo + FakeJobs (no
 * DB, no Docker). They prove the "Save & route" core action (persist per-category contacts, set
 * contact_updated_at, resolve the discovery task, leave every report alone, enqueue throttled outreach),
 * the patch path (no routing), the directory projection (coverage / method / status), and the pure
 * helpers.
 */

const NOW = new Date("2026-06-06T00:00:00.000Z")
const THROTTLE_DAYS = 7

function harness(): {
  repo: InMemoryJurisdictionContactsRepository
  jobs: FakeJobs
  svc: JurisdictionContactsService
} {
  const repo = new InMemoryJurisdictionContactsRepository()
  repo.now = NOW
  const jobs = new FakeJobs()
  const svc = makeJurisdictionContactsService({
    repo,
    jobs,
    throttleDays: THROTTLE_DAYS,
    outreachDigestEnabled: true,
    now: () => NOW,
  })
  return { repo, jobs, svc }
}

/** Build a directory record with overridable fields (for the pure-helper tests). */
function record(over: Partial<JurisdictionDirectoryRecord> = {}): JurisdictionDirectoryRecord {
  return {
    geoid: "1",
    name: "City",
    layer: "place",
    population: null,
    defaultEmails: [],
    categoryContacts: [],
    hasDefaultContact: false,
    reportFormUrl: null,
    reportsWaiting: 0,
    perCategoryCounts: {},
    oldestReportAt: null,
    lastRoutedAt: null,
    bounced: false,
    contactUpdatedAt: null,
    flaggedAt: null,
    handle: null,
    forwardSubjectTemplate: null,
    forwardBodyTemplate: null,
    ...over,
  }
}

describe("contacts pure helpers", () => {
  it("hasAnyContact is true when any field is filled", () => {
    expect(hasAnyContact({ contacts: {}, defaultEmails: [], formUrl: null })).toBe(false)
    expect(
      hasAnyContact({ contacts: { trash: "a@b.gov" }, defaultEmails: [], formUrl: null }),
    ).toBe(true)
    expect(hasAnyContact({ contacts: {}, defaultEmails: ["a@b.gov"], formUrl: null })).toBe(true)
    expect(hasAnyContact({ contacts: {}, defaultEmails: [], formUrl: "https://x.gov" })).toBe(true)
  })

  it("coverageLabel reflects the contact posture", () => {
    expect(coverageLabel(record())).toBe("No routing")
    expect(coverageLabel(record({ defaultEmails: ["a@b.gov"] }))).toBe("All categories")
    expect(coverageLabel(record({ hasDefaultContact: true }))).toBe("All categories")
    expect(
      coverageLabel(
        record({
          categoryContacts: [
            { category: "trash", email: "t@b.gov" },
            { category: "hazard", email: "h@b.gov" },
          ],
        }),
      ),
    ).toBe("Trash, Hazard")
  })

  it("directoryMethod prefers email, then form, then none", () => {
    expect(directoryMethod(record())).toBe("none")
    expect(directoryMethod(record({ reportFormUrl: "https://x.gov" }))).toBe("form")
    expect(directoryMethod(record({ defaultEmails: ["a@b.gov"] }))).toBe("email")
  })

  it("directoryStatus: bounced > verified (saved) > pending", () => {
    expect(directoryStatus(record())).toBe("pending")
    expect(directoryStatus(record({ defaultEmails: ["a@b.gov"], contactUpdatedAt: NOW }))).toBe(
      "verified",
    )
    expect(directoryStatus(record({ bounced: true, defaultEmails: ["a@b.gov"] }))).toBe("bounced")
  })
})

describe("saveAndRoute", () => {
  it("persists per-category contacts, sets contact_updated_at, resolves the task, touches no report, enqueues outreach", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })
    repo.seedTask({ id: "JUR-1", geoid: "0644000", status: "open" })
    // Two waiting reports + one already-resolved; none of them may change.
    repo.seedReport({ id: "r1", geoid: "0644000", category: "trash", status: "submitted" })
    repo.seedReport({ id: "r2", geoid: "0644000", category: "hazard", status: "published" })
    repo.seedReport({ id: "r3", geoid: "0644000", category: "trash", status: "resolved" })

    const result = await svc.saveAndRoute(
      "0644000",
      {
        contacts: { trash: "trash@lacity.gov" },
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
        forwardSubjectTemplate: "Report {title}",
        forwardBodyTemplate: "Please review {description}",
      },
      "op-1",
    )

    // (a) per-category contact persisted.
    const j = repo.jurisdictions.get("0644000")!
    expect(j.categoryContacts.get("trash")).toBe("trash@lacity.gov")
    expect(j.defaultEmails).toEqual(["311@lacity.gov"])
    expect(j.forwardSubjectTemplate).toBe("Report {title}")
    expect(j.forwardBodyTemplate).toBe("Please review {description}")
    // (b) contact_updated_at set.
    expect(j.contactUpdatedAt).toEqual(NOW)
    // (c) discovery task resolved.
    expect(repo.tasks.find((t) => t.id === "JUR-1")?.status).toBe("done")
    expect(result.taskResolved).toBe(true)
    // (d) NO report is touched: saving a contact mails nobody, so nothing is marked routed.
    expect(repo.reports.find((r) => r.id === "r1")?.status).toBe("submitted")
    expect(repo.reports.find((r) => r.id === "r2")?.status).toBe("published")
    expect(repo.reports.find((r) => r.id === "r3")?.status).toBe("resolved")
    // (e) outreach enqueued (singletonKey=geoid).
    const enqueued = jobs.jobsFor(OUTREACH_DIGEST_JOB)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.data).toMatchObject({ geoid: "0644000" })
    expect(enqueued[0]?.opts?.singletonKey).toBe("0644000")
    expect(result.outreachEnqueued).toBe(true)
    // (f) H4: the save was audited IN the repo (atomic with the routing), recorded on the audit sink.
    expect(repo.audits.at(-1)).toMatchObject({
      actorId: "op-1",
      action: "discovery.contacts_saved",
      target: "jurisdiction:0644000",
      meta: { taskResolved: true },
    })
  })

  it("enqueues NO outreach digest when OUTREACH_DIGEST_ENABLED is off", async () => {
    const repo = new InMemoryJurisdictionContactsRepository()
    repo.now = NOW
    const jobs = new FakeJobs()
    const svc = makeJurisdictionContactsService({
      repo,
      jobs,
      throttleDays: THROTTLE_DAYS,
      outreachDigestEnabled: false,
      now: () => NOW,
    })
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })

    const result = await svc.saveAndRoute(
      "0644000",
      { contacts: { trash: "trash@lacity.gov" }, defaultEmails: [], formUrl: null },
      "op-1",
    )

    expect(result.outreachEnqueued).toBe(false)
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(0)
    expect(repo.jurisdictions.get("0644000")?.categoryContacts.get("trash")).toBe(
      "trash@lacity.gov",
    )
  })

  it("rejects when no contact is provided (nothing to route)", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })
    await expect(
      svc.saveAndRoute("1", { contacts: {}, defaultEmails: [], formUrl: null }, "op-1"),
    ).rejects.toMatchObject({ httpStatus: 422 })
  })

  it("throws notFound for an unknown jurisdiction", async () => {
    const { svc } = harness()
    await expect(
      svc.saveAndRoute(
        "nope",
        { contacts: { trash: "a@b.gov" }, defaultEmails: [], formUrl: null },
        "op-1",
      ),
    ).rejects.toMatchObject({ httpStatus: 404 })
  })

  it("does NOT enqueue outreach inside the throttle window", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })
    // Last outreach 2 days ago, throttle is 7 days -> suppressed.
    repo.seedOutreach("1", { lastOutreachAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000) })

    const result = await svc.saveAndRoute(
      "1",
      {
        contacts: { trash: "a@b.gov" },
        defaultEmails: [],
        formUrl: null,
      },
      "op-1",
    )
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(0)
    expect(result.outreachEnqueued).toBe(false)
  })

  it("does NOT enqueue outreach when suppressed", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })
    repo.seedOutreach("1", { suppressed: true })
    await svc.saveAndRoute(
      "1",
      { contacts: { trash: "a@b.gov" }, defaultEmails: [], formUrl: null },
      "op-1",
    )
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(0)
  })

  it("enqueues outreach again past the throttle window", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })
    repo.seedOutreach("1", { lastOutreachAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) })
    await svc.saveAndRoute(
      "1",
      { contacts: { trash: "a@b.gov" }, defaultEmails: [], formUrl: null },
      "op-1",
    )
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(1)
  })

  // C1 regression: save-and-route on a freshly-onboarded jurisdiction (no prior outreach state) MUST
  // enqueue the immediate digest. Before the fix the Drizzle saveAndRoute pre-stamped
  // outreach_state.last_outreach_at = now(), so maybeEnqueueOutreach (and the worker) read a just-set
  // timestamp and ALWAYS throttled -> the first digest could never go out on save. The in-memory repo hid
  // this by omitting the stamp (C2). This asserts the enqueue fires on a never-contacted geoid.
  it("C1: save-and-route on a never-contacted jurisdiction ENQUEUES the immediate digest (not throttled-by-construction)", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })
    repo.seedReport({ id: "r1", geoid: "0644000", category: "trash", status: "submitted" })

    const result = await svc.saveAndRoute(
      "0644000",
      {
        contacts: { trash: "trash@lacity.gov" },
        defaultEmails: [],
        formUrl: null,
      },
      "op-1",
    )

    // The save did NOT stamp the send window, so the enqueue fires.
    expect(result.outreachEnqueued).toBe(true)
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(1)
    // And no outreach_state row was written by the save itself (only a SEND stamps it).
    expect(repo.outreach.get("0644000")).toBeUndefined()
  })
})

/**
 * C1 + C2 end-to-end: the full discovery outreach loop over a SINGLE shared outreach_state, exactly as
 * production wires it (one outreach_state table read by both the save-and-route enqueue throttle and the
 * worker's runForGeoid). This is the test the review demands: it FAILS if the immediate-outreach path is
 * throttled-by-construction (a save that does not enqueue, or a worker run that does not send), AND it
 * proves a same-window SECOND save is throttled because the worker's send stamped the window for real.
 */
describe("C1/C2: save -> enqueue -> worker send -> stamp -> second save throttled (shared outreach_state)", () => {
  it("first save sends a digest and stamps the window; the same-window second save is throttled", async () => {
    // ONE outreach_state store shared by the contacts repo (enqueue throttle) + the mail repo (send stamp).
    const sharedOutreach = new Map<string, OutreachStateRecord>()
    const contactsRepo = new InMemoryJurisdictionContactsRepository(sharedOutreach)
    contactsRepo.now = NOW
    const jobs = new FakeJobs()
    const contactsSvc = makeJurisdictionContactsService({
      repo: contactsRepo,
      jobs,
      throttleDays: THROTTLE_DAYS,
      outreachDigestEnabled: true,
      now: () => NOW,
    })

    // The worker side: the outreach read repo + the mail repo (sharing the SAME outreach store) + a
    // FakeMailer-backed OutboundMailService, assembled into the OutreachService the worker drains.
    const outreachRepo = new InMemoryOutreachRepository()
    const mailRepo = new InMemoryMailRepository(sharedOutreach)
    const mailer = new FakeMailer()
    const outboundMail = makeOutboundMailService({
      repo: mailRepo,
      mailer,
      env: { MAIL_FROM_OUTREACH: "outreach@civfix.org", MAIL_REPLY_DOMAIN: "civfix.org" },
    })
    const outreachSvc = makeOutreachService({
      outreachRepo,
      mailRepo,
      outboundMail,
      throttleDays: THROTTLE_DAYS,
      now: () => NOW,
    })

    // Arrange the same jurisdiction + waiting report on BOTH read seams (contacts repo for save-and-route,
    // outreach repo for the digest aggregation), with the routing contact the digest will resolve.
    contactsRepo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })
    contactsRepo.seedReport({ id: "r1", geoid: "0644000", category: "trash", status: "submitted" })
    outreachRepo.seedJurisdiction({
      geoid: "0644000",
      org: "Los Angeles",
      defaultEmail: "311@lacity.gov",
    })
    outreachRepo.seedReport({ geoid: "0644000", category: "trash" })

    // 1) Save & route: persists the contact + enqueues the immediate (throttled) outreach.
    const save1 = await contactsSvc.saveAndRoute(
      "0644000",
      {
        contacts: { trash: "311@lacity.gov" },
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
      },
      "op-1",
    )
    expect(save1.outreachEnqueued).toBe(true)
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(1)

    // 2) The worker drains that enqueue (runForGeoid is exactly what the job dispatches to for {geoid}).
    const run = await outreachSvc.runForGeoid("0644000")
    expect(run.sent).toBe(true) // <- fails if the path were throttled-by-construction
    expect(run.reportCount).toBe(1)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]?.to).toBe("311@lacity.gov")

    // The SEND stamped the shared window to NOW (this is the only place last_outreach_at is set now).
    expect(sharedOutreach.get("0644000")?.lastOutreachAt?.getTime()).toBe(NOW.getTime())

    // 3) A same-window SECOND save must NOT enqueue (the send already stamped the window) - and even if it
    // somehow did, the worker would re-skip. This proves the throttle is real, not load-bearing on a
    // save-time pre-stamp.
    const save2 = await contactsSvc.saveAndRoute(
      "0644000",
      {
        contacts: { trash: "311@lacity.gov" },
        defaultEmails: ["311@lacity.gov"],
        formUrl: null,
      },
      "op-1",
    )
    expect(save2.outreachEnqueued).toBe(false)
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(1) // still just the first enqueue

    // Defense in depth: even a forced worker re-run inside the window is a no-op (throttled, no 2nd mail).
    const rerun = await outreachSvc.runForGeoid("0644000")
    expect(rerun.sent).toBe(false)
    expect(rerun.skipped).toBe("throttled")
    expect(mailer.sent).toHaveLength(1)
  })
})

describe("patch", () => {
  it("updates contacts + notes WITHOUT routing or resolving the task", async () => {
    const { repo, jobs, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })
    repo.seedTask({ id: "JUR-1", geoid: "1", status: "open" })
    repo.seedReport({ id: "r1", geoid: "1", category: "trash", status: "submitted" })

    await svc.patch("1", { contacts: { trash: "t@city.gov" }, notes: "Prefers email" }, "op-1")

    const j = repo.jurisdictions.get("1")!
    expect(j.categoryContacts.get("trash")).toBe("t@city.gov")
    expect(j.notes).toBe("Prefers email")
    expect(j.contactUpdatedAt).toEqual(NOW)
    // Patch does not route or resolve.
    expect(repo.reports.find((r) => r.id === "r1")?.status).toBe("submitted")
    expect(repo.tasks.find((t) => t.id === "JUR-1")?.status).toBe("open")
    expect(jobs.jobsFor(OUTREACH_DIGEST_JOB)).toHaveLength(0)
    // H4: the patch was audited in the repo (atomic), recorded on the audit sink.
    expect(repo.audits.at(-1)).toMatchObject({
      actorId: "op-1",
      action: "jurisdiction.patched",
      target: "jurisdiction:1",
    })
  })

  it("throws notFound for an unknown jurisdiction", async () => {
    const { svc } = harness()
    await expect(svc.patch("nope", { notes: "x" }, "op-1")).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it("sets the discussion @handle and surfaces it on the directory row", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })

    await svc.patch("1", { handle: "sf" }, "op-1")

    expect(repo.jurisdictions.get("1")!.handle).toBe("sf")
    const row = (await svc.listDirectory({})).items.find((i) => i.geoid === "1")!
    expect(row.handle).toBe("sf")
  })

  it("clears the @handle when given an empty string", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City", handle: "sf" })

    await svc.patch("1", { handle: "" }, "op-1")

    expect(repo.jurisdictions.get("1")!.handle).toBeNull()
  })

  it("rejects a reserved @handle (422) and leaves the handle unchanged", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })

    await expect(svc.patch("1", { handle: "admin" }, "op-1")).rejects.toMatchObject({
      httpStatus: 422,
    })
    expect(repo.jurisdictions.get("1")!.handle).toBeNull()
  })

  it("rejects a @handle already used (case-insensitively) by another jurisdiction (409)", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City One", handle: "sf" })
    repo.seedJurisdiction({ geoid: "2", name: "City Two" })

    await expect(svc.patch("2", { handle: "SF" }, "op-1")).rejects.toMatchObject({
      httpStatus: 409,
    })
    expect(repo.jurisdictions.get("2")!.handle).toBeNull()
  })
})

describe("listDirectory", () => {
  it("projects directory rows with method/status/coverage and filters by method", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({
      geoid: "1",
      name: "Email City",
      defaultEmails: ["311@city.gov"],
      contactUpdatedAt: NOW,
    })
    repo.seedJurisdiction({
      geoid: "2",
      name: "Form Town",
      reportFormUrl: "https://town.gov/report",
    })
    repo.seedJurisdiction({ geoid: "3", name: "Unmapped Village" })

    const all = await svc.listDirectory({})
    expect(all.items).toHaveLength(3)
    const emailRow = all.items.find((i) => i.geoid === "1")!
    expect(emailRow.org).toBe("Email City")
    expect(emailRow.method).toBe("email")
    expect(emailRow.status).toBe("verified")
    expect(emailRow.email).toBe("311@city.gov")
    expect(emailRow.coverage).toBe("All categories")

    const formOnly = await svc.listDirectory({ filter: "form" })
    expect(formOnly.items.map((i) => i.geoid)).toEqual(["2"])

    const noneOnly = await svc.listDirectory({ filter: "none" })
    expect(noneOnly.items.map((i) => i.geoid)).toEqual(["3"])
  })

  it("surfaces a synthetic 'Unmapped' row for waiting reports whose jurisdiction did not resolve", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "Mapped City", defaultEmails: ["311@city.gov"] })
    // Reports whose geoid is NOT a seeded jurisdiction (unresolved/orphaned) and still waiting.
    repo.seedReport({ geoid: "ZZZ-unknown", category: "trash", status: "published" })
    repo.seedReport({ geoid: "ZZZ-unknown", category: "hazard", status: "submitted" })
    // A resolved orphan must NOT count (not waiting); a mapped report must NOT leak into the bucket.
    repo.seedReport({ geoid: "ZZZ-unknown", category: "water", status: "resolved" })
    repo.seedReport({ geoid: "1", category: "trash", status: "published" })

    const all = await svc.listDirectory({})
    const unmapped = all.items.find((i) => i.geoid === "__unmapped__")!
    expect(unmapped).toBeDefined()
    expect(unmapped.org).toBe("Unmapped / Unknown jurisdiction")
    expect(unmapped.reportsWaiting).toBe(2) // the published + submitted orphans; resolved excluded
    expect(unmapped.perCategoryCounts).toEqual({ trash: 1, hazard: 1 })
    expect(unmapped.method).toBe("none")
    // It pins to the top of the first page.
    expect(all.items[0]!.geoid).toBe("__unmapped__")
    // It appears under the "none" facet (no contacts) but never under email/form.
    expect(
      (await svc.listDirectory({ filter: "none" })).items.some((i) => i.geoid === "__unmapped__"),
    ).toBe(true)
    expect(
      (await svc.listDirectory({ filter: "email" })).items.some((i) => i.geoid === "__unmapped__"),
    ).toBe(false)
  })

  it("suppresses the 'Unmapped' row when every report resolves to a known jurisdiction", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "Mapped City" })
    repo.seedReport({ geoid: "1", category: "trash", status: "published" })

    const all = await svc.listDirectory({})
    expect(all.items.some((i) => i.geoid === "__unmapped__")).toBe(false)
  })

  it("surfaces the jurisdiction TYPE, population, waiting counts, contacts, and flag state", async () => {
    const { repo, svc } = harness()
    // A FEDERAL-land jurisdiction with an existing trash contact, a flag, and a mix of reports.
    repo.seedJurisdiction({
      geoid: "FED-ANF",
      name: "Angeles National Forest",
      layer: "federal",
      population: 12345,
      categoryContacts: { trash: "info@fs.usda.gov" },
      flaggedAt: NOW,
      flagReason: "boundary dispute",
    })
    repo.seedReport({ geoid: "FED-ANF", category: "trash", status: "submitted" })
    repo.seedReport({ geoid: "FED-ANF", category: "trash", status: "held" })
    repo.seedReport({ geoid: "FED-ANF", category: "hazard", status: "published" })
    // An already-routed report must NOT be counted as waiting.
    repo.seedReport({ geoid: "FED-ANF", category: "trash", status: "acknowledged" })

    const row = (await svc.listDirectory({})).items.find((i) => i.geoid === "FED-ANF")!
    expect(row.layer).toBe("federal")
    expect(row.population).toBe(12345)
    expect(row.reportsWaiting).toBe(3) // 2 trash + 1 hazard; the acknowledged one is excluded
    expect(row.perCategoryCounts).toEqual({ trash: 2, hazard: 1 })
    expect(row.contacts).toContainEqual({ category: "trash", email: "info@fs.usda.gov" })
    expect(row.flaggedAt).not.toBeNull()
  })

  it("flag / unflag a jurisdiction via patch sets then clears flaggedAt (no routing)", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "1", name: "City" })

    await svc.patch("1", { flagged: true, flagReason: "needs review" }, "op-1")
    let row = (await svc.listDirectory({})).items.find((i) => i.geoid === "1")!
    expect(row.flaggedAt).not.toBeNull()

    await svc.patch("1", { flagged: false }, "op-1")
    row = (await svc.listDirectory({})).items.find((i) => i.geoid === "1")!
    expect(row.flaggedAt).toBeNull()
  })

  it("filters by jurisdiction TYPE (layer) and scopes total/facets to it", async () => {
    const { repo, svc } = harness()
    // A routed state, an unrouted county, and two cities (one routed, one not).
    repo.seedJurisdiction({
      geoid: "06",
      name: "California",
      layer: "state",
      defaultEmails: ["gov@ca.gov"],
    })
    repo.seedJurisdiction({ geoid: "06037", name: "Los Angeles County", layer: "county" })
    repo.seedJurisdiction({
      geoid: "0644000",
      name: "Los Angeles",
      layer: "place",
      defaultEmails: ["311@lacity.gov"],
    })
    repo.seedJurisdiction({ geoid: "0666000", name: "San Diego", layer: "place" })

    // Cities only: the two places, and total/facets count within the type (1 routed, 1 unrouted).
    const cities = await svc.listDirectory({ layer: "place" })
    expect(cities.items.map((i) => i.geoid).sort()).toEqual(["0644000", "0666000"])
    expect(cities.total).toBe(2)
    expect(cities.facets).toEqual({ routed: 1, unrouted: 1 })

    // The type filter combines with the routing-posture filter (unrouted cities only -> San Diego).
    const unroutedCities = await svc.listDirectory({ layer: "place", filter: "none" })
    expect(unroutedCities.items.map((i) => i.geoid)).toEqual(["0666000"])

    // Other single-type selections resolve to their one match.
    expect((await svc.listDirectory({ layer: "state" })).items.map((i) => i.geoid)).toEqual(["06"])
    expect((await svc.listDirectory({ layer: "county" })).items.map((i) => i.geoid)).toEqual([
      "06037",
    ])
  })

  it("scopes the total to the needs_mapping filter", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "waiting", name: "Waiting" })
    repo.seedJurisdiction({ geoid: "empty", name: "Empty" })
    repo.seedJurisdiction({ geoid: "routed", name: "Routed", defaultEmails: ["311@city.gov"] })
    repo.seedReport({ geoid: "waiting", category: "trash", status: "submitted" })
    repo.seedReport({ geoid: "routed", category: "trash", status: "submitted" })

    const result = await svc.listDirectory({ filter: "needs_mapping" })

    expect(result.items.map((i) => i.geoid)).toEqual(["waiting"])
    expect(result.total).toBe(1)
  })

  it("suppresses the synthetic 'Unmapped' row under a type filter (it has no jurisdiction type)", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles", layer: "place" })
    // An orphaned waiting report would surface the unmapped row under "all", but never under a layer filter.
    repo.seedReport({ geoid: "ZZZ-unknown", category: "trash", status: "submitted" })

    expect((await svc.listDirectory({})).items.some((i) => i.geoid === "__unmapped__")).toBe(true)
    expect(
      (await svc.listDirectory({ layer: "place" })).items.some((i) => i.geoid === "__unmapped__"),
    ).toBe(false)
  })

  it("searches org/geoid and paginates", async () => {
    const { repo, svc } = harness()
    repo.seedJurisdiction({ geoid: "0644000", name: "Los Angeles" })
    repo.seedJurisdiction({ geoid: "0666000", name: "San Diego" })

    expect((await svc.listDirectory({ q: "angeles" })).items.map((i) => i.geoid)).toEqual([
      "0644000",
    ])

    const first = await svc.listDirectory({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = await svc.listDirectory({ limit: 1, cursor: first.nextCursor ?? undefined })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.geoid).not.toBe(first.items[0]?.geoid)
  })
})
