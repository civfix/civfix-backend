import { randomUUID } from "node:crypto"
import { FakeMailer } from "@civfix/seams"
import type { OutboundEmail } from "@civfix/seams"
import { makeApplyCityUpdate } from "../../../src/services/filings/city-update-jobs.js"
import { makeFilingAdminService } from "../../../src/services/filings/filing-admin-service.js"
import {
  captureNotifications,
  type NotificationCapture,
  type Setting,
} from "../notification-capture.js"
import { fakeNotificationEmail } from "../notification-email.js"
import { flushNotificationDispatch } from "../notifications.js"
import { filingHarness, J_GEOID, PORTAL_HOST, PORTAL_URL } from "./filing-harness.js"
import { InMemoryFilingIngestSql } from "./filing-ingest-sql.memory.js"

export const REPORTER = "aaaaaaaa-0000-4000-8000-000000000001"
export const ADDRESS = "u@example.test"

/** The real notification service with email, for a reporter with a verified address at `setting`. */
export async function noticeCapture(setting: Setting, locale?: string) {
  const mailer = new FakeMailer()
  const n = captureNotifications(undefined, { email: { ...fakeNotificationEmail(), mailer } })
  n.repo.accounts.set(REPORTER, { email: ADDRESS, emailVerified: true, deletedAt: null })
  if (locale !== undefined) n.repo.locales.set(REPORTER, locale)
  await n.set(REPORTER, "reportUpdates", setting)
  const emails = (): OutboundEmail[] =>
    mailer.sent.flatMap((m) => (m.outbound !== undefined ? [m.outbound] : []))
  return { n, emails }
}

/** Lets the row's push and email finish, as they run after createNotification resolves. */
export async function settleNotices(): Promise<void> {
  for (let i = 0; i < 5; i++) await flushNotificationDispatch()
}

function notes(h: ReturnType<typeof filingHarness>, reportId: string) {
  return (h.reports.timeline.get(reportId) ?? []).map((t) => ({ note: t.note, kind: t.kind }))
}

/** A published report with its filing open in needs_human, recorded by hand. */
export async function manualFilingWorld(n: NotificationCapture) {
  const h = filingHarness({ notifications: n.service })
  const R = h.seed({ status: "published", reporterId: REPORTER })
  const F = await h.addFiling(
    R.record.id,
    { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
    { status: "needs_human", reason: "portal_error" },
  )
  const admin = makeFilingAdminService({
    filings: h.filings,
    reports: h.reports,
    jurisdictions: { jurisdictionExists: () => Promise.resolve(true) },
    filingService: h.svc,
    presignEvidence: () => Promise.reject(new Error("no evidence in these tests")),
    automaticFiling: false,
  })
  return {
    h,
    reportId: R.record.id,
    filingId: F.id,
    notes: () => notes(h, R.record.id),
    recordManual: () =>
      admin.recordManual(F.id, {
        actorId: "op-1",
        caseId: "1-555",
        caseUrl: null,
        note: null,
      }),
  }
}

/** A portal filing claimed for attempt 1 of the script worker, reporting its result. */
export async function portalRunWorld(n: NotificationCapture) {
  const h = filingHarness({ automatic: true, notifications: n.service })
  await h.filings.replaceRoutes(J_GEOID, [
    { category: null, channel: "portal", formUrl: PORTAL_URL },
  ])
  const R = h.seed({ status: "published", reporterId: REPORTER })
  const out = await h.svc.create({ reportId: R.record.id, actorId: "op-1" })
  if (out.kind !== "created") throw new Error("not created")
  const claim = await h.filings.claim(out.filing.id, 1)
  if (claim === null) throw new Error("not claimed")
  return {
    h,
    reportId: R.record.id,
    filingId: out.filing.id,
    notes: () => notes(h, R.record.id),
    submit: () =>
      h.svc.applyFilingResult({
        filingId: out.filing.id,
        runId: claim.runId,
        attempt: 1,
        outcome: "submitted",
        dryRun: false,
        evidence: [],
      }),
  }
}

/** An acknowledged report with a submitted portal filing, and the handler for a trusted message. */
export async function cityUpdateWorld(n: NotificationCapture) {
  const h = filingHarness({ notifications: n.service })
  const logged: unknown[][] = []
  const handle = makeApplyCityUpdate({
    ingest: new InMemoryFilingIngestSql(h.filings, h.reports),
    reports: h.reports,
    notifications: n.service,
    chatEmitter: h.emitter,
    logger: { warn: (...args: unknown[]) => void logged.push(args) },
  })
  await h.filings.replaceRoutes(J_GEOID, [
    {
      category: "graffiti",
      channel: "portal",
      formUrl: PORTAL_URL,
      statusSenderDomains: ["lacity.org"],
    },
  ])
  const R = h.seed({ status: "acknowledged", reporterId: REPORTER })
  const F = await h.addFiling(
    R.record.id,
    { channel: "portal", routeCategory: "graffiti", portalHost: PORTAL_HOST },
    { status: "submitted", method: "script", submittedAt: new Date(), caseId: null },
  )
  const message = await h.filings.insertMessageIfAbsent({
    filingId: F.id,
    inboundEmailId: randomUUID(),
    trusted: true,
  })
  if (message === null) throw new Error("no message row")
  return {
    h,
    reportId: R.record.id,
    filingId: F.id,
    logged,
    notes: () => notes(h, R.record.id),
    messageRow: () => h.filings.messages.find((m) => m.id === message.id)!,
    send: (status: "in_progress" | "closed") =>
      handle({
        filingMessageId: message.id,
        classification: { caseId: null, status, summary: "", confidence: 0.9 },
      }),
  }
}
