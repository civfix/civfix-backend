import type { Queryable, Sql, SqlFragment } from "../../db/client.js"
import {
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  parseKeysetCursor,
} from "../../db/cursor-helpers.js"
import { isUniqueViolationOn } from "../../db/pg-errors.js"
import { clampPageLimit } from "../../lib/page-limit.js"
import { insertAuditRow } from "../admin/audit-repository.drizzle.js"
import type { FilingRepository } from "./filing-repository.js"
import {
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
  type CreateFilingInput,
  type FilingChannel,
  type FilingEvidenceInput,
  type FilingEvidenceKind,
  type FilingEvidenceRecord,
  type FilingMessageRecord,
  type FilingMethod,
  type FilingMutableFields,
  type FilingReason,
  type FilingRecord,
  type FilingRouteRecord,
  type FilingSettingsRecord,
  type FilingStatus,
  type RecordSuccessInput,
} from "./filing-types.js"

const ACTIVE_FILING_INDEX = "report_filings_active_report_key"

interface FilingRow {
  id: string
  report_id: string
  geoid: string | null
  jurisdiction_name: string | null
  category: string
  route_category: string | null
  channel: FilingChannel | null
  portal_host: string | null
  form_url: string | null
  status: FilingStatus
  method: FilingMethod | null
  reason: FilingReason | null
  reason_detail: string | null
  case_id: string | null
  case_url: string | null
  city_closed_at: Date | null
  attempts: number
  run_id: string | null
  next_attempt_at: Date | null
  ai_wait_since: Date | null
  script_version: string | null
  dry_run: boolean
  ticket_text: string
  note: string | null
  mail_thread_id: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
  submitted_at: Date | null
}

function toFiling(r: FilingRow): FilingRecord {
  return {
    id: r.id,
    reportId: r.report_id,
    geoid: r.geoid,
    jurisdictionName: r.jurisdiction_name,
    category: r.category,
    routeCategory: r.route_category,
    channel: r.channel,
    portalHost: r.portal_host,
    formUrl: r.form_url,
    status: r.status,
    method: r.method,
    reason: r.reason,
    reasonDetail: r.reason_detail,
    caseId: r.case_id,
    caseUrl: r.case_url,
    cityClosedAt: r.city_closed_at,
    attempts: r.attempts,
    runId: r.run_id,
    nextAttemptAt: r.next_attempt_at,
    aiWaitSince: r.ai_wait_since,
    scriptVersion: r.script_version,
    dryRun: r.dry_run,
    ticketText: r.ticket_text,
    note: r.note,
    mailThreadId: r.mail_thread_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    submittedAt: r.submitted_at,
  }
}

interface EvidenceRow {
  id: string
  filing_id: string
  r2_key: string
  kind: FilingEvidenceKind
  label: string | null
  created_at: Date
}

interface RouteRow {
  geoid: string
  category: string | null
  channel: FilingChannel
  form_url: string | null
  request_type_hint: string | null
  include_link: boolean
  status_sender_domains: string[]
  enabled: boolean
  updated_at: Date
  updated_by: string | null
}

function toRoute(r: RouteRow): FilingRouteRecord {
  return {
    geoid: r.geoid,
    category: r.category,
    channel: r.channel,
    formUrl: r.form_url,
    requestTypeHint: r.request_type_hint,
    includeLink: r.include_link,
    statusSenderDomains: r.status_sender_domains,
    enabled: r.enabled,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }
}

interface MessageRow {
  id: string
  filing_id: string
  inbound_email_id: string | null
  mail_message_id: string | null
  trusted: boolean
  flagged: boolean
  classification: unknown
  summary: string | null
  applied_at: Date | null
  created_at: Date
}

function toMessage(r: MessageRow): FilingMessageRecord {
  return {
    id: r.id,
    filingId: r.filing_id,
    inboundEmailId: r.inbound_email_id,
    mailMessageId: r.mail_message_id,
    trusted: r.trusted,
    flagged: r.flagged,
    classification: r.classification,
    summary: r.summary,
    appliedAt: r.applied_at,
    createdAt: r.created_at,
  }
}

