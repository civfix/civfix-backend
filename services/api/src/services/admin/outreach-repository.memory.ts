import { randomUUID } from "node:crypto"
import {
  OUTREACH_CATEGORIES,
  type OutreachDigest,
  type OutreachRepository,
} from "./outreach-service.js"
import type { OutreachStateRecord } from "./mail-repository.js"
import type { ReportCategory } from "@civfix/shared"

interface SeededOutreachJurisdiction {
  geoid: string
  org: string | null
  defaultEmail: string | null
  categoryContacts: Map<ReportCategory, string | null>
  legacyEmails: string[]
}

interface SeededOutreachReport {
  id: string
  geoid: string
  category: ReportCategory
  status: string
  deletedAt: Date | null
  createdAt: Date
}

const CLOSED = new Set(["rejected", "resolved"])

export class InMemoryOutreachRepository implements OutreachRepository {
  readonly jurisdictions = new Map<string, SeededOutreachJurisdiction>()
  readonly reports: SeededOutreachReport[] = []

  readonly outreach: Map<string, OutreachStateRecord> | null

  readonly claimOutreachWindow?: (
    geoid: string,
    window: { at: Date; windowStart: Date },
  ) => Promise<boolean>

  constructor(sharedOutreach?: Map<string, OutreachStateRecord>) {
    this.outreach = sharedOutreach ?? null
    if (sharedOutreach) {
      this.claimOutreachWindow = (geoid, window) => {
        const existing = sharedOutreach.get(geoid)
        if (existing === undefined) {
          sharedOutreach.set(geoid, { geoid, lastOutreachAt: window.at, suppressed: false })
          return Promise.resolve(true)
        }
        const eligible =
          !existing.suppressed &&
          (existing.lastOutreachAt === null ||
            existing.lastOutreachAt.getTime() < window.windowStart.getTime())
        if (!eligible) return Promise.resolve(false)
        sharedOutreach.set(geoid, { ...existing, lastOutreachAt: window.at })
        return Promise.resolve(true)
      }
    }
  }

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

  listCandidateGeoids(limit?: number): Promise<string[]> {
    const out: string[] = []
    for (const j of this.jurisdictions.values()) {
      if (resolveContact(j) === null) continue
      if (this.outreach?.get(j.geoid)?.suppressed) continue
      const hasWaiting = this.reports.some(
        (r) => r.geoid === j.geoid && r.deletedAt === null && !CLOSED.has(r.status),
      )
      if (hasWaiting) out.push(j.geoid)
    }
    const lastAt = (geoid: string): number | null =>
      this.outreach?.get(geoid)?.lastOutreachAt?.getTime() ?? null
    out.sort((a, b) => {
      const ta = lastAt(a)
      const tb = lastAt(b)
      if (ta === null && tb === null) return a < b ? -1 : a > b ? 1 : 0
      if (ta === null) return -1
      if (tb === null) return 1
      if (ta !== tb) return ta - tb
      return a < b ? -1 : a > b ? 1 : 0
    })
    const capped = limit !== undefined && limit > 0 ? out.slice(0, limit) : out
    return Promise.resolve(capped)
  }
}

function resolveContact(j: SeededOutreachJurisdiction): string | null {
  if (j.defaultEmail && j.defaultEmail.trim() !== "") return j.defaultEmail.trim()
  for (const category of OUTREACH_CATEGORIES) {
    const email = j.categoryContacts.get(category)
    if (email && email.trim() !== "") return email.trim()
  }
  const legacy = j.legacyEmails.find((e) => e.trim() !== "")
  return legacy ? legacy.trim() : null
}
