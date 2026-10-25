import { FakeJobs } from "@civfix/seams"
import type {
  AdminReportStatus,
  ReportCategory,
  ReportTimelineItem,
  ReportVisibility,
} from "@civfix/contract"
import {
  InMemoryAdminReportRepository,
  type SeededReport,
} from "../admin/admin-report-repository.memory.js"
import { RecordingNotifier } from "../notifications.js"
import {
  InMemoryFilingRepository,
  type MemoryReport,
  type MemoryTimelineRow,
} from "./filing-repository.memory.js"
import type { ReporterNotifier } from "../../../src/services/admin/admin-report-types.js"
import {
  makeFilingService,
  type FilingService,
} from "../../../src/services/filings/filing-service.js"
import type { CreateFilingInput, FilingRecord } from "../../../src/services/filings/filing-types.js"
import type {
  ReportChatSystemEmitter,
  ReportTimelineEvent,
} from "../../../src/services/report-timeline-event.js"

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

function reportView(seeded: SeededReport): MemoryReport {
  return {
    id: seeded.record.id,
    get geoid() {
      return seeded.routing?.geoid ?? null
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
}

/**
 * A filing twin over the admin report twin's rows, as both repositories share one database: the
 * reports it reads are the admin twin's, and the `route` rows it writes land on the admin twin's
 * timeline too.
 */
export function linkedFilingRepository(
  reports: InMemoryAdminReportRepository,
): InMemoryFilingRepository {
  const filings = new InMemoryFilingRepository()
  filings.jurisdictions.set(J_GEOID, J_NAME)
  const get = (id: string): MemoryReport | undefined => {
    const seeded = reports.reports.get(id)
    return seeded === undefined ? undefined : reportView(seeded)
  }
  const ownPush = filings.timeline.push.bind(filings.timeline)
  const push = (...rows: MemoryTimelineRow[]): number => {
    for (const row of rows) {
      const list = reports.timeline.get(row.reportId) ?? []
      list.push({
        status: row.status as AdminReportStatus,
        note: row.note,
        kind: row.kind as ReportTimelineItem["kind"],
        who: row.actorId ?? "system",
        createdAt: row.createdAt,
      })
      reports.timeline.set(row.reportId, list)
    }
    return ownPush(...rows)
  }
  // Not enumerable, so both still compare equal to a plain Map and array.
  Object.defineProperty(filings.reports, "get", { value: get, enumerable: false })
  Object.defineProperty(filings.timeline, "push", { value: push, enumerable: false })
  return filings
}

/** A filing service over the admin twin, for tests of services that depend on one. */
export function memoryFilingService(
  reports: InMemoryAdminReportRepository,
  opts: {
    filings?: InMemoryFilingRepository
    jobs?: FakeJobs
    reportChatEmitter?: ReportChatSystemEmitter
    notifications?: ReporterNotifier
  } = {},
): FilingService {
  return makeFilingService({
    filings: opts.filings ?? linkedFilingRepository(reports),
    reports,
    jobs: opts.jobs ?? new FakeJobs(),
    automaticFiling: false,
    webBaseUrl: WEB_BASE,
    ...(opts.reportChatEmitter !== undefined ? { reportChatEmitter: opts.reportChatEmitter } : {}),
    ...(opts.notifications !== undefined ? { notifications: opts.notifications } : {}),
  })
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

/** The filing service over the admin report twin and a filing twin linked to it. */
export function filingHarness(opts: { automatic?: boolean; now?: Date } = {}): FilingHarness {
  const reports = new InMemoryAdminReportRepository()
  const filings = linkedFilingRepository(reports)
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
    return reports.seedReport({
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
