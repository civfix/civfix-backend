import type { ActivityKind } from "@civfix/shared"

export type ActivitySource = "audit" | "report" | "cleanup" | "mail_event"

export interface ActivitySourceRecord {
  source: ActivitySource
  id: string
  ts: Date
  who: string
  where: string
  action?: string | null
  eventType?: string | null
  subject?: string | null
}

export type ActivityFilter = "all" | ActivityKind

export type ActivitySort = "newest" | "oldest"

export interface ListActivityArgs {
  q: string | null
  filter: ActivityFilter
  sort: ActivitySort
  cursor: string | null
  limit: number
}

export interface ActivityRepository {
  list(
    args: ListActivityArgs,
  ): Promise<{ records: ActivitySourceRecord[]; nextCursor: string | null }>
}