/** `source` is a table or a CTE of report_filings rows, read as `f`. */
function selectFilings(sql: Queryable, source: SqlFragment = sql`report_filings`): SqlFragment {
  return sql`
    SELECT f.*, j.name AS jurisdiction_name
    FROM ${source} f
    LEFT JOIN jurisdictions j ON j.geoid = f.geoid
  `
}

const MUTABLE_COLUMNS: { [K in keyof FilingMutableFields]-?: string } = {
  geoid: "geoid",
  category: "category",
  routeCategory: "route_category",
  channel: "channel",
  portalHost: "portal_host",
  formUrl: "form_url",
  status: "status",
  method: "method",
  reason: "reason",
  reasonDetail: "reason_detail",
  caseId: "case_id",
  caseUrl: "case_url",
  cityClosedAt: "city_closed_at",
  attempts: "attempts",
  runId: "run_id",
  nextAttemptAt: "next_attempt_at",
  aiWaitSince: "ai_wait_since",
  scriptVersion: "script_version",
  dryRun: "dry_run",
  ticketText: "ticket_text",
  note: "note",
  mailThreadId: "mail_thread_id",
}

function setList(tx: Queryable, set: Partial<FilingMutableFields>): SqlFragment {
  let list = tx`updated_at = now()`
  for (const [key, column] of Object.entries(MUTABLE_COLUMNS) as [
    keyof FilingMutableFields,
    string,
  ][]) {
    const value = set[key]
    if (value === undefined) continue
    list = tx`${list}, ${tx(column)} = ${value}`
  }
  return list
}

async function insertFiling(
  tx: Queryable,
  input: CreateFilingInput,
  submittedNow: boolean,
): Promise<FilingRow> {
  const [row] = await tx<FilingRow[]>`
    WITH f AS (
      INSERT INTO report_filings (
        report_id, geoid, category, route_category, channel, portal_host, form_url, status,
        method, reason, reason_detail, case_id, case_url, next_attempt_at, script_version,
        dry_run, ticket_text, note, mail_thread_id, created_by, submitted_at
      )
      VALUES (
        ${input.reportId}, ${input.geoid}, ${input.category}, ${input.routeCategory ?? null},
        ${input.channel ?? null}, ${input.portalHost ?? null}, ${input.formUrl ?? null},
        ${input.status}, ${input.method ?? null}, ${input.reason ?? null},
        ${input.reasonDetail ?? null}, ${input.caseId ?? null}, ${input.caseUrl ?? null},
        ${input.nextAttemptAt ?? null}, ${input.scriptVersion ?? null}, ${input.dryRun ?? false},
        ${input.ticketText}, ${input.note ?? null}, ${input.mailThreadId ?? null},
        ${input.createdBy ?? null}, ${submittedNow ? tx`now()` : null}
      )
      RETURNING *
    )
    ${selectFilings(tx, tx`f`)}
  `
  if (row === undefined) throw new Error("report_filings insert returned no row")
  return row
}

async function insertEvidence(
  tx: Queryable,
  filingId: string,
  evidence: readonly FilingEvidenceInput[] | undefined,
): Promise<void> {
  if (evidence === undefined || evidence.length === 0) return
  const rows = evidence.map((e) => ({ r2_key: e.r2Key, kind: e.kind, label: e.label ?? null }))
  await tx`
    INSERT INTO filing_evidence (filing_id, r2_key, kind, label)
    SELECT ${filingId}::uuid, e.r2_key, e.kind, e.label
    FROM jsonb_to_recordset(${tx.json(rows)}) AS e(r2_key text, kind text, label text)
  `
}

/**
 * The success effects on the report (D5), only while it is still fileable: the report moves from
 * submitted / held / published to acknowledged, and one public `route` row carries the fixed note
 * with whatever status the report is in afterwards. Locking the report first keeps a concurrent
 * removal from landing between the check and the writes.
 */
