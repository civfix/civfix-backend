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
import {
  encodeTimeCursor,
  pageWith,
  parseTimeCursor,
  type TimeCursor,
} from "../db/cursor-helpers.js"

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
  /**
   * The viewer's cleanups as thread aggregates, ordered by most recent activity first. `cursor` (when
   * supported) pushes the inbox keyset predicate into the query — see THREADS_CURSOR below.
   */
  listThreadsFor(
    userId: string,
    limit: number,
    cursor?: TimeCursor | null,
  ): Promise<ThreadAggregate[]>
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
 * production + the DM tests wire the dm repo's listThreadsForUser through it. `limit` caps the DB scan so a
 * heavy user's full DM set isn't materialized every inbox load (the merge below slices to `limit` anyway).
 */
export interface DmThreadsSource {
  listDmThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregateView[]>
}

/** A per-thread aggregate row for one of the viewer's REPORT chats (member of report_chat_members). */
export interface ReportThreadAggregateView {
  reportId: string
  /** Category label + short address, pre-formatted by the source (see makeDrizzleReportThreadsSource). */
  title: string
  members: number
  /** Unread = messages after GREATEST(joined_at, last_read_at) not authored by the viewer. */
  unread: number
  last: {
    body: string | null
    createdAt: Date
    /** NULL for a system message (report status/timeline event posted into report chat). */
    senderId: string | null
  } | null
  /** Newest-activity baseline when the room has no messages (the viewer's joined_at). */
  joinedAt: Date
}

/**
 * The report half of the inbox: the viewer's report chats (member rows only), each with the report
 * title + member count + last message + unread already computed in one pass. Optional on the service
 * so the cleanup/dm-only test paths can omit it. `muted` is stamped by the service from the shared
 * conversation-mutes seam (deps.mutes), NOT this source, so all three thread families flow through one
 * batch mute lookup rather than a per-family bespoke query.
 */
export interface ReportThreadsSource {
  listReportThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<ReportThreadAggregateView[]>
}

/**
 * A per-thread aggregate row for one of the viewer's GROUP chats (member of chat_group_members, P4).
 * Same watermark/unread contract as the report family: unread = messages after
 * GREATEST(joined_at, last_read_at) not authored by the viewer. NOTE: the group's avatar media does
 * NOT ride here — MessageThreadDTO has no avatar field (known UI limitation; the conversation header
 * fetches the group for it).
 */
export interface GroupThreadAggregateView {
  groupId: string
  /** The group's display name (chat_groups.name). */
  title: string
  /** 'channel' rooms surface MessageThreadDTO.channel:true so the inbox can badge them (P5). */
  kind: "group" | "channel"
  members: number
  unread: number
  last: {
    body: string | null
    createdAt: Date
    senderId: string | null
  } | null
  /** Newest-activity baseline when the room has no messages (the viewer's joined_at). */
  joinedAt: Date
}

/**
 * The group half of the inbox (P4 4.5): the viewer's chat groups (chat_group_members rows), each with
 * name + member count + last message + unread computed in one pass. Optional on the service like the
 * dm/report sources; `muted` is stamped by the service from the shared conversation-mutes seam.
 */
export interface GroupThreadsSource {
  listGroupThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<GroupThreadAggregateView[]>
}

/**
 * Batch per-conversation mute seam (D-E1's conversation_mutes repo). For a family's `roomIds` (all the
 * same `roomKind`), returns the subset the viewer has muted. Optional on the service: when absent the
 * inbox fails open (every thread's `muted` is false). The service issues one call per family
 * (cleanup / dm / report / group), each short-circuiting on an empty id list.
 */
export interface ThreadsMutesSource {
  mutedRoomIdsFor(
    userId: string,
    roomKind: "cleanup" | "dm" | "report" | "group",
    roomIds: string[],
  ): Promise<Set<string>>
}

// The compact "ago" label uses the shared relativeAgo (the single source reconciled across backend + web +
// mobile) verbatim so the server and both clients emit identical text for the same timestamp.

/** Default page size for GET /threads. */
export const THREADS_DEFAULT_LIMIT = 30

