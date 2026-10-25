import { randomUUID } from "node:crypto"
import { encodeTimeCursor, parseKeysetCursor } from "../../../src/db/cursor-helpers.js"
import { clampPageLimit } from "../../../src/lib/page-limit.js"
import type { WriteAuditInput } from "../../../src/services/admin/audit.js"
import type { FilingRepository } from "../../../src/services/filings/filing-repository.js"
import {
  ACTIVE_FILING_STATUSES,
  FILING_CASE_MATCH_MAX,
  FILING_CASE_TOKENS_MAX,
  FILING_CASE_WINDOW_DAYS,
  FILING_DUE_MAX_LIMIT,
  FILING_EVIDENCE_MAX,
  FILING_GROUP_STATUSES,
  FILING_LIST_DEFAULT_LIMIT,
  FILING_LIST_MAX_LIMIT,
  FILING_REPORT_IDS_MAX,
  FILING_ROUTES_MAX,
  FILING_RUNNING_MAX,
  SUCCESSFUL_FILING_STATUSES,
  type CreateFilingInput,
  type CreateFilingResult,
  type FilingEvidenceInput,
  type FilingEvidenceRecord,
  type FilingGroupCounts,
  type FilingListRecord,
  type FilingMessageRecord,
  type FilingRecord,
  type FilingRouteHealth,
  type FilingRouteInput,
  type FilingRouteRecord,
  type FilingSettingsRecord,
  type InsertFilingMessageInput,
  type LatestSuccessfulFiling,
  type ListDueQueuedArgs,
  type ListFilingsArgs,
  type ListFilingsResult,
  type RecordSuccessInput,
  type RecordSuccessResult,
  type RunningFiling,
  type TransitionInput,
} from "../../../src/services/filings/filing-types.js"

export type StoredFiling = Omit<FilingRecord, "jurisdictionName">

export interface MemoryReport {
  id: string
  geoid: string | null
  status: string
  title: string | null
  referenceCode: string | null
  deletedAt: Date | null
  verificationVerdict: string | null
}

export interface MemoryTimelineRow {
  reportId: string
  status: string
  note: string | null
  kind: string | null
  actorId: string | null
  createdAt: Date
}

const DAY_MS = 24 * 60 * 60 * 1000
const ROUTABLE_FROM = new Set(["submitted", "held", "published"])

const byNewest = (a: { at: Date; id: string }, b: { at: Date; id: string }): number =>
  b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

const byOldest = (a: { at: Date; id: string }, b: { at: Date; id: string }): number =>
  -byNewest(a, b)

/**
 * The FilingRepository twin. It keeps the reports, jurisdictions, timeline and audit rows the joins
 * and recordSuccess touch, and enforces the constraints the cases rely on (the active-filing index,
 * the route CHECKs and uniqueness, one link per message). Every write either applies whole or not at
 * all, as one transaction does.
 */
export class InMemoryFilingRepository implements FilingRepository {
  readonly jurisdictions = new Map<string, string>()
  readonly reports = new Map<string, MemoryReport>()
  readonly timeline: MemoryTimelineRow[] = []
  readonly audits: WriteAuditInput[] = []
  readonly filings = new Map<string, StoredFiling>()
  readonly evidence: FilingEvidenceRecord[] = []
  routes: FilingRouteRecord[] = []
  readonly messages: FilingMessageRecord[] = []
  /** `mail_threads.status` by thread id, for the D1 read that joins it. */
  readonly mailThreads = new Map<string, string>()
  private last = 0
  settings: FilingSettingsRecord = { paused: false, updatedAt: this.now(), updatedBy: null }

  /** Strictly increasing, so a write is always later than the row it read, as two transactions are. */
  private now(): Date {
    this.last = Math.max(Date.now(), this.last + 1)
    return new Date(this.last)
  }

  private withName(f: StoredFiling): FilingRecord {
    return {
      ...f,
      jurisdictionName: f.geoid === null ? null : (this.jurisdictions.get(f.geoid) ?? null),
    }
  }

  private all(): StoredFiling[] {
    return [...this.filings.values()]
  }

