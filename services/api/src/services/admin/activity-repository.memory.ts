/**
 * In-memory ActivityRepository for the offline activity-service unit tests (no DB, no Docker).
 *
 * Faithful to the Drizzle impl's observable behavior: it merges all seeded source records, drops the L4
 * read audits the SQL branch excludes, applies the same search / kind facet / direction, and keyset-pages
 * on (ts, id) through the shared pageInMemoryById helper so the cursor STRINGS match the Drizzle impl for
 * the same page. seedRecord appends a normalized source record; the public `records` array is inspectable.
 *
 * The kind facet is evaluated by CLASSIFYING each record (classifyActivity) rather than by re-deriving the
 * action prefixes — the fake is allowed the round trip the SQL branch cannot afford, and it is the sharper
 * test of the two: it fails if the repo's SQL predicate and the service's classifier ever disagree.
 */

import { AUDIT_READ_ACTIONS } from "./audit.js"
import { pageInMemoryById } from "./pagination.js"
import {
  classifyActivity,
  type ActivityRepository,
  type ActivitySourceRecord,
  type ListActivityArgs,
} from "./activity-service.js"

/** The excluded read-audit actions as a set (the SQL branch's `action <> ALL(...)`, in memory). */
const READ_ACTIONS: ReadonlySet<string> = new Set(AUDIT_READ_ACTIONS)

/** The columns the SQL branches search, flattened into the text a record contributes to `q`. */
function searchText(record: ActivitySourceRecord): string {
  return [record.who, record.where, record.action ?? "", record.eventType ?? "", record.subject ?? ""]
    .join(" ")
    .toLowerCase()
}

export class InMemoryActivityRepository implements ActivityRepository {
  /** All seeded source records (insertion order; list() sorts a copy). */
  readonly records: ActivitySourceRecord[] = []

  /** Append a normalized source record. */
  seedRecord(record: ActivitySourceRecord): ActivitySourceRecord {
    this.records.push(record)
    return record
  }

  async list(
    args: ListActivityArgs,
  ): Promise<{ records: ActivitySourceRecord[]; nextCursor: string | null }> {
    // The classification reference clock is irrelevant here: only `kind` is read, and no kind depends on
    // the relative-age label.
    const ref = new Date(0)
    const needle = args.q === null ? null : args.q.toLowerCase()
    const feedable = this.records.filter((r) => {
      if (r.source === "audit" && READ_ACTIONS.has(r.action ?? "")) return false
      if (needle !== null && !searchText(r).includes(needle)) return false
      if (args.filter !== "all" && classifyActivity(r, ref).kind !== args.filter) return false
      return true
    })
    const dir = args.sort === "newest" ? -1 : 1
    const sorted = [...feedable].sort((a, b) => {
      const byTs = (a.ts.getTime() - b.ts.getTime()) * dir
      // The same (ts, id) TOTAL order the SQL keyset uses, so a page boundary lands identically.
      return byTs !== 0 ? byTs : a.id < b.id ? dir : a.id > b.id ? -dir : 0
    })
    return pageInMemoryById(sorted, args.cursor, args.limit, (r) => ({ createdAt: r.ts, id: r.id }))
  }
}
