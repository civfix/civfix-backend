import { AppError, FILING_LIST_PAGE_MAX } from "@civfix/contract"
import type {
  FilingEvidenceDTO,
  FilingGroup,
  FilingRouteDTO,
  FilingRouteInput,
  FilingSettingsDTO,
  GetFilingResponse,
  ListFilingsResponse,
  ReportCategory,
} from "@civfix/contract"
import { organizationalDomain } from "../../adapters/inbound-mail.cf.js"
import { parseKeysetCursor } from "../../db/cursor-helpers.js"
import { mapWithLimit } from "../../lib/concurrency.js"
import type { AdminAuditAction, WriteAuditInput } from "../admin/audit.js"
import type { AdminReportRecord, AdminReportRepository } from "../admin/admin-report-repository.js"
import { CONSUMER_MAIL_DOMAINS } from "../admin/inbound-bounce.js"
import type { JurisdictionContactsRepository } from "../admin/jurisdiction-contacts-repository.js"
import { PRESIGN_CONCURRENCY, type PresignFilingEvidence } from "../media-presign.js"
import type { FilingRepository } from "./filing-repository.js"
import { resolveFilingRoute } from "./filing-route.js"
import {
  initialState,
  toAdminFilingDTO,
  type AdminReportFilingDTO,
  type FilingService,
} from "./filing-service.js"
import type { FilingRecord, FilingRouteHealth, FilingRouteRecord } from "./filing-types.js"

export interface FilingAdminServiceDeps {
  filings: FilingRepository
  reports: Pick<AdminReportRepository, "getReport" | "getRouting">
  jurisdictions: Pick<JurisdictionContactsRepository, "jurisdictionExists">
  filingService: Pick<
    FilingService,
    "create" | "applyFilingSuccess" | "enqueueFiling" | "runSweepPass"
  >
  presignEvidence: PresignFilingEvidence
  /** FILING_AUTOMATIC_ENABLED (D10). */
  automaticFiling: boolean
}

export interface FilingAdminService {
  file(
    reportId: string,
    input: { actorId: string; note: string | null },
  ): Promise<AdminReportFilingDTO>
  list(input: { group: FilingGroup; cursor?: string | undefined }): Promise<ListFilingsResponse>
  get(id: string): Promise<GetFilingResponse["filing"]>
  retry(id: string, actorId: string): Promise<AdminReportFilingDTO>
  cancel(id: string, input: { actorId: string; note: string | null }): Promise<AdminReportFilingDTO>
  recordManual(
    id: string,
    input: { actorId: string; caseId: string; caseUrl: string | null; note: string | null },
  ): Promise<AdminReportFilingDTO>
  getSettings(): Promise<FilingSettingsDTO>
  setSettings(paused: boolean, actorId: string): Promise<FilingSettingsDTO>
  listRoutes(geoid: string): Promise<FilingRouteDTO[]>
  saveRoutes(
    geoid: string,
    routes: readonly FilingRouteInput[],
    actorId: string,
  ): Promise<FilingRouteDTO[]>
}

const FILING_NOT_FOUND = "Filing not found"
const REPORT_NOT_FOUND = "Report not found"
const JURISDICTION_NOT_FOUND = "Jurisdiction not found"
const WRONG_STATE = "This filing can't do that in its current state"
const SETTINGS_TARGET = "filing_settings"

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString()
}

function filingTarget(id: string): string {
  return `filing:${id}`
}

function filingAudit(
  action: AdminAuditAction,
  id: string,
  actorId: string,
  note: string | null,
): WriteAuditInput {
  // The operator's note is admin-only context for the audit trail; nothing stores it on the filing.
  return { actorId, action, target: filingTarget(id), ...(note !== null ? { meta: { note } } : {}) }
}

/** Retry, Cancel and Record manual filing apply only to these (D5). */
function isOpen(filing: FilingRecord): boolean {
  return (
    (filing.status === "queued" || filing.status === "needs_human") &&
    filing.reason !== "city_needs_info"
  )
}

function isCityNeedsInfo(filing: FilingRecord): boolean {
  return filing.status === "needs_human" && filing.reason === "city_needs_info"
}

