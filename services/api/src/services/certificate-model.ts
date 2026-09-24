import { createHash } from "node:crypto"
import { MAX_CERTIFICATE_ENTRIES } from "@civfix/shared"
import type { VolunteerHoursSource } from "@civfix/shared"
import { resolveLocale } from "../i18n/locales.js"
import { renderMessage, type MessageKey } from "../i18n/renderMessage.js"

export const CERTIFICATE_TIME_ZONE = "America/Los_Angeles"

export const CERTIFICATE_MESSAGE_KEYS = [
  "certificate.doc.title",
  "certificate.doc.pdf_title",
  "certificate.header.number",
  "certificate.holder.eyebrow",
  "certificate.holder.period",
  "certificate.holder.issued",
  "certificate.summary.total_hours",
  "certificate.summary.activities",
  "certificate.summary.communities",
  "certificate.summary.more",
  "certificate.table.date",
  "certificate.table.activity",
  "certificate.table.community",
  "certificate.table.hours",
  "certificate.table.credited_by",
  "certificate.table.total",
  "certificate.table.truncated",
  "certificate.credited_by.automatic",
  "certificate.activity.report",
  "certificate.activity.manual",
  "certificate.attestation.body",
  "certificate.seal.line",
  "certificate.issuer.line",
  "certificate.issuer.generated",
  "certificate.verify.prompt",
  "certificate.verify.fingerprint",
  "certificate.footer.page",
  "certificate.footer.timezone",
  "certificate.error.no_hours",
] as const

export type CertificateMessageKey = (typeof CERTIFICATE_MESSAGE_KEYS)[number]

export type CertificateTranslator = (
  key: CertificateMessageKey,
  vars?: Record<string, string | number>,
) => string

export function certificateTranslator(locale: unknown): CertificateTranslator {
  const resolved = resolveLocale(locale)
  return (key, vars) => renderMessage(resolved, key as unknown as MessageKey, vars)
}

export interface TranscriptLedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  occurredAt: Date | string
  eventTitle?: string | null
  eventReferenceCode?: string | null
  reportReferenceCode?: string | null
  jurisdictionName?: string | null
  creditedByName?: string | null
}

export interface TranscriptHolder {
  userId: string
  displayName: string
  handle: string | null
}

export interface TranscriptModelRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  occurredAt: string
  dateLabel: string
  activity: string
  community: string
  creditedBy: string
}

export interface TranscriptModel {
  v: 1
  locale: string
  holder: TranscriptHolder
  rows: TranscriptModelRow[]
  entryCount: number
  includedCount: number
  truncated: boolean
  totalHours: number
  periodStart: string | null
  periodEnd: string | null
  jurisdictions: string[]
}

export interface BuildTranscriptModelInput {
  holder: TranscriptHolder
  rows: TranscriptLedgerRow[]
  totals?: { entryCount: number; totalHours: number }
  locale: string
  t?: CertificateTranslator
}

// An en dash, not a hyphen: it reads as "no value" in print and matches the period range glyph.
export const EMPTY_VALUE = "–"

const COMMUNITIES_NAMED_ON_TILE = 2

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: CERTIFICATE_TIME_ZONE,
  }).format(new Date(iso))
}

function activityLabel(row: TranscriptLedgerRow, t: CertificateTranslator): string {
  switch (row.source) {
    case "report":
      return t("certificate.activity.report", { ref: row.reportReferenceCode ?? "" }).trim()
    case "manual":
      return t("certificate.activity.manual")
    case "event":
      return row.eventTitle?.trim() || row.eventReferenceCode?.trim() || EMPTY_VALUE
  }
}

function creditedByLabel(row: TranscriptLedgerRow, t: CertificateTranslator): string {
  if (row.source === "report") return t("certificate.credited_by.automatic")
  return row.creditedByName?.trim() || t("certificate.credited_by.automatic")
}

export function buildTranscriptModel(input: BuildTranscriptModelInput): TranscriptModel {
  const locale = resolveLocale(input.locale)
  const t = input.t ?? certificateTranslator(locale)

  const sorted = [...input.rows].sort((a, b) => {
    const at = toIso(a.occurredAt)
    const bt = toIso(b.occurredAt)
    if (at !== bt) return at < bt ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const overCap = sorted.length > MAX_CERTIFICATE_ENTRIES
  const included = overCap ? sorted.slice(sorted.length - MAX_CERTIFICATE_ENTRIES) : sorted

  const rows: TranscriptModelRow[] = included.map((row) => {
    const occurredAt = toIso(row.occurredAt)
    const community = row.jurisdictionName?.trim() || EMPTY_VALUE
    return {
      id: row.id,
      source: row.source,
      hours: round2(row.hours),
      occurredAt,
      dateLabel: formatDate(occurredAt, locale),
      activity: activityLabel(row, t),
      community,
      creditedBy: creditedByLabel(row, t),
    }
  })

  const jurisdictions: string[] = []
  for (const row of rows) {
    if (row.community !== EMPTY_VALUE && !jurisdictions.includes(row.community)) {
      jurisdictions.push(row.community)
    }
  }

  const entryCount = input.totals?.entryCount ?? sorted.length
  const totalHours = round2(
    input.totals?.totalHours ?? sorted.reduce((sum, row) => sum + row.hours, 0),
  )
  const truncated = overCap || entryCount > rows.length

  return {
    v: 1,
    locale,
    holder: input.holder,
    rows,
    entryCount,
    includedCount: rows.length,
    truncated,
    totalHours,
    periodStart: rows[0]?.occurredAt ?? null,
    periodEnd: rows[rows.length - 1]?.occurredAt ?? null,
    jurisdictions,
  }
}

export function communitiesLabel(
  jurisdictions: readonly string[],
  t: CertificateTranslator,
): string {
  const shown = jurisdictions.slice(0, COMMUNITIES_NAMED_ON_TILE).join(", ")
  const extra = jurisdictions.length - COMMUNITIES_NAMED_ON_TILE
  if (extra <= 0) return shown
  return `${shown} ${t("certificate.summary.more", { count: extra })}`.trim()
}

export function ledgerFingerprint(model: TranscriptModel): string {
  const basis = JSON.stringify({
    v: 1,
    userId: model.holder.userId,
    locale: model.locale,
    name: model.holder.displayName,
    handle: model.holder.handle,
    total: model.totalHours.toFixed(2),
    count: model.entryCount,
    rows: model.rows.map((row) => [row.id, row.hours.toFixed(2), row.occurredAt]),
  })
  return createHash("sha256").update(basis).digest("hex")
}
