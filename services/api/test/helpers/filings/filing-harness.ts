import { FakeJobs } from "@civfix/seams"
import type { AdminReportStatus, ReportCategory, ReportVisibility } from "@civfix/contract"
import {
  InMemoryAdminReportRepository,
  type SeededReport,
} from "../admin/admin-report-repository.memory.js"
import { RecordingNotifier } from "../notifications.js"
import { InMemoryFilingRepository, type MemoryReport } from "./filing-repository.memory.js"
import {
  makeFilingService,
  type FilingService,
} from "../../../src/services/filings/filing-service.js"
import type { CreateFilingInput, FilingRecord } from "../../../src/services/filings/filing-types.js"
import type { ReportTimelineEvent } from "../../../src/services/report-timeline-event.js"

export const J_GEOID = "0644000"
export const J_NAME = "Los Angeles"
export const J_CONTACT = "311@lacity.gov"
export const WEB_BASE = "https://civfix.test"
export const PORTAL_URL = "https://myla311.lacity.gov/s/"
export const PORTAL_HOST = "myla311.lacity.gov"

export class RecordingChatEmitter {
  readonly events: ReportTimelineEvent[] = []
  emit(event: ReportTimelineEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

export interface SeedInput {
  id?: string
  category?: ReportCategory
  status?: AdminReportStatus
  visibility?: ReportVisibility
  title?: string
  desc?: string
  referenceCode?: string | null
  verificationVerdict?: "approved" | "rejected" | null
  /** The report's jurisdiction; null for a report outside every jurisdiction. Defaults to J. */
  geoid?: string | null
  contact?: string | null
  reporterId?: string | null
}

export interface FilingHarness {
  reports: InMemoryAdminReportRepository
  filings: InMemoryFilingRepository
  jobs: FakeJobs
  notifier: RecordingNotifier
  emitter: RecordingChatEmitter
  warnings: unknown[][]
  clock: { now: Date }
  svc: FilingService
  seed(input?: SeedInput): SeededReport
  /** A filing row written straight into the twin, then moved to `patch`'s fields. */
  addFiling(
    reportId: string,
    input: Partial<CreateFilingInput>,
    patch?: Partial<FilingRecord>,
  ): Promise<FilingRecord>
}

/**
 * The filing service over the two memory twins it reads: the admin report repository (reports, routing)
 * and the filing repository, whose report rows here are live views of the admin ones, so a success the
 * filing twin records moves the same report the admin twin serves.
 */
export function filingHarness(opts: { automatic?: boolean; now?: Date } = {}): FilingHarness {
  const reports = new InMemoryAdminReportRepository()
  const filings = new InMemoryFilingRepository()
  filings.jurisdictions.set(J_GEOID, J_NAME)
  const jobs = new FakeJobs()
  const notifier = new RecordingNotifier()
  const emitter = new RecordingChatEmitter()
  const warnings: unknown[][] = []
  const clock = { now: opts.now ?? new Date() }
  const svc = makeFilingService({
    filings,
    reports,
    jobs,
    automaticFiling: opts.automatic ?? false,
    webBaseUrl: WEB_BASE,
    reportChatEmitter: emitter,
    notifications: notifier,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
    now: () => clock.now,
  })

  function seed(input: SeedInput = {}): SeededReport {
    const geoid = input.geoid === undefined ? J_GEOID : input.geoid
    const contact = input.contact ?? null
    const seeded = reports.seedReport({
      ...(input.id !== undefined ? { id: input.id } : {}),
      category: input.category ?? "graffiti",
      status: input.status ?? "published",
      visibility: input.visibility ?? "public",
      title: input.title ?? "Pothole",
      desc: input.desc ?? "",
      referenceCode: input.referenceCode ?? null,
      verificationVerdict: input.verificationVerdict ?? null,
      reporter:
        input.reporterId === null
          ? null
          : {
              id: input.reporterId ?? "u-reporter",
              name: "Sam",
              handle: "sam",
              emailVerified: true,
              hasOauth: false,
              joinedAt: null,
            },
      routing: {
        geoid,
        dept: geoid === null ? "" : J_NAME,
        place: geoid === null ? "" : J_NAME,
        contact,
        routed: contact !== null,
      },
    })
    const view: MemoryReport = {
      id: seeded.record.id,
      get geoid() {
        return geoid
      },
      get status() {
        return seeded.record.status
      },
      set status(next: string) {
        seeded.record.status = next as AdminReportStatus
      },
      get title() {
        return seeded.record.title
      },
      get referenceCode() {
        return seeded.record.referenceCode
      },
      get deletedAt() {
        return seeded.deletedAt
      },
      get verificationVerdict() {
        return seeded.record.verificationVerdict
      },
    }
    filings.reports.set(seeded.record.id, view)
    return seeded
  }

  async function addFiling(
    reportId: string,
    input: Partial<CreateFilingInput>,
    patch: Partial<FilingRecord> = {},
  ): Promise<FilingRecord> {
    const created = await filings.create({
      reportId,
      geoid: J_GEOID,
      category: "graffiti",
      ticketText: "Pothole",
      status: "cancelled",
      ...input,
    })
    if (created.kind !== "created") throw new Error("addFiling: an active filing already exists")
    const { jurisdictionName: _name, ...stored } = { ...created.filing, ...patch }
    filings.filings.set(stored.id, stored)
    return { ...created.filing, ...patch }
  }

  return { reports, filings, jobs, notifier, emitter, warnings, clock, svc, seed, addFiling }
}
