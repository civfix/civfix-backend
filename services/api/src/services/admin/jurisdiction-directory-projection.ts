import type { JurisdictionDirectoryDTO, ReportCategory } from "@civfix/shared"
import {
  UNMAPPED_GEOID,
  UNMAPPED_NAME,
  type JurisdictionDirectoryRecord,
  type ListDirectoryArgs,
  type SaveContactsInput,
} from "./jurisdiction-contacts-types.js"

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  trash: "Trash",
  recycling: "Recycling",
  graffiti: "Graffiti",
  hazard: "Hazard",
  water: "Water",
  other: "Other",
}

const ALL_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
]

/**
 * Derive the directory coverage label from the contact posture: "All categories" when a default contact
 * covers everything (or every category has a contact), the comma-joined category labels when only some
 * categories are covered, or "No routing" when nothing is on file.
 */
export function coverageLabel(record: JurisdictionDirectoryRecord): string {
  const covered = new Set(
    record.categoryContacts.filter((c) => c.email !== null && c.email.trim() !== "").map((c) => c.category),
  )
  const hasDefault = record.hasDefaultContact || record.defaultEmails.some((e) => e.trim() !== "")
  if (hasDefault || covered.size === ALL_CATEGORIES.length) return "All categories"
  if (covered.size === 0) return "No routing"
  return ALL_CATEGORIES.filter((c) => covered.has(c))
    .map((c) => CATEGORY_LABELS[c])
    .join(", ")
}

export function directoryMethod(record: JurisdictionDirectoryRecord): "email" | "form" | "none" {
  const hasEmail =
    record.defaultEmails.some((e) => e.trim() !== "") ||
    record.categoryContacts.some((c) => c.email !== null && c.email.trim() !== "")
  if (hasEmail) return "email"
  if (record.reportFormUrl !== null && record.reportFormUrl.trim() !== "") return "form"
  return "none"
}

export function directoryStatus(record: JurisdictionDirectoryRecord): "verified" | "pending" | "bounced" {
  if (record.bounced) return "bounced"
  if (record.contactUpdatedAt !== null && directoryMethod(record) !== "none") return "verified"
  return "pending"
}

/** The primary directory email (first non-empty default, else the first category email, else null). */
export function primaryEmail(record: JurisdictionDirectoryRecord): string | null {
  const def = record.defaultEmails.find((e) => e.trim() !== "")
  if (def) return def
  const cat = record.categoryContacts.find((c) => c.email !== null && c.email.trim() !== "")
  return cat?.email ?? null
}

/** Whether at least one contact field is filled (the server-side "Save & route" precondition). */
export function hasAnyContact(input: SaveContactsInput): boolean {
  if (input.defaultEmails.some((e) => e.trim() !== "")) return true
  if (input.formUrl !== null && input.formUrl.trim() !== "") return true
  return Object.values(input.contacts).some((e) => e !== null && e !== undefined && e.trim() !== "")
}

/**
 * Build the synthetic "Unmapped / Unknown jurisdiction" directory record from the waiting-report totals
 * (see UNMAPPED_GEOID). `layer` is a placeholder ("place"); the admin special-cases UNMAPPED_GEOID and
 * never renders the type chip / routing controls for it. It always reads as method "none".
 */
export function buildUnmappedRecord(
  total: number,
  perCategoryCounts: Partial<Record<ReportCategory, number>>,
): JurisdictionDirectoryRecord {
  return {
    geoid: UNMAPPED_GEOID,
    name: UNMAPPED_NAME,
    layer: "place",
    population: null,
    defaultEmails: [],
    categoryContacts: [],
    hasDefaultContact: false,
    reportFormUrl: null,
    reportsWaiting: total,
    perCategoryCounts,
    lastRoutedAt: null,
    bounced: false,
    contactUpdatedAt: null,
    flaggedAt: null,
    handle: null,
  }
}

/**
 * Whether the synthetic unmapped row should be included for these list args: only on the FIRST page (no
 * cursor), never under a type (layer) filter (it has no real jurisdiction type — it's layer-less triage),
 * only under a facet a contact-less row matches (all | none — its method is "none"), and only when a
 * search term, if present, matches its name/geoid. The caller still suppresses it when its waiting total
 * is 0.
 */
export function shouldIncludeUnmapped(args: ListDirectoryArgs): boolean {
  if (args.cursor !== null) return false
  if (args.layer !== null) return false
  if (args.filter !== "all" && args.filter !== "none") return false
  if (args.q !== null) {
    const q = args.q.toLowerCase()
    return UNMAPPED_NAME.toLowerCase().includes(q) || UNMAPPED_GEOID.includes(q)
  }
  return true
}

/** Project a directory record into the wire DTO (org/dept/email/form/method/status/coverage/lastRouted). */
export function toDirectoryDTO(record: JurisdictionDirectoryRecord): JurisdictionDirectoryDTO {
  return {
    geoid: record.geoid,
    org: record.name,
    // Department is not modeled separately in Phase 2; the directory shows the jurisdiction as the org.
    dept: null,
    email: primaryEmail(record),
    form: record.reportFormUrl,
    method: directoryMethod(record),
    status: directoryStatus(record),
    coverage: coverageLabel(record),
    lastRouted: record.lastRoutedAt !== null ? record.lastRoutedAt.toISOString() : null,
    layer: record.layer,
    population: record.population ?? 0,
    reportsWaiting: record.reportsWaiting,
    perCategoryCounts: record.perCategoryCounts,
    // Drop empty-string emails to null so they satisfy the DTO's email-or-null contract.
    contacts: record.categoryContacts.map((c) => ({
      category: c.category,
      email: c.email !== null && c.email.trim() !== "" ? c.email : null,
    })),
    flaggedAt: record.flaggedAt !== null ? record.flaggedAt.toISOString() : null,
    handle: record.handle,
  }
}