async function applyReportSuccess(
  tx: Queryable,
  reportId: string,
  note: string,
  actorId: string | null,
): Promise<boolean> {
  const [report] = await tx<{ status: string }[]>`
    SELECT status FROM reports
    WHERE id = ${reportId}
      AND deleted_at IS NULL
      AND status <> 'rejected'
      AND verification_verdict IS DISTINCT FROM 'rejected'
    FOR UPDATE
  `
  if (report === undefined) return false
  const moved = await tx<{ status: string }[]>`
    UPDATE reports SET status = 'acknowledged'
    WHERE id = ${reportId} AND status IN ('submitted', 'held', 'published')
    RETURNING status
  `
  const status = moved[0]?.status ?? report.status
  await tx`
    INSERT INTO report_timeline (report_id, status, note, kind, actor_id)
    VALUES (${reportId}, ${status}, ${note}, 'route', ${actorId})
  `
  return true
}

async function updateToSuccess(
  tx: Queryable,
  input: Extract<RecordSuccessInput, { filingId: string }>,
): Promise<FilingRow | undefined> {
  const set: Partial<FilingMutableFields> = {
    status: input.outcome,
    method: input.method,
    caseId: input.caseId,
    caseUrl: input.caseUrl,
    mailThreadId: input.mailThreadId,
  }
  const attempts =
    input.from.attempts === undefined ? tx`` : tx`AND attempts = ${input.from.attempts}`
  const reason = input.from.reason === undefined ? tx`` : tx`AND reason = ${input.from.reason}`
  const [row] = await tx<FilingRow[]>`
    WITH f AS (
      UPDATE report_filings
      SET ${setList(tx, set)}, submitted_at = now()
      WHERE id = ${input.filingId}
        AND status = ANY(${[...input.from.status]}::text[])
        ${attempts}
        ${reason}
      RETURNING *
    )
    ${selectFilings(tx, tx`f`)}
  `
  return row
}

async function listRoutesIn(tx: Queryable, geoid: string): Promise<FilingRouteRecord[]> {
  const rows = await tx<RouteRow[]>`
    SELECT geoid, category, channel, form_url, request_type_hint, include_link,
           status_sender_domains, enabled, updated_at, updated_by
    FROM filing_routes
    WHERE geoid = ${geoid}
    ORDER BY category ASC NULLS FIRST
    LIMIT ${FILING_ROUTES_MAX}
  `
  return rows.map(toRoute)
}

const MESSAGE_COLUMNS = (sql: Queryable) => sql`
  id, filing_id, inbound_email_id, mail_message_id, trusted, flagged, classification, summary,
  applied_at, created_at
`