function toRouteDTO(
  route: FilingRouteRecord,
  health: FilingRouteHealth | undefined,
): FilingRouteDTO {
  return {
    category: route.category as ReportCategory | null,
    channel: route.channel,
    formUrl: route.formUrl,
    requestTypeHint: route.requestTypeHint,
    includeLink: route.includeLink,
    statusSenderDomains: route.statusSenderDomains,
    enabled: route.enabled,
    health: {
      lastFiledAt: iso(health?.lastFiledAt ?? null),
      lastFailedAt: iso(health?.lastFailedAt ?? null),
      scriptVersion: health?.scriptVersion ?? null,
    },
  }
}

function withHealth(
  routes: readonly FilingRouteRecord[],
  health: readonly FilingRouteHealth[],
): FilingRouteDTO[] {
  return routes.map((route) =>
    toRouteDTO(
      route,
      health.find((h) => h.routeCategory === route.category),
    ),
  )
}

// Anyone can send from a consumer mailbox, so trusting its domain would let anyone forge a city's
// status mail about a filing (D4, D11).
function assertTrustableSenders(routes: readonly FilingRouteInput[]): void {
  routes.forEach((route, index) => {
    const consumer = route.statusSenderDomains.find((domain) =>
      CONSUMER_MAIL_DOMAINS.has(organizationalDomain(domain) ?? domain),
    )
    if (consumer !== undefined) {
      throw AppError.validation({
        [`routes.${index}.statusSenderDomains`]: `${consumer} is a public mail provider: anyone can send from it.`,
      })
    }
  })
}