  private newFiling(input: CreateFilingInput, submittedAt: Date | null): StoredFiling {
    if (
      ACTIVE_FILING_STATUSES.includes(input.status) &&
      this.all().some(
        (f) => f.reportId === input.reportId && ACTIVE_FILING_STATUSES.includes(f.status),
      )
    ) {
      throw new ActiveFilingExists()
    }
    const now = this.now()
    return {
      id: randomUUID(),
      reportId: input.reportId,
      geoid: input.geoid,
      category: input.category,
      routeCategory: input.routeCategory ?? null,
      channel: input.channel ?? null,
      portalHost: input.portalHost ?? null,
      formUrl: input.formUrl ?? null,
      status: input.status,
      method: input.method ?? null,
      reason: input.reason ?? null,
      reasonDetail: input.reasonDetail ?? null,
      caseId: input.caseId ?? null,
      caseUrl: input.caseUrl ?? null,
      cityClosedAt: null,
      attempts: 0,
      runId: null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      aiWaitSince: null,
      scriptVersion: input.scriptVersion ?? null,
      dryRun: input.dryRun ?? false,
      ticketText: input.ticketText,
      note: input.note ?? null,
      mailThreadId: input.mailThreadId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      submittedAt,
    }
  }

  private evidenceRows(
    filingId: string,
    evidence: readonly FilingEvidenceInput[] | undefined,
  ): FilingEvidenceRecord[] {
    return (evidence ?? []).map((e) => ({
      id: randomUUID(),
      filingId,
      r2Key: e.r2Key,
      kind: e.kind,
      label: e.label ?? null,
      createdAt: this.now(),
    }))
  }

  create(input: CreateFilingInput, audit?: WriteAuditInput): Promise<CreateFilingResult> {
    let filing: StoredFiling
    try {
      filing = this.newFiling(input, null)
    } catch (err) {
      if (err instanceof ActiveFilingExists) return Promise.resolve({ kind: "active_exists" })
      throw err
    }
    this.filings.set(filing.id, filing)
    if (audit !== undefined) this.audits.push(audit)
    return Promise.resolve({ kind: "created", filing: this.withName(filing) })
  }

  getById(id: string): Promise<FilingRecord | null> {
    const f = this.filings.get(id)
    return Promise.resolve(f === undefined ? null : this.withName(f))
  }

  getActiveForReport(reportId: string): Promise<FilingRecord | null> {
    const f = this.all().find(
      (x) => x.reportId === reportId && ACTIVE_FILING_STATUSES.includes(x.status),
    )
    return Promise.resolve(f === undefined ? null : this.withName(f))
  }