export function makeDrizzleFilingRepository(sql: Sql): FilingRepository {
  async function oneFiling(where: SqlFragment): Promise<FilingRecord | null> {
    const [row] = await sql<FilingRow[]>`${selectFilings(sql)} ${where} LIMIT 1`
    return row === undefined ? null : toFiling(row)
  }

  return {
    async create(input, audit) {
      try {
        return await sql.begin(async (tx) => {
          const row = await insertFiling(tx, input, false)
          if (audit !== undefined) await insertAuditRow(tx, audit)
          return { kind: "created" as const, filing: toFiling(row) }
        })
      } catch (err) {
        if (isUniqueViolationOn(err, ACTIVE_FILING_INDEX)) return { kind: "active_exists" }
        throw err
      }
    },

    getById(id) {
      return oneFiling(sql`WHERE f.id = ${id}`)
    },

    getActiveForReport(reportId) {
      return oneFiling(
        sql`WHERE f.report_id = ${reportId} AND f.status IN ('queued', 'running', 'needs_human')`,
      )
    },

    getLatestSuccessfulForReport(reportId) {
      return oneFiling(sql`
        WHERE f.report_id = ${reportId} AND f.status IN ('submitted', 'linked_existing')
        ORDER BY f.submitted_at DESC NULLS LAST, f.id DESC
      `)
    },

    async getLatestSuccessfulForReports(reportIds) {
      if (reportIds.length > FILING_REPORT_IDS_MAX) {
        throw new Error(`getLatestSuccessfulForReports: over ${FILING_REPORT_IDS_MAX} report ids`)
      }
      if (reportIds.length === 0) return []
      const rows = await sql<FilingRow[]>`
        SELECT DISTINCT ON (f.report_id) f.*, j.name AS jurisdiction_name
        FROM report_filings f
        LEFT JOIN jurisdictions j ON j.geoid = f.geoid
        WHERE f.report_id = ANY(${[...reportIds]}::uuid[])
          AND f.status IN ('submitted', 'linked_existing')
        ORDER BY f.report_id, f.submitted_at DESC NULLS LAST, f.id DESC
        LIMIT ${FILING_REPORT_IDS_MAX}
      `
      return rows.map(toFiling)
    },

    async transition(id, input) {
      return sql.begin(async (tx) => {
        const attempts = input.attempts === undefined ? tx`` : tx`AND attempts = ${input.attempts}`
        const [row] = await tx<FilingRow[]>`
          WITH f AS (
            UPDATE report_filings SET ${setList(tx, input.set)}
            WHERE id = ${id} AND status = ANY(${[...input.from]}::text[]) ${attempts}
            RETURNING *
          )
          ${selectFilings(tx, tx`f`)}
        `
        if (row === undefined) return null
        await insertEvidence(tx, id, input.evidence)
        if (input.audit !== undefined) await insertAuditRow(tx, input.audit)
        return toFiling(row)
      })
    },

    async recordSuccess(input) {
      return sql.begin(async (tx) => {
        const row =
          "filingId" in input
            ? await updateToSuccess(tx, input)
            : await insertFiling(
                tx,
                {
                  ...input.newFiling,
                  status: input.outcome,
                  method: input.method,
                  caseId: input.caseId ?? null,
                  caseUrl: input.caseUrl ?? null,
                  mailThreadId: input.mailThreadId ?? null,
                },
                true,
              )
        if (row === undefined) return null
        const reportChanged = await applyReportSuccess(
          tx,
          row.report_id,
          input.note,
          input.actorId ?? null,
        )
        await insertEvidence(tx, row.id, input.evidence)
        if (input.audit !== undefined) await insertAuditRow(tx, input.audit)
        return { filing: toFiling(row), reportChanged }
      })
    },

    async claim(id, attempt) {
      const [row] = await sql<{ run_id: string }[]>`
        UPDATE report_filings
        SET status = 'running', attempts = ${attempt}, run_id = gen_random_uuid(), updated_at = now()
        WHERE id = ${id} AND status = 'queued' AND attempts = ${attempt - 1}
        RETURNING run_id
      `
      return row === undefined ? null : { runId: row.run_id }
    },

    async list(args) {
      const limit = clampPageLimit(args.limit, FILING_LIST_DEFAULT_LIMIT, FILING_LIST_MAX_LIMIT)
      const anchor = parseKeysetCursor(args.cursor)
      const cursorFilter =
        anchor === null
          ? sql``
          : sql`AND ${keysetPredicate(sql, sql`f.updated_at`, sql`f.id`, anchor)}`
      const rows = await sql<
        (FilingRow & {
          report_title: string | null
          reference_code: string | null
          cursor_at: string
        })[]
      >`
        SELECT f.*, j.name AS jurisdiction_name, r.title AS report_title, r.reference_code,
               ${keysetInstant(sql, sql`f.updated_at`)} AS cursor_at
        FROM report_filings f
        JOIN reports r ON r.id = f.report_id
        LEFT JOIN jurisdictions j ON j.geoid = f.geoid
        WHERE f.status = ANY(${[...FILING_GROUP_STATUSES[args.group]]}::text[])
          ${cursorFilter}
        ORDER BY f.updated_at DESC, f.id DESC
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return {
        records: items.map((r) => ({
          ...toFiling(r),
          reportTitle: r.report_title,
          referenceCode: r.reference_code,
        })),
        nextCursor,
      }
    },

    async countGroups() {
      const [row] = await sql<{ needs_human: number; in_progress: number }[]>`
        SELECT
          count(*) FILTER (WHERE status = 'needs_human')::int AS needs_human,
          count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS in_progress
        FROM report_filings
        WHERE status IN ('needs_human', 'queued', 'running')
      `
      return { needs_human: row?.needs_human ?? 0, in_progress: row?.in_progress ?? 0 }
    },

    async listDueQueued(args) {
      const limit = clampPageLimit(args.limit, FILING_DUE_MAX_LIMIT, FILING_DUE_MAX_LIMIT)
      const oldEnough =
        args.updatedBefore === null ? sql`` : sql`AND f.updated_at <= ${args.updatedBefore}`
      const rows = await sql<FilingRow[]>`
        ${selectFilings(sql)}
        WHERE f.status = 'queued'
          AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ${args.now})
          ${oldEnough}
          AND f.channel = ANY(${[...args.channels]}::text[])
        ORDER BY f.created_at, f.id
        LIMIT ${limit}
      `
      return rows.map(toFiling)
    },

    async listRunningFilings() {
      const rows = await sql<{ id: string; attempts: number; run_id: string | null }[]>`
        SELECT id, attempts, run_id FROM report_filings
        WHERE status = 'running'
        ORDER BY updated_at, id
        LIMIT ${FILING_RUNNING_MAX}
      `
      return rows.map((r) => ({ id: r.id, attempts: r.attempts, runId: r.run_id }))
    },

    getLatestByMailThread(threadId) {
      return oneFiling(sql`
        WHERE f.mail_thread_id = ${threadId}
        ORDER BY f.created_at DESC, f.id DESC
      `)
    },

    async listEvidence(filingId) {
      const rows = await sql<EvidenceRow[]>`
        SELECT id, filing_id, r2_key, kind, label, created_at
        FROM filing_evidence
        WHERE filing_id = ${filingId}
        ORDER BY created_at, id
        LIMIT ${FILING_EVIDENCE_MAX}
      `
      return rows.map((r): FilingEvidenceRecord => ({
        id: r.id,
        filingId: r.filing_id,
        r2Key: r.r2_key,
        kind: r.kind,
        label: r.label,
        createdAt: r.created_at,
      }))
    },

    listRoutes(geoid) {
      return listRoutesIn(sql, geoid)
    },

    async findRoutes(geoid, category) {
      const rows = await sql<RouteRow[]>`
        SELECT geoid, category, channel, form_url, request_type_hint, include_link,
               status_sender_domains, enabled, updated_at, updated_by
        FROM filing_routes
        WHERE geoid = ${geoid} AND (category = ${category} OR category IS NULL)
        ORDER BY category NULLS LAST
        LIMIT 2
      `
      return rows.map(toRoute)
    },

    async replaceRoutes(geoid, routes, audit) {
      if (routes.length > FILING_ROUTES_MAX) {
        throw new Error(`replaceRoutes: over ${FILING_ROUTES_MAX} routes`)
      }
      const rows = routes.map((r) => ({
        category: r.category,
        channel: r.channel,
        form_url: r.formUrl ?? null,
        request_type_hint: r.requestTypeHint ?? null,
        include_link: r.includeLink ?? true,
        status_sender_domains: [...(r.statusSenderDomains ?? [])],
        enabled: r.enabled ?? true,
      }))
      return sql.begin(async (tx) => {
        await tx`DELETE FROM filing_routes WHERE geoid = ${geoid}`
        await tx`
          INSERT INTO filing_routes (
            geoid, category, channel, form_url, request_type_hint, include_link,
            status_sender_domains, enabled, updated_by
          )
          SELECT ${geoid}, r.category, r.channel, r.form_url, r.request_type_hint, r.include_link,
                 r.status_sender_domains, r.enabled, ${audit?.actorId ?? null}::uuid
          FROM jsonb_to_recordset(${tx.json(rows)}) AS r(
            category text, channel text, form_url text, request_type_hint text,
            include_link boolean, status_sender_domains text[], enabled boolean
          )
        `
        if (audit !== undefined) await insertAuditRow(tx, audit)
        return listRoutesIn(tx, geoid)
      })
    },

    async routeHealth(geoid) {
      const rows = await sql<
        {
          route_category: string | null
          last_filed_at: Date | null
          last_failed_at: Date | null
          script_version: string | null
        }[]
      >`
        SELECT
          route_category,
          max(submitted_at) FILTER (WHERE status IN ('submitted', 'linked_existing'))
            AS last_filed_at,
          max(updated_at) FILTER (WHERE status = 'needs_human') AS last_failed_at,
          (array_agg(script_version ORDER BY updated_at DESC, id DESC)
            FILTER (WHERE script_version IS NOT NULL))[1] AS script_version
        FROM report_filings
        WHERE geoid = ${geoid}
        GROUP BY route_category
        ORDER BY route_category NULLS FIRST
        LIMIT ${FILING_ROUTES_MAX}
      `
      return rows.map((r) => ({
        routeCategory: r.route_category,
        lastFiledAt: r.last_filed_at,
        lastFailedAt: r.last_failed_at,
        scriptVersion: r.script_version,
      }))
    },

    async getSettings() {
      const [row] = await sql<FilingSettingsRow[]>`
        SELECT paused, updated_at, updated_by FROM filing_settings WHERE id = 1
      `
      return toSettings(row)
    },

    async setPaused(paused, audit) {
      return sql.begin(async (tx) => {
        const [row] = await tx<FilingSettingsRow[]>`
          UPDATE filing_settings
          SET paused = ${paused}, updated_at = now(), updated_by = ${audit?.actorId ?? null}
          WHERE id = 1
          RETURNING paused, updated_at, updated_by
        `
        if (audit !== undefined) await insertAuditRow(tx, audit)
        return toSettings(row)
      })
    },

    async insertMessageIfAbsent(input) {
      const [row] = await sql<MessageRow[]>`
        INSERT INTO filing_messages (filing_id, inbound_email_id, mail_message_id, trusted)
        VALUES (
          ${input.filingId}, ${input.inboundEmailId ?? null}, ${input.mailMessageId ?? null},
          ${input.trusted}
        )
        ON CONFLICT DO NOTHING
        RETURNING ${MESSAGE_COLUMNS(sql)}
      `
      return row === undefined ? null : toMessage(row)
    },

    async getMessageByInboundEmailId(inboundEmailId) {
      const [row] = await sql<MessageRow[]>`
        SELECT ${MESSAGE_COLUMNS(sql)} FROM filing_messages
        WHERE inbound_email_id = ${inboundEmailId}
        LIMIT 1
      `
      return row === undefined ? null : toMessage(row)
    },

    async getMessageByMailMessageId(mailMessageId) {
      const [row] = await sql<MessageRow[]>`
        SELECT ${MESSAGE_COLUMNS(sql)} FROM filing_messages
        WHERE mail_message_id = ${mailMessageId}
        LIMIT 1
      `
      return row === undefined ? null : toMessage(row)
    },

    async flagMessage(id) {
      await sql`UPDATE filing_messages SET flagged = true WHERE id = ${id}`
    },

    async findByCaseIds(tokens) {
      if (tokens.length > FILING_CASE_TOKENS_MAX) {
        throw new Error(`findByCaseIds: over ${FILING_CASE_TOKENS_MAX} tokens`)
      }
      if (tokens.length === 0) return []
      const rows = await sql<FilingRow[]>`
        ${selectFilings(sql)}
        WHERE f.case_id = ANY(${[...tokens]}::text[])
          AND f.status IN ('submitted', 'linked_existing')
          AND f.submitted_at >= now() - ${FILING_CASE_WINDOW_DAYS} * interval '1 day'
        ORDER BY f.submitted_at DESC, f.id DESC
        LIMIT ${FILING_CASE_MATCH_MAX}
      `
      return rows.map(toFiling)
    },
  }
}

interface FilingSettingsRow {
  paused: boolean
  updated_at: Date
  updated_by: string | null
}

function toSettings(row: FilingSettingsRow | undefined): FilingSettingsRecord {
  if (row === undefined) throw new Error("filing_settings row is missing (0196 seeds it)")
  return { paused: row.paused, updatedAt: row.updated_at, updatedBy: row.updated_by }
}