export interface ThreadsServiceDeps {
  repo: ThreadsRepository
  readState: ChatReadState
  /** Optional DM thread source: when wired, the inbox merges DM threads with cleanup threads. */
  dm?: DmThreadsSource
  /** Optional report-chat thread source: when wired, the inbox also merges the viewer's report chats. */
  report?: ReportThreadsSource
  /** Optional group thread source (P4 4.5): when wired, the inbox also merges the viewer's groups. */
  group?: GroupThreadsSource
  /**
   * Optional per-conversation mute source (conversation_mutes). When wired, the service stamps each
   * thread's real `muted` state via one batch lookup per family. When absent, `muted` is false for all
   * threads (fail-open — a missing mute store must never make the inbox unusable).
   */
  mutes?: ThreadsMutesSource
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

export interface ListThreadsOptions {
  limit?: number
  /** The previous page's `nextCursor`, verbatim off the wire (PaginationQuery.cursor). */
  cursor?: string | null
}

export interface ThreadsService {
  /** Keyset page of the merged inbox (see THREADS_CURSOR). */
  list(
    userId: string,
    opts?: ListThreadsOptions,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }>
  /**
   * First-page form for callers that never paginate: same items as list(userId, { limit }), but always
   * nextCursor: null (it cannot accept a cursor, so advertising one would strand the caller on page one).
   */
  listThreads(
    userId: string,
    limit?: number,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }>
}

/**
 * THREADS_CURSOR — the inbox is a MERGE of four independently-paged families (cleanup / dm / report /
 * group), so its keyset is the merge key itself: (activity, thread id) DESC, where activity is the last
 * message's created_at, else the room's join/creation baseline. The cursor is the standard "<iso>|<id>"
 * time cursor (encodeTimeCursor), i.e. the last EMITTED row's key, so every family can page from the same
 * opaque string.
 *
 * The predicate is applied TWICE on purpose: pushed down into each source's query (so a page reads ~limit
 * rows per family instead of scanning from the top), and re-applied here over the merged entries. The
 * second pass is what makes the page exact — an ISO cursor carries only milliseconds while
 * created_at is microsecond-resolution, so each source's SQL bound is deliberately loose (same
 * millisecond or older) and this filter, working in the same millisecond resolution as the merge sort,
 * makes the cut. It also keeps a source that ignores `cursor` from re-emitting rows the caller already
 * saw (it can only under-fetch, never duplicate).
 *
 * Each family is fetched with `limit + 1` rows, so `merged.length > limit` is an exact has-more test: a
 * family that hit its cap contributes the extra row that proves another page exists.
 */
function beforeCursor(cursor: TimeCursor | null, activity: number, id: string): boolean {
  if (cursor === null) return true
  const at = cursor.at.getTime()
  return activity < at || (activity === at && id < cursor.id)
}

export function makeThreadsService(deps: ThreadsServiceDeps): ThreadsService {
  const now = deps.now ?? (() => new Date())

  async function list(
    userId: string,
    opts?: ListThreadsOptions,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }> {
    const limit = Math.max(1, opts?.limit ?? THREADS_DEFAULT_LIMIT)
    // A malformed / unknown cursor degrades to page one (the cursor-helpers contract), never a 500.
    const cursor = parseTimeCursor(opts?.cursor ?? null)
    const fetchLimit = limit + 1

    // All four families are fetched up front — CONCURRENTLY, since they are independent keyset reads of
    // different tables and nothing here consumes one to build another. (Sequentially the inbox paid the
    // sum of four round trips on every load; now it pays the slowest.) They must all land before any DTO
    // is built, because each DTO stamps its real `muted` from the per-family batch lookup below.
    const cleanupFetch: Promise<ThreadAggregate[]> = deps.repo.listThreadsFor(
      userId,
      fetchLimit,
      cursor,
    )
    const dmFetch: Promise<DmThreadAggregateView[]> = deps.dm
      ? deps.dm.listDmThreadsFor(userId, fetchLimit, cursor)
      : Promise.resolve([])
    const reportFetch: Promise<ReportThreadAggregateView[]> = deps.report
      ? deps.report.listReportThreadsFor(userId, fetchLimit, cursor)
      : Promise.resolve([])
    const groupFetch: Promise<GroupThreadAggregateView[]> = deps.group
      ? deps.group.listGroupThreadsFor(userId, fetchLimit, cursor)
      : Promise.resolve([])
    const [aggregates, dmAggregates, reportAggregates, groupAggregates] = await Promise.all([
      cleanupFetch,
      dmFetch,
      reportFetch,
      groupFetch,
    ])

    // Real per-conversation mute (conversation_mutes): one batch lookup per family, keyed by the
    // family's room ids (cleanup id / dm thread id / report id). Fails open when no mute source is
    // wired — every thread is treated as un-muted rather than erroring the whole inbox. Each lookup
    // short-circuits on an empty id list so an empty family costs no round-trip.
    const mutedIdsFor = async (
      roomKind: "cleanup" | "dm" | "report" | "group",
      roomIds: string[],
    ): Promise<Set<string>> =>
      deps.mutes && roomIds.length > 0
        ? await deps.mutes.mutedRoomIdsFor(userId, roomKind, roomIds)
        : new Set<string>()
    const [mutedCleanup, mutedDm, mutedReport, mutedGroup] = await Promise.all([
      mutedIdsFor(
        "cleanup",
        aggregates.map((a) => a.cleanupId),
      ),
      mutedIdsFor(
        "dm",
        dmAggregates.map((a) => a.threadId),
      ),
      mutedIdsFor(
        "report",
        reportAggregates.map((a) => a.reportId),
      ),
      mutedIdsFor(
        "group",
        groupAggregates.map((a) => a.groupId),
      ),
    ])

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
            muted: mutedCleanup.has(agg.cleanupId),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      }),
    )

    // DM threads (when the source is wired). The dm aggregate already excludes any thread blocked either
    // way and pre-computes peer + last + unread, so we just project into the MessageThreadDTO. dmAggregates
    // was fetched above (capped to `fetchLimit`) alongside the report rows so the mute lookup could batch;
    // the merge below keeps only the most-recent `limit` across all kinds anyway.
    const dmEntries = dmAggregates.map(
      (agg): { dto: MessageThreadDTO; activity: number } => {
        const lastFromMe = agg.last !== null && agg.last.senderId === userId
        const peer = peerOf(agg.peer)
        // The DM thread title is the peer's DISPLAY NAME (the @handle is only a fallback when the display
        // name is blank), so the inbox row + the conversation header name the person, not their @handle.
        const title =
          agg.peer.displayName.trim() !== ""
            ? agg.peer.displayName
            : agg.peer.handle !== null
              ? `@${agg.peer.handle}`
              : agg.peer.displayName
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
            muted: mutedDm.has(agg.threadId),
          },
          activity: (agg.last?.createdAt ?? agg.createdAt).getTime(),
        }
      },
    )

    // Report threads (when the source is wired). listReportThreadsFor already scoped to the viewer's
    // report_chat_members rows and pre-computed members/unread/last + the display title; we just project
    // it and stamp `muted` from the report muted set. A system message has senderId=null, so `=== userId`
    // is false and lastFromMe stays false for it.
    const reportEntries = reportAggregates.map(
      (agg): { dto: MessageThreadDTO; activity: number } => {
        const lastFromMe = agg.last !== null && agg.last.senderId === userId
        return {
          dto: {
            id: agg.reportId,
            kind: "report",
            refId: agg.reportId,
            title: agg.title,
            last: agg.last !== null ? (agg.last.body ?? "") : null,
            ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
            lastFromMe,
            unread: agg.unread,
            members: agg.members,
            muted: mutedReport.has(agg.reportId),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      },
    )

    // Group threads (when the source is wired, P4 4.5). listGroupThreadsFor already scoped to the
    // viewer's chat_group_members rows and pre-computed members/unread/last + the group name; we just
    // project it and stamp `muted` from the group muted set. senderId is null-safe like the report
    // family (group rooms have no system rows today, but the shape allows them).
    const groupEntries = groupAggregates.map(
      (agg): { dto: MessageThreadDTO; activity: number } => {
        const lastFromMe = agg.last !== null && agg.last.senderId === userId
        return {
          dto: {
            id: agg.groupId,
            kind: "group",
            refId: agg.groupId,
            title: agg.title,
            last: agg.last !== null ? (agg.last.body ?? "") : null,
            ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
            lastFromMe,
            unread: agg.unread,
            members: agg.members,
            muted: mutedGroup.has(agg.groupId),
            // Optional flag: present only for channels (matches the optional shared schema).
            ...(agg.kind === "channel" ? { channel: true as const } : {}),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      },
    )

    // Merge all kinds on the keyset order (activity DESC, then id DESC so the sort is TOTAL — without
    // the tie-break, same-millisecond threads could swap places between pages and be skipped/repeated),
    // re-apply the cursor cut, then split off the has-more probe row.
    const merged = [...cleanupEntries, ...dmEntries, ...reportEntries, ...groupEntries]
      .filter((e) => beforeCursor(cursor, e.activity, e.dto.id))
      .sort(
        (a, b) =>
          b.activity - a.activity || (a.dto.id < b.dto.id ? 1 : a.dto.id > b.dto.id ? -1 : 0),
      )
    const page = pageWith(merged, limit, (last) =>
      encodeTimeCursor({ at: new Date(last.activity), id: last.dto.id }),
    )
    return { items: page.items.map((e) => e.dto), nextCursor: page.nextCursor }
  }

  return {
    list,
    async listThreads(userId, limit) {
      const page = await list(userId, limit !== undefined ? { limit } : {})
      // Deliberately nextCursor: null — this form takes no cursor, so it must not advertise one (a caller
      // that followed it would re-read page one forever). Paging callers use list().
      return { items: page.items, nextCursor: null }
    },
  }
}
