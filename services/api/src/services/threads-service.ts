/**
 * Threads service: the viewer's cleanup chat threads as MessageThreadDTO (the "Messages" list).
 *
 * A thread is one cleanup the viewer is a member of. For each, the service projects:
 *   - title      the cleanup title;
 *   - last       the most-recent message's body preview (null when the room has no messages yet);
 *   - ago        a short relative-time string for that last message ("just now", "5m", "2h", "3d");
 *   - lastFromMe whether the most-recent message was sent by the viewer (drives the "You:" prefix);
 *   - members    the cleanup member count;
 *   - unread     count of messages from OTHERS newer than the viewer's read watermark.
 *
 * READ WATERMARK (Phase 1): the watermark is max(joined_at, lastRead). lastRead comes from an injected
 * ChatReadState store updated by the WS `ack` frame. In Phase 1 the store is process-local (no
 * cleanup_members.last_read_at column yet), so unread resets to "since you joined" on restart; this is a
 * deliberate, documented limitation. unread NEVER counts the viewer's own messages (you cannot be
 * "unread" on what you wrote).
 *
 * All DB access sits behind the ThreadsRepository seam (Drizzle impl + in-memory test impl), so the
 * service is unit-testable with no database.
 */

import type { MessageThreadDTO } from "@civfix/shared"

// ---------------------------------------------------------------------------
// Read-state store (injectable; process-local in Phase 1)
// ---------------------------------------------------------------------------

/**
 * Per-(user, cleanup) last-read timestamp store. Shared between the WS gateway's `ack` handler (writes)
 * and the threads service (reads). The Phase 1 impl is in-memory; a later migration can back it with a
 * cleanup_members.last_read_at column behind the same interface.
 */
export interface ChatReadState {
  /** Record that `userId` has read `cleanupId` up to `at`. Monotonic: never moves the watermark back. */
  markRead(cleanupId: string, userId: string, at: Date): Promise<void>
  /** The last-read timestamp for (user, cleanup), or null when never recorded. */
  lastReadAt(cleanupId: string, userId: string): Promise<Date | null>
}

/** Default in-memory ChatReadState. Process-local; see the file header for the Phase 1 limitation. */
export class InMemoryChatReadState implements ChatReadState {
  private readonly marks = new Map<string, number>() // `${userId}:${cleanupId}` -> epoch ms

  markRead(cleanupId: string, userId: string, at: Date): Promise<void> {
    const key = `${userId}:${cleanupId}`
    const prev = this.marks.get(key) ?? 0
    if (at.getTime() > prev) this.marks.set(key, at.getTime())
    return Promise.resolve()
  }

  lastReadAt(cleanupId: string, userId: string): Promise<Date | null> {
    const ms = this.marks.get(`${userId}:${cleanupId}`)
    return Promise.resolve(ms !== undefined ? new Date(ms) : null)
  }
}

// ---------------------------------------------------------------------------
// Repository seam
// ---------------------------------------------------------------------------

/** A per-thread aggregate row the repository returns for one of the viewer's cleanups. */
export interface ThreadAggregate {
  cleanupId: string
  title: string
  /** When the viewer joined this cleanup (the unread baseline). */
  joinedAt: Date
  members: number
  /** The most-recent message, or null when the room is empty. */
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
}

/**
 * Persistence seam for threads. listThreadsFor returns the viewer's cleanups (membership) with the
 * last-message + member-count aggregates, newest-activity first. countUnread counts messages from others
 * strictly after the watermark. Both are behind this interface so the service is DB-free in tests.
 */
export interface ThreadsRepository {
  /** The viewer's cleanups as thread aggregates, ordered by most recent activity first. */
  listThreadsFor(userId: string, limit: number): Promise<ThreadAggregate[]>
  /** Count messages in `cleanupId` from senders other than `userId` with created_at > `after`. */
  countUnread(cleanupId: string, userId: string, after: Date): Promise<number>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Short relative-time label for the messages list. Pure (clock injected) so it is deterministic in
 * tests. Buckets: <60s "just now", <60m "Nm", <24h "Nh", else "Nd".
 */
export function relativeAgo(from: Date, now: Date): string {
  const secs = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000))
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Default page size for GET /threads. */
export const THREADS_DEFAULT_LIMIT = 30

export interface ThreadsServiceDeps {
  repo: ThreadsRepository
  readState: ChatReadState
  /** Injectable clock (defaults to Date.now) so `ago` is deterministic in tests. */
  now?: () => Date
}

export interface ThreadsService {
  listThreads(
    userId: string,
    limit?: number,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }>
}

export function makeThreadsService(deps: ThreadsServiceDeps): ThreadsService {
  const now = deps.now ?? (() => new Date())

  return {
    async listThreads(
      userId: string,
      limit: number = THREADS_DEFAULT_LIMIT,
    ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }> {
      const aggregates = await deps.repo.listThreadsFor(userId, limit)

      const items = await Promise.all(
        aggregates.map(async (agg): Promise<MessageThreadDTO> => {
          // Watermark = max(joinedAt, lastRead). unread counts others' messages strictly after it.
          const lastRead = await deps.readState.lastReadAt(agg.cleanupId, userId)
          const watermark =
            lastRead !== null && lastRead.getTime() > agg.joinedAt.getTime()
              ? lastRead
              : agg.joinedAt
          const unread = await deps.repo.countUnread(agg.cleanupId, userId, watermark)

          const lastFromMe = agg.last !== null && agg.last.senderId === userId

          return {
            id: agg.cleanupId,
            kind: "cleanup",
            title: agg.title,
            // last/ago are null when the room has no messages yet.
            last: agg.last !== null ? (agg.last.body ?? "") : null,
            ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
            lastFromMe,
            unread,
            members: agg.members,
          }
        }),
      )

      // Single page for Phase 1 (capped at `limit`); cursor paging can be added later.
      return { items, nextCursor: null }
    },
  }
}
