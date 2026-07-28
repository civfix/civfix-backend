/**
 * PURE render model for the service-hours transcript (P5). No I/O, no pdfkit, no DB — everything the
 * document prints is computed here, so the whole document is unit-testable without Docker or a renderer.
 *
 * The model is what gets stored in `service_hours_certificates.snapshot` (jsonb), so it must round-trip
 * through JSON unchanged: every timestamp is an ISO-8601 STRING, never a Date. (A Date field would come
 * back from the column as a string and `ledgerFingerprint` would then hash a different shape — or throw —
 * on the re-render path.)
 *
 * IMMUTABLE SNAPSHOT, NOT A VIEW: once issued, the numbers on the document are frozen. A corrected ledger
 * means a NEW certificate, which is what `ledgerFingerprint` keys.
 */

import { createHash } from "node:crypto"
import { MAX_CERTIFICATE_ENTRIES } from "@civfix/shared"
import type { VolunteerHoursSource } from "@civfix/shared"
import { resolveLocale } from "../i18n/locales.js"
import { renderMessage, type MessageKey } from "../i18n/renderMessage.js"

/**
 * The zone every printed date is rendered in. A CODE CONSTANT, not an env var: `cleanups.scheduled_at` is
 * a `timestamptz` with no stored zone, so some zone has to be chosen, and UTC would shift an evening LA
 * event onto the following calendar day and look wrong to the reader. Page 1 states it in a footnote
 * (`certificate.footer.timezone`). FOLLOW-UP: derive the zone from the event's jurisdiction.
 */
export const CERTIFICATE_TIME_ZONE = "America/Los_Angeles"

/**
 * Every chrome string the document prints. WP21 lands these keys in `src/i18n/messages/{en,es,de,ko}.ts`;
 * until then `renderMessage` falls back to the literal key by design, which is visible rather than empty.
 */
export const CERTIFICATE_MESSAGE_KEYS = [
  "certificate.doc.title",
  "certificate.doc.pdf_title",
  "certificate.header.number",
  "certificate.holder.eyebrow",
  "certificate.holder.verified",
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

/** Localizer seam. Injectable so the model + renderer stay pure and testable without the catalogs. */
export type CertificateTranslator = (
  key: CertificateMessageKey,
  vars?: Record<string, string | number>,
) => string

/**
 * The default localizer: the server message catalog for `locale`.
 *
 * The cast exists because `MessageKey` is `keyof typeof en` and the `certificate.*` block lands with WP21
 * in this same release. `renderMessage` resolves target locale -> English -> the literal key, so an
 * un-landed key renders as its own name instead of throwing or printing an empty line.
 */
export function certificateTranslator(locale: unknown): CertificateTranslator {
  const resolved = resolveLocale(locale)
  return (key, vars) => renderMessage(resolved, key as unknown as MessageKey, vars)
}

/** One credited ledger row as the certificate service reads it. */
export interface TranscriptLedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  /** When the service happened (event scheduledAt; credit time for report/manual). */
  occurredAt: Date | string
  eventTitle?: string | null
  eventReferenceCode?: string | null
  reportReferenceCode?: string | null
  jurisdictionName?: string | null
  /** Display name of the host who credited the row (`source: "event"`) or the granting operator. */
  creditedByName?: string | null
}

export interface TranscriptHolder {
  userId: string
  displayName: string
  handle: string | null
  verified: boolean
}

/** One printed table row. Every field is already localized and ready to draw. */
export interface TranscriptModelRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  /** ISO-8601 (see the module header: the model is stored as jsonb). */
  occurredAt: string
  dateLabel: string
  activity: string
  community: string
  creditedBy: string
}

export interface TranscriptModel {
  /** Snapshot schema version; bump when a stored model can no longer be re-rendered as written. */
  v: 1
  locale: string
  holder: TranscriptHolder
  rows: TranscriptModelRow[]
  /** Rows in the WHOLE ledger, which is what the summary tile and the truncation banner report. */
  entryCount: number
  /** Rows actually itemised (== `rows.length`, <= MAX_CERTIFICATE_ENTRIES). */
  includedCount: number
  truncated: boolean
  /** Total over the WHOLE ledger, to 2dp — NOT the sum of the included rows when truncated. */
  totalHours: number
  /** Min/max `occurredAt` of the INCLUDED rows (they are what the printed period describes). */
  periodStart: string | null
  periodEnd: string | null
  /** Distinct community names across the included rows, first-seen order. */
  jurisdictions: string[]
}

export interface BuildTranscriptModelInput {
  holder: TranscriptHolder
  /**
   * Ledger rows to itemise, any order. More than MAX_CERTIFICATE_ENTRIES keeps the MOST RECENT
   * MAX_CERTIFICATE_ENTRIES and sets `truncated` — refusing to issue a document to the most prolific
   * volunteers would be the wrong failure.
   */
  rows: TranscriptLedgerRow[]
  /**
   * Aggregates over the WHOLE ledger, for the caller that read only a capped page. Defaults to the
   * aggregates of `rows`. The printed totals always describe the whole ledger; the table describes the
   * included subset, and the truncation banner reconciles the two.
   */
  totals?: { entryCount: number; totalHours: number }
  locale: string
  /** Injected for tests; the default is the server catalog for `locale`. */
  t?: CertificateTranslator
}

