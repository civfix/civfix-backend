/**
 * In-memory ActivityRepository for the offline activity-service unit tests (no DB, no Docker).
 *
 * Faithful to the Drizzle impl's observable behavior: it merges all seeded source records, sorts them
 * newest-first by ts, and returns the first `limit`. seedRecord appends a normalized source record; the
 * public `records` array is inspectable.
 */

import type {
  ActivityRepository,
  ActivitySourceRecord,
} from "./activity-service.js"

export class InMemoryActivityRepository implements ActivityRepository {
  /** All seeded source records (insertion order; recent() sorts a copy newest-first). */
  readonly records: ActivitySourceRecord[] = []

  /** Append a normalized source record. */
  seedRecord(record: ActivitySourceRecord): ActivitySourceRecord {
    this.records.push(record)
    return record
  }

  async recent(limit: number): Promise<ActivitySourceRecord[]> {
    const sorted = [...this.records].sort((a, b) => b.ts.getTime() - a.ts.getTime())
    return sorted.slice(0, limit)
  }
}
