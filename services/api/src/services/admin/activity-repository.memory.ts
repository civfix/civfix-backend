/**
 * Mirrors the Drizzle impl's observable behavior. Cursors share its format but not its precision: the
 * Drizzle cursor carries microseconds a JS Date cannot hold.
 *
 * The kind facet classifies each record (classifyActivity) rather than re-deriving the action prefixes.
 * The fake can afford the round trip the SQL cannot, and it makes tests fail if the repo's SQL predicate
 * and the service's classifier ever disagree.
 */

import { AUDIT_READ_ACTIONS } from "./audit.js"
import { pageInMemoryById } from "./pagination.js"
import { classifyActivity } from "./activity-service.js"
import type {
  ActivityRepository,
  ActivitySourceRecord,
  ListActivityArgs,
} from "./activity-repository.js"

const READ_ACTIONS: ReadonlySet<string> = new Set(AUDIT_READ_ACTIONS)

function searchText(record: ActivitySourceRecord): string {
  return [
    record.who,
    record.where,
    record.action ?? "",
    record.eventType ?? "",
    record.subject ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

export class InMemoryActivityRepository implements ActivityRepository {
  readonly records: ActivitySourceRecord[] = []

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
      // The same (ts, id) total order the SQL keyset uses, so a page boundary lands identically.
      return byTs !== 0 ? byTs : a.id < b.id ? dir : a.id > b.id ? -dir : 0
    })
    return pageInMemoryById(sorted, args.cursor, args.limit, (r) => ({ at: r.ts, id: r.id }))
  }
}