export function makeFilingAdminService(deps: FilingAdminServiceDeps): FilingAdminService {
  async function loadFiling(id: string): Promise<FilingRecord> {
    const filing = await deps.filings.getById(id)
    if (filing === null) throw AppError.notFound(FILING_NOT_FOUND)
    return filing
  }

  async function dtoOf(
    filing: FilingRecord,
    report?: AdminReportRecord | null,
  ): Promise<AdminReportFilingDTO> {
    // A removed report is hidden from every admin report read, so its filing shows without a title.
    const r = report === undefined ? await deps.reports.getReport(filing.reportId) : report
    return toAdminFilingDTO(filing, {
      title: r?.title ?? "",
      referenceCode: r?.referenceCode ?? null,
    })
  }

  async function assertJurisdiction(geoid: string): Promise<void> {
    if (!(await deps.jurisdictions.jurisdictionExists(geoid))) {
      throw AppError.notFound(JURISDICTION_NOT_FOUND)
    }
  }

  function settingsDTO(paused: boolean): FilingSettingsDTO {
    return { paused, automaticFiling: deps.automaticFiling }
  }

  return {
    async file(reportId, input) {
      const report = await deps.reports.getReport(reportId)
      if (report === null) throw AppError.notFound(REPORT_NOT_FOUND)
      const outcome = await deps.filingService.create({
        reportId,
        actorId: input.actorId,
        note: input.note,
        audit: { actorId: input.actorId, action: "filing.filed" },
      })
      if (outcome.kind === "already_filed") {
        throw AppError.conflict("This report is already filed with the city")
      }
      if (outcome.kind === "not_fileable") throw AppError.conflict("This report can't be filed")
      return dtoOf(outcome.filing, report)
    },

    async list(input) {
      if (input.cursor !== undefined && parseKeysetCursor(input.cursor) === null) {
        throw AppError.validation({ cursor: "must be a cursor from a previous page" })
      }
      const [page, counts] = await Promise.all([
        deps.filings.list({
          group: input.group,
          cursor: input.cursor ?? null,
          limit: FILING_LIST_PAGE_MAX,
        }),
        deps.filings.countGroups(),
      ])
      return {
        items: page.records.map((r) =>
          toAdminFilingDTO(r, { title: r.reportTitle ?? "", referenceCode: r.referenceCode }),
        ),
        nextCursor: page.nextCursor,
        counts,
      }
    },

    async get(id) {
      const filing = await loadFiling(id)
      const [dto, evidence] = await Promise.all([dtoOf(filing), deps.filings.listEvidence(id)])
      const items = await mapWithLimit(
        evidence,
        PRESIGN_CONCURRENCY,
        async (e): Promise<FilingEvidenceDTO> => ({
          id: e.id,
          kind: e.kind,
          label: e.label ?? "",
          url: await deps.presignEvidence(e.r2Key),
          createdAt: e.createdAt.toISOString(),
        }),
      )
      return { ...dto, evidence: items }
    },

    async retry(id, actorId) {
      const filing = await loadFiling(id)
      if (filing.status !== "needs_human" || filing.reason === "city_needs_info") {
        throw AppError.conflict(WRONG_STATE)
      }
      const [report, routing] = await Promise.all([
        deps.reports.getReport(filing.reportId),
        deps.reports.getRouting(filing.reportId),
      ])
      if (report === null) throw AppError.notFound(REPORT_NOT_FOUND)
      const geoid = routing?.geoid ?? null
      const route = await resolveFilingRoute(
        { geoid, category: report.category, contact: routing?.contact ?? null },
        deps,
      )
      const { status, reason } = initialState(route, deps.automaticFiling)
      const retried = await deps.filings.transition(id, {
        from: ["needs_human"],
        set: {
          geoid,
          routeCategory: route.routeCategory,
          channel: route.channel,
          portalHost: route.portalHost,
          formUrl: route.formUrl,
          status,
          reason,
          reasonDetail: null,
          attempts: 0,
          aiWaitSince: null,
        },
        audit: { actorId, action: "filing.retried", target: filingTarget(id) },
      })
      if (retried === null) throw AppError.conflict(WRONG_STATE)
      if (retried.status !== "queued" || (await deps.filingService.enqueueFiling(retried))) {
        return dtoOf(retried, report)
      }
      // No job went out (a portal filing while automatic filing is off), so it waits for a human
      // instead of sitting queued with nothing to run it.
      const off = await deps.filings.transition(id, {
        from: ["queued"],
        set: { status: "needs_human", reason: "filing_off" },
      })
      return dtoOf(off ?? (await loadFiling(id)), report)
    },

    async cancel(id, input) {
      const filing = await loadFiling(id)
      if (!isOpen(filing)) throw AppError.conflict(WRONG_STATE)
      const cancelled = await deps.filings.transition(id, {
        from: ["queued", "needs_human"],
        set: { status: "cancelled" },
        audit: filingAudit("filing.cancelled", id, input.actorId, input.note),
      })
      if (cancelled === null) throw AppError.conflict(WRONG_STATE)
      return dtoOf(cancelled)
    },

    async recordManual(id, input) {
      const filing = await loadFiling(id)
      const audit = filingAudit("filing.manual_recorded", id, input.actorId, input.note)
      if (isCityNeedsInfo(filing)) {
        // The report already had its success effects when the filing first succeeded (D5): only the
        // filing returns to submitted, with the request number the operator answered the city on.
        const submitted = await deps.filings.transition(id, {
          from: ["needs_human"],
          set: {
            status: "submitted",
            method: "operator",
            caseId: input.caseId,
            caseUrl: input.caseUrl,
          },
          audit,
        })
        if (submitted === null) throw AppError.conflict(WRONG_STATE)
        return dtoOf(submitted)
      }
      if (!isOpen(filing)) throw AppError.conflict(WRONG_STATE)
      const { applied } = await deps.filingService.applyFilingSuccess({
        filingId: id,
        from: { status: [filing.status] },
        outcome: "submitted",
        method: "operator",
        caseId: input.caseId,
        caseUrl: input.caseUrl,
        actorId: input.actorId,
        audit,
      })
      if (!applied) throw AppError.conflict(WRONG_STATE)
      return dtoOf(await loadFiling(id))
    },

    async getSettings() {
      return settingsDTO((await deps.filings.getSettings()).paused)
    },

    async setSettings(paused, actorId) {
      const current = await deps.filings.getSettings()
      if (current.paused === paused) return settingsDTO(paused)
      const saved = await deps.filings.setPaused(paused, {
        actorId,
        action: "filing.settings_changed",
        target: SETTINGS_TARGET,
        meta: { paused },
      })
      // Resume starts the waiting filings at once, oldest first, instead of after the next cron sweep.
      if (current.paused && !saved.paused) {
        await deps.filingService.runSweepPass({ ignoreAge: true })
      }
      return settingsDTO(saved.paused)
    },

    async listRoutes(geoid) {
      await assertJurisdiction(geoid)
      const [routes, health] = await Promise.all([
        deps.filings.listRoutes(geoid),
        deps.filings.routeHealth(geoid),
      ])
      return withHealth(routes, health)
    },

    async saveRoutes(geoid, routes, actorId) {
      assertTrustableSenders(routes)
      await assertJurisdiction(geoid)
      const saved = await deps.filings.replaceRoutes(geoid, routes, {
        actorId,
        action: "filing.routes_saved",
        target: `jurisdiction:${geoid}`,
        meta: { count: routes.length },
      })
      return withHealth(saved, await deps.filings.routeHealth(geoid))
    },
  }
}
