import { REPORT_CATEGORY_LABELS } from "@civfix/shared"
import type { JurisdictionDirectoryDTO, ReportCategory } from "@civfix/shared"
import { ADMIN_CATEGORIES } from "./category-counts.js"
import { UNMAPPED_GEOID, UNMAPPED_NAME } from "./jurisdiction-contacts-types.js"
import type {
  JurisdictionDirectoryRecord,
  ListDirectoryArgs,
  SaveContactsInput,
} from "./jurisdiction-contacts-repository.js"

export function coverageLabel(record: JurisdictionDirectoryRecord): string {
  const covered = new Set(
    record.categoryContacts
      .filter((c) => c.email !== null && c.email.trim() !== "")
      .map((c) => c.category),
  )
  const hasDefault = record.hasDefaultContact || record.defaultEmails.some((e) => e.trim() !== "")
  if (hasDefault || covered.size === ADMIN_CATEGORIES.length) return "All categories"
  if (covered.size === 0) return "No routing"
  // ADMIN_CATEGORIES derives from the contract enum, so a new category appears here with no edit.
  return ADMIN_CATEGORIES.filter((c) => covered.has(c))
    .map((c) => REPORT_CATEGORY_LABELS[c])
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

export function directoryStatus(
  record: JurisdictionDirectoryRecord,
): "verified" | "pending" | "bounced" {
  if (record.bounced) return "bounced"
  if (record.contactUpdatedAt !== null && directoryMethod(record) !== "none") return "verified"
  return "pending"
}

function primaryEmail(record: JurisdictionDirectoryRecord): string | null {
  const def = record.defaultEmails.find((e) => e.trim() !== "")
  if (def) return def
  const cat = record.categoryContacts.find((c) => c.email !== null && c.email.trim() !== "")
  return cat?.email ?? null
}

/** The server-side "Save & route" precondition. */
export function hasAnyContact(input: SaveContactsInput): boolean {
  if (input.defaultEmails.some((e) => e.trim() !== "")) return true
  if (input.formUrl !== null && input.formUrl.trim() !== "") return true
  return Object.values(input.contacts).some((e) => e !== null && e !== undefined && e.trim() !== "")
}

/**
 * `layer` is a placeholder: the admin special-cases UNMAPPED_GEOID and never renders the type chip or
 * routing controls for it.
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
    oldestReportAt: null,
    lastRoutedAt: null,
    bounced: false,
    contactUpdatedAt: null,
    flaggedAt: null,
    handle: null,
    forwardSubjectTemplate: null,
    forwardBodyTemplate: null,
  }
}

/**
 * The row has no real jurisdiction type, so a type filter excludes it, and its method is "none", so only
 * the all and none facets match it. The caller still suppresses it when its waiting total is 0.
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

export function toDirectoryDTO(record: JurisdictionDirectoryRecord): JurisdictionDirectoryDTO {
  return {
    geoid: record.geoid,
    org: record.name,
    // Department is not modeled separately; the jurisdiction is shown as the org.
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
    oldestReportAt: record.oldestReportAt?.toISOString() ?? null,
    perCategoryCounts: record.perCategoryCounts,
    // The DTO's contract is email-or-null, never "".
    contacts: record.categoryContacts.map((c) => ({
      category: c.category,
      email: c.email !== null && c.email.trim() !== "" ? c.email : null,
    })),
    flaggedAt: record.flaggedAt !== null ? record.flaggedAt.toISOString() : null,
    handle: record.handle,
    forwardSubjectTemplate: record.forwardSubjectTemplate,
    forwardBodyTemplate: record.forwardBodyTemplate,
  }
}
