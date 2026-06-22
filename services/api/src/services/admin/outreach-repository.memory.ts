/**
 * In-memory OutreachRepository (Phase 2): the offline binding of the outreach pipeline's READ seam.
 *
 * Mirrors the Drizzle impl's observable contract so the outreach service is unit-testable with NO
 * database (no Docker):
 *   - loadDigest aggregates a geoid's waiting reports (non-deleted, still open) per category and resolves
 *     its routing contact (default -> per-category -> legacy default emails), returning null when there
 *     is nothing to send (no waiting reports or no contact);
 *   - listCandidateGeoids returns every geoid that has BOTH waiting reports and a usable contact.
 * Seed helpers (seedJurisdiction, seedReport) let tests arrange state directly.
 */

import { randomUUID } from "node:crypto"
import {
  OUTREACH_CATEGORIES,
  type OutreachDigest,
  type OutreachRepository,
} from "./outreach-service.js"
import type { ReportCategory } from "@civfix/shared"

/** A seeded jurisdiction's outreach-relevant routing posture. */
interface SeededOutreachJurisdiction {
  geoid: string
  org: string | null
  /** Category-agnostic default contact email (the digest recipient when present). */
  defaultEmail: string | null
  /** Per-category contact emails (a fallback recipient when there is no default). */
  categoryContacts: Map<ReportCategory, string | null>
  /** Legacy jurisdictions.contact_emails[] mirror (last-resort recipient). */
  legacyEmails: string[]
}

/** A seeded report (the subset the digest aggregation reads). */
interface SeededOutreachReport {
  id: string
  geoid: string
  category: ReportCategory
  status: string
  deletedAt: Date | null
  createdAt: Date
}

/** Statuses that are NOT waiting (already closed). A waiting report is open + non-deleted. */
const CLOSED = new Set(["rejected", "resolved"])

export class InMemoryOutreachRepository implements OutreachRepository {
  readonly jurisdictions = new Map<string, SeededOutreachJurisdiction>()
  readonly reports: SeededOutreachReport[] = []

  seedJurisdiction(input: {
    geoid: string
    org?: string | null
    defaultEmail?: string | null
    categoryContacts?: Partial<Record<ReportCategory, string | null>>
    legacyEmails?: string[]
  }): void {
    const categoryContacts = new Map<ReportCategory, string | null>()
    for (const [category, email] of Object.entries(input.categoryContacts ?? {}) as [
      ReportCategory,
      string | null,
    ][]) {
      categoryContacts.set(category, email)
    }
    this.jurisdictions.set(input.geoid, {
      geoid: input.geoid,
      org: input.org ?? null,
      defaultEmail: input.defaultEmail ?? null,
      categoryContacts,
      legacyEmails: input.legacyEmails ?? [],
    })
  }

  seedReport(input: {
    id?: string
    geoid: string
    category: ReportCategory
    status?: string
    deletedAt?: Date | null
    createdAt?: Date
  }): SeededOutreachReport {
    const r: SeededOutreachReport = {
      id: input.id ?? randomUUID(),
      geoid: input.geoid,
      category: input.category,
      status: input.status ?? "submitted",
      deletedAt: input.deletedAt ?? null,
      createdAt: input.createdAt ?? new Date(Date.UTC(2026, 0, 1)),
    }
    this.reports.push(r)
    return r
  }

  loadDigest(geoid: string): Promise<OutreachDigest | null> {
    const j = this.jurisdictions.get(geoid)
    if (!j) return Promise.resolve(null)
    const toAddr = resolveContact(j)
    if (toAddr === null) return Promise.resolve(null)

    const perCategory: Partial<Record<ReportCategory, number>> = {}
    let total = 0
    let oldestWaitingAt: Date | null = null
    for (const r of this.reports) {
      if (r.geoid !== geoid || r.deletedAt !== null || CLOSED.has(r.status)) continue
      perCategory[r.category] = (perCategory[r.category] ?? 0) + 1
      total += 1
      if (oldestWaitingAt === null || r.createdAt.getTime() < oldestWaitingAt.getTime()) {
        oldestWaitingAt = r.createdAt
      }
    }
    if (total === 0) return Promise.resolve(null)
    return Promise.resolve({ geoid, org: j.org, toAddr, perCategory, total, oldestWaitingAt })
  }

  listCandidateGeoids(): Promise<string[]> {
    const out: string[] = []
    for (const j of this.jurisdictions.values()) {
      if (resolveContact(j) === null) continue
      const hasWaiting = this.reports.some(
        (r) => r.geoid === j.geoid && r.deletedAt === null && !CLOSED.has(r.status),
      )
      if (hasWaiting) out.push(j.geoid)
    }
    // Deterministic order for the tests (geoid asc).
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return Promise.resolve(out)
  }
}

/**
 * Resolve a jurisdiction's routing recipient: default -> first per-category -> first legacy. The
 * per-category fallback iterates OUTREACH_CATEGORIES in canonical display order, which the Drizzle
 * loadDigest mirrors via `array_position(...)` so both bindings pick the SAME contact.
 */
function resolveContact(j: SeededOutreachJurisdiction): string | null {
  if (j.defaultEmail && j.defaultEmail.trim() !== "") return j.defaultEmail.trim()
  for (const category of OUTREACH_CATEGORIES) {
    const email = j.categoryContacts.get(category)
    if (email && email.trim() !== "") return email.trim()
  }
  const legacy = j.legacyEmails.find((e) => e.trim() !== "")
  return legacy ? legacy.trim() : null
}