  getLatestForReport(reportId: string): Promise<FilingRecord | null> {
    const f = this.all()
      .filter((x) => x.reportId === reportId)
      .sort((a, b) => byNewest({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))[0]
    return Promise.resolve(f === undefined ? null : this.withName(f))
  }

  private latestSuccessful(reportId: string): StoredFiling | undefined {
    return this.all()
      .filter((f) => f.reportId === reportId && SUCCESSFUL_FILING_STATUSES.includes(f.status))
      .sort((a, b) =>
        byNewest(
          { at: a.submittedAt ?? new Date(0), id: a.id },
          { at: b.submittedAt ?? new Date(0), id: b.id },
        ),
      )[0]
  }

  getLatestSuccessfulForReport(reportId: string): Promise<LatestSuccessfulFiling | null> {
    const f = this.latestSuccessful(reportId)
    if (f === undefined) return Promise.resolve(null)
    const mailBounced =
      f.status === "submitted" &&
      f.mailThreadId !== null &&
      this.mailThreads.get(f.mailThreadId) === "bounced"
    return Promise.resolve({ ...this.withName(f), mailBounced })
  }

  getLatestSuccessfulForReports(reportIds: readonly string[]): Promise<FilingRecord[]> {
    if (reportIds.length > FILING_REPORT_IDS_MAX) {
      return Promise.reject(new Error(`over ${FILING_REPORT_IDS_MAX} report ids`))
    }
    const found = [...new Set(reportIds)]
      .map((id) => this.latestSuccessful(id))
      .filter((f): f is StoredFiling => f !== undefined)
    return Promise.resolve(found.map((f) => this.withName(f)))
  }

  transition(id: string, input: TransitionInput): Promise<FilingRecord | null> {
    const f = this.filings.get(id)
    if (
      f === undefined ||
      !input.from.includes(f.status) ||
      (input.attempts !== undefined && f.attempts !== input.attempts) ||
      (input.runId !== undefined && f.runId !== input.runId)
    ) {
      return Promise.resolve(null)
    }
    const next = { ...f, ...definedOnly(input.set), updatedAt: this.now() }
    this.filings.set(id, next)
    this.evidence.push(...this.evidenceRows(id, input.evidence))
    if (input.audit !== undefined) this.audits.push(input.audit)
    return Promise.resolve(this.withName(next))
  }

  recordSuccess(input: RecordSuccessInput): Promise<RecordSuccessResult | null> {
    let filing: StoredFiling
    if ("filingId" in input) {
      const f = this.filings.get(input.filingId)
      const guard = input.from
      if (
        f === undefined ||
        !guard.status.includes(f.status) ||
        (guard.attempts !== undefined && f.attempts !== guard.attempts) ||
        (guard.runId !== undefined && f.runId !== guard.runId) ||
        (guard.reason !== undefined && f.reason !== guard.reason)
      ) {
        return Promise.resolve(null)
      }
      const now = this.now()
      filing = {
        ...f,
        ...definedOnly({
          caseId: input.caseId,
          caseUrl: input.caseUrl,
          mailThreadId: input.mailThreadId,
          scriptVersion: input.scriptVersion,
          dryRun: input.dryRun,
        }),
        status: input.outcome,
        method: input.method,
        updatedAt: now,
        submittedAt: now,
      }
    } else {
      filing = this.newFiling(
        {
          ...input.newFiling,
          status: input.outcome,
          method: input.method,
          caseId: input.caseId ?? null,
          caseUrl: input.caseUrl ?? null,
          mailThreadId: input.mailThreadId ?? null,
        },
        this.now(),
      )
    }
    this.filings.set(filing.id, filing)
    const reportChanged = this.applyReportSuccess(
      filing.reportId,
      input.note,
      input.actorId ?? null,
    )
    this.evidence.push(...this.evidenceRows(filing.id, input.evidence))
    if (input.audit !== undefined) this.audits.push(input.audit)
    return Promise.resolve({ filing: this.withName(filing), reportChanged })
  }

  private applyReportSuccess(reportId: string, note: string, actorId: string | null): boolean {
    const report = this.reports.get(reportId)
    if (
      report === undefined ||
      report.deletedAt !== null ||
      report.status === "rejected" ||
      report.verificationVerdict === "rejected"
    ) {
      return false
    }
    if (ROUTABLE_FROM.has(report.status)) report.status = "acknowledged"
    this.timeline.push({
      reportId,
      status: report.status,
      note,
      kind: "route",
      actorId,
      createdAt: this.now(),
    })
    return true
  }

  claim(id: string, attempt: number): Promise<{ runId: string } | null> {
    const f = this.filings.get(id)
    if (f === undefined || f.status !== "queued" || f.attempts !== attempt - 1) {
      return Promise.resolve(null)
    }
    const runId = randomUUID()
    this.filings.set(id, {
      ...f,
      status: "running",
      attempts: attempt,
      runId,
      updatedAt: this.now(),
    })
    return Promise.resolve({ runId })
  }

  list(args: ListFilingsArgs): Promise<ListFilingsResult> {
    const limit = clampPageLimit(args.limit, FILING_LIST_DEFAULT_LIMIT, FILING_LIST_MAX_LIMIT)
    const anchor = parseKeysetCursor(args.cursor)
    const statuses = FILING_GROUP_STATUSES[args.group]
    const rows = this.all()
      .filter((f) => statuses.includes(f.status))
      .filter((f) => anchor === null || byNewest({ at: f.updatedAt, id: f.id }, anchor) > 0)
      .sort((a, b) => byNewest({ at: a.updatedAt, id: a.id }, { at: b.updatedAt, id: b.id }))
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return Promise.resolve({
      records: page.map((f): FilingListRecord => {
        const report = this.reports.get(f.reportId)
        return {
          ...this.withName(f),
          reportTitle: report?.title ?? null,
          referenceCode: report?.referenceCode ?? null,
        }
      }),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeTimeCursor({ at: last.updatedAt, id: last.id })
          : null,
    })
  }

  countGroups(): Promise<FilingGroupCounts> {
    const count = (statuses: readonly string[]) =>
      this.all().filter((f) => statuses.includes(f.status)).length
    return Promise.resolve({
      needs_human: count(FILING_GROUP_STATUSES.needs_human),
      in_progress: count(FILING_GROUP_STATUSES.in_progress),
    })
  }

  listDueQueued(args: ListDueQueuedArgs): Promise<FilingRecord[]> {
    const limit = clampPageLimit(args.limit, FILING_DUE_MAX_LIMIT, FILING_DUE_MAX_LIMIT)
    const due = this.all()
      .filter(
        (f) =>
          f.status === "queued" &&
          (f.nextAttemptAt === null || f.nextAttemptAt <= args.now) &&
          (args.updatedBefore === null || f.updatedAt <= args.updatedBefore) &&
          f.channel !== null &&
          args.channels.includes(f.channel),
      )
      .sort((a, b) => byOldest({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
    return Promise.resolve(due.slice(0, limit).map((f) => this.withName(f)))
  }

  listRunningFilings(): Promise<RunningFiling[]> {
    return Promise.resolve(
      this.all()
        .filter((f) => f.status === "running")
        .sort((a, b) => byOldest({ at: a.updatedAt, id: a.id }, { at: b.updatedAt, id: b.id }))
        .slice(0, FILING_RUNNING_MAX)
        .map((f) => ({ id: f.id, attempts: f.attempts, runId: f.runId })),
    )
  }

  getLatestByMailThread(threadId: string): Promise<FilingRecord | null> {
    const f = this.all()
      .filter((x) => x.mailThreadId === threadId)
      .sort((a, b) => byNewest({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))[0]
    return Promise.resolve(f === undefined ? null : this.withName(f))
  }

  listEvidence(filingId: string): Promise<FilingEvidenceRecord[]> {
    return Promise.resolve(
      this.evidence
        .filter((e) => e.filingId === filingId)
        .sort((a, b) => byOldest({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }))
        .slice(0, FILING_EVIDENCE_MAX),
    )
  }

  listRoutes(geoid: string): Promise<FilingRouteRecord[]> {
    return Promise.resolve(
      this.routes
        .filter((r) => r.geoid === geoid)
        .sort((a, b) => routeOrder(a.category, b.category))
        .slice(0, FILING_ROUTES_MAX),
    )
  }

  findRoutes(geoid: string, category: string): Promise<FilingRouteRecord[]> {
    return Promise.resolve(
      this.routes
        .filter((r) => r.geoid === geoid && (r.category === category || r.category === null))
        .sort((a, b) => (a.category === null ? 1 : 0) - (b.category === null ? 1 : 0)),
    )
  }

  replaceRoutes(
    geoid: string,
    routes: readonly FilingRouteInput[],
    audit?: WriteAuditInput,
  ): Promise<FilingRouteRecord[]> {
    if (routes.length > FILING_ROUTES_MAX) {
      return Promise.reject(new Error(`over ${FILING_ROUTES_MAX} routes`))
    }
    const seen = new Set<string | null>()
    for (const r of routes) {
      if (r.channel === "portal" && (r.formUrl ?? null) === null) {
        return Promise.reject(new Error("filing_routes_portal_form_url_check"))
      }
      if ((r.statusSenderDomains?.length ?? 0) > 5 || (r.requestTypeHint?.length ?? 0) > 200) {
        return Promise.reject(new Error("filing_routes check violation"))
      }
      if (seen.has(r.category)) return Promise.reject(new Error("duplicate route category"))
      seen.add(r.category)
    }
    const now = this.now()
    const replaced = routes.map((r): FilingRouteRecord => ({
      geoid,
      category: r.category,
      channel: r.channel,
      formUrl: r.formUrl ?? null,
      requestTypeHint: r.requestTypeHint ?? null,
      includeLink: r.includeLink ?? true,
      statusSenderDomains: [...(r.statusSenderDomains ?? [])],
      enabled: r.enabled ?? true,
      updatedAt: now,
      updatedBy: audit?.actorId ?? null,
    }))
    this.routes = [...this.routes.filter((r) => r.geoid !== geoid), ...replaced]
    if (audit !== undefined) this.audits.push(audit)
    return this.listRoutes(geoid)
  }

  routeHealth(geoid: string): Promise<FilingRouteHealth[]> {
    const groups = new Map<string | null, StoredFiling[]>()
    for (const f of this.all().filter((x) => x.geoid === geoid)) {
      groups.set(f.routeCategory, [...(groups.get(f.routeCategory) ?? []), f])
    }
    const latest = (dates: (Date | null)[]): Date | null =>
      dates.reduce<Date | null>(
        (max, d) => (d !== null && (max === null || d > max) ? d : max),
        null,
      )
    return Promise.resolve(
      [...groups.entries()]
        .sort(([a], [b]) => routeOrder(a, b))
        .slice(0, FILING_ROUTES_MAX)
        .map(([routeCategory, fs]) => ({
          routeCategory,
          lastFiledAt: latest(
            fs
              .filter((f) => SUCCESSFUL_FILING_STATUSES.includes(f.status))
              .map((f) => f.submittedAt),
          ),
          lastFailedAt: latest(
            fs.filter((f) => f.status === "needs_human").map((f) => f.updatedAt),
          ),
          scriptVersion:
            fs
              .filter((f) => f.scriptVersion !== null)
              .sort((a, b) =>
                byNewest({ at: a.updatedAt, id: a.id }, { at: b.updatedAt, id: b.id }),
              )[0]?.scriptVersion ?? null,
        })),
    )
  }

  getSettings(): Promise<FilingSettingsRecord> {
    return Promise.resolve({ ...this.settings })
  }

  setPaused(paused: boolean, audit?: WriteAuditInput): Promise<FilingSettingsRecord> {
    this.settings = { paused, updatedAt: this.now(), updatedBy: audit?.actorId ?? null }
    if (audit !== undefined) this.audits.push(audit)
    return this.getSettings()
  }

  insertMessageIfAbsent(input: InsertFilingMessageInput): Promise<FilingMessageRecord | null> {
    const inboundEmailId = input.inboundEmailId ?? null
    const mailMessageId = input.mailMessageId ?? null
    const linked = this.messages.some(
      (m) =>
        (inboundEmailId !== null && m.inboundEmailId === inboundEmailId) ||
        (mailMessageId !== null && m.mailMessageId === mailMessageId),
    )
    if (linked) return Promise.resolve(null)
    const row: FilingMessageRecord = {
      id: randomUUID(),
      filingId: input.filingId,
      inboundEmailId,
      mailMessageId,
      trusted: input.trusted,
      flagged: false,
      classification: null,
      summary: null,
      appliedAt: null,
      createdAt: this.now(),
    }
    this.messages.push(row)
    return Promise.resolve({ ...row })
  }

  getMessageByInboundEmailId(inboundEmailId: string): Promise<FilingMessageRecord | null> {
    const m = this.messages.find((x) => x.inboundEmailId === inboundEmailId)
    return Promise.resolve(m === undefined ? null : { ...m })
  }

  getMessageByMailMessageId(mailMessageId: string): Promise<FilingMessageRecord | null> {
    const m = this.messages.find((x) => x.mailMessageId === mailMessageId)
    return Promise.resolve(m === undefined ? null : { ...m })
  }

  flagMessage(id: string): Promise<void> {
    const m = this.messages.find((x) => x.id === id)
    if (m !== undefined) m.flagged = true
    return Promise.resolve()
  }

  findByCaseIds(tokens: readonly string[]): Promise<FilingRecord[]> {
    if (tokens.length > FILING_CASE_TOKENS_MAX) {
      return Promise.reject(new Error(`over ${FILING_CASE_TOKENS_MAX} tokens`))
    }
    const since = Date.now() - FILING_CASE_WINDOW_DAYS * DAY_MS
    const found = this.all()
      .filter(
        (f) =>
          f.caseId !== null &&
          tokens.includes(f.caseId) &&
          SUCCESSFUL_FILING_STATUSES.includes(f.status) &&
          f.submittedAt !== null &&
          f.submittedAt.getTime() >= since,
      )
      .sort((a, b) => byNewest({ at: a.submittedAt!, id: a.id }, { at: b.submittedAt!, id: b.id }))
    return Promise.resolve(found.slice(0, FILING_CASE_MATCH_MAX).map((f) => this.withName(f)))
  }
}

class ActiveFilingExists extends Error {}

/** The default (NULL) route first, then categories ascending, as `ORDER BY category NULLS FIRST`. */
function routeOrder(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
