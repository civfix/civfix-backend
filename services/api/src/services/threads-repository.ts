import type { TimeCursor } from "../db/cursor-helpers.js"

export interface ThreadAggregate {
  cleanupId: string
  title: string
  joinedAt: Date
  members: number
  unread?: number
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
}

export interface ThreadsRepository {
  listThreadsFor(
    userId: string,
    limit: number,
    cursor?: TimeCursor | null,
  ): Promise<ThreadAggregate[]>
  countUnread(cleanupId: string, userId: string, after: Date): Promise<number>
}
