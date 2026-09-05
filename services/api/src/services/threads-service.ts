
import { relativeAgo, avatarGradient } from "@civfix/shared"
import type { MessageThreadDTO, PersonDTO } from "@civfix/shared"
import {
  encodeTimeCursor,
  pageWith,
  parseTimeCursor,
  type TimeCursor,
} from "../db/cursor-helpers.js"

export interface ChatReadState {
  markRead(cleanupId: string, userId: string, at: Date): Promise<void>
  lastReadAt(cleanupId: string, userId: string): Promise<Date | null>
}

export class InMemoryChatReadState implements ChatReadState {
  private readonly marks = new Map<string, number>()

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

export interface DmThreadAggregateView {
  threadId: string
  createdAt: Date
  peer: {
    id: string
    displayName: string
    handle: string | null
    bio: string | null
    avatarUrl: string | null
    deleted: boolean
  }
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
  unread: number
}

export interface DmThreadsSource {
  listDmThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregateView[]>
}

export interface ReportThreadAggregateView {
  reportId: string
  title: string
  members: number
  unread: number
  last: {
    body: string | null
    createdAt: Date
    senderId: string | null
  } | null
  joinedAt: Date
}

export interface ReportThreadsSource {
  listReportThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<ReportThreadAggregateView[]>
}

export interface GroupThreadAggregateView {
  groupId: string
  title: string
  kind: "group" | "channel"
  members: number
  unread: number
  last: {
    body: string | null
    createdAt: Date
    senderId: string | null
  } | null
  joinedAt: Date
}

export interface GroupThreadsSource {
  listGroupThreadsFor(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<GroupThreadAggregateView[]>
}

export interface ThreadsMutesSource {
  mutedRoomIdsFor(
    userId: string,
    roomKind: "cleanup" | "dm" | "report" | "group",
    roomIds: string[],
  ): Promise<Set<string>>
}

export interface ThreadsHidesSource {
  hiddenAtFor(
    userId: string,
    roomKind: "cleanup" | "dm" | "report" | "group",
    roomIds: string[],
  ): Promise<Map<string, Date>>
}


export const THREADS_DEFAULT_LIMIT = 30

export interface ThreadsServiceDeps {
  repo: ThreadsRepository
  readState: ChatReadState
  dm?: DmThreadsSource
  report?: ReportThreadsSource
  group?: GroupThreadsSource
  mutes?: ThreadsMutesSource
  hides?: ThreadsHidesSource
  now?: () => Date
}

function peerOf(p: DmThreadAggregateView["peer"]): PersonDTO {
  return {
    id: p.id,
    name: p.displayName,
    handle: p.handle,
    bio: p.bio,
    avatar: avatarGradient(p.id),
    ...(p.avatarUrl !== null ? { avatarUrl: p.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: false,
    ...(p.deleted ? { deleted: true } : {}),
  }
}

export interface ListThreadsOptions {
  limit?: number
  cursor?: string | null
}

export interface ThreadsService {
  list(
    userId: string,
    opts?: ListThreadsOptions,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }>
  listThreads(
    userId: string,
    limit?: number,
  ): Promise<{ items: MessageThreadDTO[]; nextCursor: string | null }>
}

export function isHiddenFor(hiddenAt: Date | undefined, activity: number): boolean {
  return hiddenAt !== undefined && activity <= hiddenAt.getTime()
}

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
    const cursor = parseTimeCursor(opts?.cursor ?? null)
    const fetchLimit = limit + 1

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

    const hiddenAtFor = async (
      roomKind: "cleanup" | "dm" | "report" | "group",
      roomIds: string[],
    ): Promise<Map<string, Date>> =>
      deps.hides && roomIds.length > 0
        ? await deps.hides.hiddenAtFor(userId, roomKind, roomIds)
        : new Map<string, Date>()
    const [hiddenCleanup, hiddenDm, hiddenReport, hiddenGroup] = await Promise.all([
      hiddenAtFor(
        "cleanup",
        aggregates.map((a) => a.cleanupId),
      ),
      hiddenAtFor(
        "dm",
        dmAggregates.map((a) => a.threadId),
      ),
      hiddenAtFor(
        "report",
        reportAggregates.map((a) => a.reportId),
      ),
      hiddenAtFor(
        "group",
        groupAggregates.map((a) => a.groupId),
      ),
    ])
    const hiddenAtOf = (kind: MessageThreadDTO["kind"], id: string): Date | undefined =>
      kind === "cleanup"
        ? hiddenCleanup.get(id)
        : kind === "dm"
          ? hiddenDm.get(id)
          : kind === "report"
            ? hiddenReport.get(id)
            : hiddenGroup.get(id)

    const cleanupEntries = await Promise.all(
      aggregates.map(async (agg): Promise<{ dto: MessageThreadDTO; activity: number }> => {
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
            refId: agg.cleanupId,
            title: agg.title,
            last: agg.last !== null ? (agg.last.body ?? "") : null,
            ago: agg.last !== null ? relativeAgo(agg.last.createdAt, now()) : null,
            lastMessageAt: agg.last !== null ? agg.last.createdAt.toISOString() : null,
            lastFromMe,
            unread,
            members: agg.members,
            muted: mutedCleanup.has(agg.cleanupId),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      }),
    )

    const dmEntries = dmAggregates.map(
      (agg): { dto: MessageThreadDTO; activity: number } => {
        const lastFromMe = agg.last !== null && agg.last.senderId === userId
        const peer = peerOf(agg.peer)
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
            lastMessageAt: agg.last !== null ? agg.last.createdAt.toISOString() : null,
            lastFromMe,
            unread: agg.unread,
            members: 2,
            muted: mutedDm.has(agg.threadId),
          },
          activity: (agg.last?.createdAt ?? agg.createdAt).getTime(),
        }
      },
    )

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
            lastMessageAt: agg.last !== null ? agg.last.createdAt.toISOString() : null,
            lastFromMe,
            unread: agg.unread,
            members: agg.members,
            muted: mutedReport.has(agg.reportId),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      },
    )

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
            lastMessageAt: agg.last !== null ? agg.last.createdAt.toISOString() : null,
            lastFromMe,
            unread: agg.unread,
            members: agg.members,
            muted: mutedGroup.has(agg.groupId),
            ...(agg.kind === "channel" ? { channel: true as const } : {}),
          },
          activity: (agg.last?.createdAt ?? agg.joinedAt).getTime(),
        }
      },
    )

    const merged = [...cleanupEntries, ...dmEntries, ...reportEntries, ...groupEntries]
      .filter((e) => beforeCursor(cursor, e.activity, e.dto.id))
      .sort(
        (a, b) =>
          b.activity - a.activity || (a.dto.id < b.dto.id ? 1 : a.dto.id > b.dto.id ? -1 : 0),
      )
    const page = pageWith(merged, limit, (last) =>
      encodeTimeCursor({ at: new Date(last.activity), id: last.dto.id }),
    )
    const visible = page.items.filter(
      (e) => !isHiddenFor(hiddenAtOf(e.dto.kind, e.dto.id), e.activity),
    )
    return { items: visible.map((e) => e.dto), nextCursor: page.nextCursor }
  }

  return {
    list,
    async listThreads(userId, limit) {
      const page = await list(userId, limit !== undefined ? { limit } : {})
      return { items: page.items, nextCursor: null }
    },
  }
}
