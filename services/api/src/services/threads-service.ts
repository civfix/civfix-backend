/**
 * Threads service: the viewer's cleanup chat threads as MessageThreadDTO (the "Messages" list).
 *
 * A thread is one cleanup the viewer is a member of. For each, the service projects:
 *   - title      the cleanup title;
 *   - last       the most-recent message's body preview (null when the room has no messages yet);
 *   - ago        a short relative-time string for that last message (shared relativeAgo: "now", "5m",
 *                "2h", "3d", "2w");
 *   - lastFromMe whether the most-recent message was sent by the viewer (drives the "You:" prefix);
 *   - members    the cleanup member count;
 *   - unread     count of messages from OTHERS newer than the viewer's read watermark.
 *
 * READ WATERMARK: the watermark is max(joined_at, lastRead). In production the Drizzle repository folds
 * unread into its single listThreadsFor query, reading lastRead from the durable cleanup_members
 * .last_read_at column the WS `ack` frame stamps (one round-trip for the whole inbox, no per-thread
 * fan-out). When a repository does NOT pre-compute unread (the in-memory test impl), the service falls
 * back to an injected ChatReadState (process-local) + a per-thread countUnread, preserving identical
 * results. unread NEVER counts the viewer's own messages (you cannot be "unread" on what you wrote).
 *
 * All DB access sits behind the ThreadsRepository seam (Drizzle impl + in-memory test impl), so the
 * service is unit-testable with no database.
 */

import { relativeAgo, avatarGradient } from "@civfix/shared"
import type { MessageThreadDTO, PersonDTO } from "@civfix/shared"

// ---------------------------------------------------------------------------
// Read-state store (injectable; DB-backed in prod, in-memory in tests)
// ---------------------------------------------------------------------------

/**
 * Per-(user, cleanup) last-read timestamp store. The WS gateway's `ack` handler WRITES through it to the
 * durable cleanup_members.last_read_at column. READS for the inbox unread count no longer go through this
 * seam in production: listThreadsFor folds the unread count into its single Drizzle query off
 * cleanup_members.last_read_at directly (see threads-repository.drizzle.ts), eliminating the former
 * per-thread countUnread fan-out. This interface is retained for the in-memory test path and any ad-hoc
 * single-thread read; the in-memory impl backs tests, the DB-backed impl backs production writes.
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
  /**
   * Pre-computed unread count (others' messages strictly after the viewer's max(joined_at, last_read_at)
   * watermark), when the repository folds it into listThreadsFor in a single pass — the Drizzle impl does
   * this so the inbox is ONE round-trip instead of an N+1 countUnread fan-out. Optional: when a repo omits
   * it (the in-memory test impl, which carries no read-state), the service falls back to the
   * ChatReadState + countUnread path below, so behavior is identical either way.
   */
  unread?: number
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

/**
 * A per-thread aggregate row for one of the viewer's DM threads. The dm repository computes the peer, the
 * last message, and the unread count in one pass (it already excludes any thread blocked either way), so
 * the threads service just projects it into the MessageThreadDTO and merges it with cleanup threads.
 */
export interface DmThreadAggregateView {
  threadId: string
  createdAt: Date
  peer: {
    id: string
    displayName: string
    handle: string | null
    bio: string | null
    avatarUrl: string | null
  }
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
  unread: number
}

/**
 * The DM half of the inbox: the viewer's DM threads (excluding any blocked either way), each with the
 * peer + last message + unread. Optional on the threads service so the all-cleanup test path can omit it;
 * production + the DM tests wire the dm repo's listThreadsForUser through it.
 */
export interface DmThreadsSource {
  listDmThreadsFor(userId: string): Promise<DmThreadAggregateView[]>
}

// ---------------------------------------------------------------------------
// Relative-time label
// ---------------------------------------------------------------------------
// The compact "ago" label now comes from the shared relativeAgo (imported from @civfix/shared above), the
// single source reconciled across the backend + web + mobile. The shared default renders "now" for the
// near case (< 60s or future) and "Nw" for week-plus; the <60m "Nm", <24h "Nh", and <7d "Nd" buckets are
// unchanged. We adopt the shared default verbatim (no opts) so the server and both clients emit identical
// text for the same timestamp.

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Default page size for GET /threads. */
export const THREADS_DEFAULT_LIMIT = 30