/**
 * What an empty cell prints: a blank cell in a table of credited service reads as "data lost", an em dash
 * reads as "there is nothing here". Used for a missing community and for the (defensive) case of an event
 * row with no title.
 */
const EMPTY_CELL = "—"

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString()
}

/** 2dp, as money-like quantities are handled everywhere in the hours domain (numeric(8,2) in Postgres). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: CERTIFICATE_TIME_ZONE,
  }).format(new Date(iso))
}

/** The "Activity" column: the event title, or a localized label for the two non-event sources. */
function activityLabel(row: TranscriptLedgerRow, t: CertificateTranslator): string {
  switch (row.source) {
    case "report":
      // The report is NOT named or linked: a transcript is handed to strangers, and reports can be held,
      // unlisted or sensitive. The reference code (already public on the report) is all that is printed.
      return t("certificate.activity.report", { ref: row.reportReferenceCode ?? "" }).trim()
    case "manual":
      return t("certificate.activity.manual")
    case "event":
      // Defensive: cleanups.title is NOT NULL, so this only fires on a malformed row.
      return row.eventTitle?.trim() || row.eventReferenceCode?.trim() || EMPTY_CELL
  }
}

/**
 * The "Credited by" column. Report auto-awards are credited by the PLATFORM, never a person — saying
 * otherwise on an official document would be a fabricated attestation.
 */
function creditedByLabel(row: TranscriptLedgerRow, t: CertificateTranslator): string {
  if (row.source === "report") return t("certificate.credited_by.automatic")
  return row.creditedByName?.trim() || t("certificate.credited_by.automatic")
}

/**
 * Build the printable model. PURE: same input, same output, no clock and no I/O (the issue timestamp is
 * the renderer's input, not the model's, so re-rendering a stored snapshot reproduces this exactly).
 */
export function buildTranscriptModel(input: BuildTranscriptModelInput): TranscriptModel {
  const locale = resolveLocale(input.locale)
  const t = input.t ?? certificateTranslator(locale)

  // Ascending by occurredAt, ties broken by id, so the ordering is deterministic and the first/last rows
  // match the printed period.
  const sorted = [...input.rows].sort((a, b) => {
    const at = toIso(a.occurredAt)
    const bt = toIso(b.occurredAt)
    if (at !== bt) return at < bt ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const truncated = sorted.length > MAX_CERTIFICATE_ENTRIES
  // Keep the MOST RECENT cap rows, still printed ascending.
  const included = truncated ? sorted.slice(sorted.length - MAX_CERTIFICATE_ENTRIES) : sorted

  const rows: TranscriptModelRow[] = included.map((row) => {
    const occurredAt = toIso(row.occurredAt)
    const community = row.jurisdictionName?.trim() || EMPTY_CELL
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
    if (row.community !== EMPTY_CELL && !jurisdictions.includes(row.community)) {
      jurisdictions.push(row.community)
    }
  }

  const entryCount = input.totals?.entryCount ?? sorted.length
  const totalHours = round2(
    input.totals?.totalHours ?? sorted.reduce((sum, row) => sum + row.hours, 0),
  )

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

/**
 * The "Communities" tile's caption: up to two names, then a localized "+N more". Pure and here rather
 * than in the renderer so the pluralized tail is unit-testable without pdfkit.
 */
export function communitiesLabel(
  jurisdictions: readonly string[],
  t: CertificateTranslator,
): string {
  const shown = jurisdictions.slice(0, 2).join(", ")
  const extra = jurisdictions.length - 2
  if (extra <= 0) return shown
  return `${shown} ${t("certificate.summary.more", { count: extra })}`.trim()
}

/**
 * The idempotency key: a stable digest of exactly what the document asserts.
 *
 * `volunteer_hours.id` survives the `ON CONFLICT (cleanup_id, user_id) DO UPDATE SET hours = ...` upsert,
 * so an edited credit changes `hours` (and therefore this) while the row identity stays stable.
 *
 * The holder's name/handle/verified state and the locale are in the digest ON PURPOSE: a rename must mint
 * a new document because the old one prints the old name, and an `en` and a `ko` transcript over the same
 * ledger are two separately verifiable documents.
 *
 * Two taps => one certificate. New hours => a new certificate, and the old one stays valid, because it
 * remains a true statement about a point in time. There is deliberately no auto-supersede.
 */
export function ledgerFingerprint(model: TranscriptModel): string {
  const basis = JSON.stringify({
    v: 1,
    userId: model.holder.userId,
    locale: model.locale,
    name: model.holder.displayName,
    handle: model.holder.handle,
    verified: model.holder.verified,
    total: model.totalHours.toFixed(2),
    count: model.entryCount,
    rows: model.rows.map((row) => [row.id, row.hours.toFixed(2), row.occurredAt]),
  })
  return createHash("sha256").update(basis).digest("hex")
}