export interface ThreadsServiceDeps {
  repo: ThreadsRepository
  readState: ChatReadState
  /** Optional DM thread source: when wired, the inbox merges DM threads with cleanup threads. */
  dm?: DmThreadsSource
  /** Injectable clock (defaults to Date.now) so `ago` is deterministic in tests. */
  now?: () => Date
}

/** Build the peer PersonDTO for a DM thread from the aggregate's peer fields. */
function peerOf(p: DmThreadAggregateView["peer"]): PersonDTO {
  return {
    id: p.id,
    name: p.displayName,
    handle: p.handle,
    bio: p.bio,
    // Deterministic server avatar seed (parity with the message-DTO sender + openDm peer).
    avatar: avatarGradient(p.id),
    ...(p.avatarUrl !== null ? { avatarUrl: p.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: false,
  }
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

      // Each merged entry carries its DTO plus the activity timestamp used to sort cleanup + dm threads
      // into one inbox (last message time, else the room/thread creation/join baseline).
      const cleanupEntries = await Promise.all(
        aggregates.map(async (agg): Promise<{ dto: MessageThreadDTO; activity: number }> => {
          // Unread = others' messages strictly after the viewer's watermark (max(joinedAt, lastRead)).
          // When the repository already folded this into listThreadsFor (the Drizzle impl, reading the
          // durable cleanup_members.last_read_at), use it directly — this is the single-round-trip path
          // that eliminates the former per-thread countUnread fan-out. Otherwise (the in-memory test
          // repo, which carries no read-state) fall back to the ChatReadState watermark + countUnread so
          // the observable result is identical.
          let unread = agg.unread
          if (unread === undefined) {
            const lastRead = await deps.readState.lastReadAt(agg.cleanupId, userId)
            const watermark =
              lastRead !== null && lastRead.getTime() > agg.joinedAt.getTime()
                ? lastRead
                : agg.joinedAt
            unread = await deps.repo.countUnread(agg.cleanupId, userId, watermark)
          }

          const lastFromMe = agg.last !== null && agg.last.senderId === userId

          return {
            dto: {
              id: agg.cleanupId,
              kind: "cleanup",
              // refId is the room/cleanup id this thread maps to. It equals id today, but populating it
              // explicitly (additive, the contract field is nullable+optional) lets clients stop assuming
              // thread.id === cleanupId.
              refId: agg.cleanupId,
              title: agg.title,
              // last/ago are null when the room has no messages yet.
              last: agg.last !== null ? (agg.last.body ?? "") : null,
              ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
              lastFromMe,
              unread,
              members: agg.members,
            },
            activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
          }
        }),
      )

      // DM threads (when the source is wired). The dm aggregate already excludes any thread blocked either
      // way and pre-computes peer + last + unread, so we just project into the MessageThreadDTO.
      const dmAggregates = deps.dm ? await deps.dm.listDmThreadsFor(userId) : []
      const dmEntries = dmAggregates.map(
        (agg): { dto: MessageThreadDTO; activity: number } => {
          const lastFromMe = agg.last !== null && agg.last.senderId === userId
          const peer = peerOf(agg.peer)
          const title = agg.peer.handle !== null ? `@${agg.peer.handle}` : agg.peer.displayName
          return {
            dto: {
              id: agg.threadId,
              kind: "dm",
              refId: agg.threadId,
              title,
              peer,
              last: agg.last !== null ? (agg.last.body ?? "") : null,
              ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
              lastFromMe,
              unread: agg.unread,
              members: 2,
            },
            activity: (agg.last?.createdAt ?? agg.createdAt).getTime(),
          }
        },
      )

      // Merge both kinds, most-recent-activity first, capped at `limit` (single page for Phase 1).
      const merged = [...cleanupEntries, ...dmEntries].sort((a, b) => b.activity - a.activity)
      const items = merged.slice(0, limit).map((e) => e.dto)
      return { items, nextCursor: null }
    },
  }
}
