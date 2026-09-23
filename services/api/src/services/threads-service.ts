import { relativeAgo, avatarGradient } from "@civfix/shared"
import type { MessageThreadDTO, PersonDTO, RoomKind } from "@civfix/shared"
import {
  encodeTimeCursor,
  isBeforeTimeCursor,
  pageWith,
  parseTimeCursor,
  type TimeCursor,
} from "../db/cursor-helpers.js"
import type { ThreadAggregate, ThreadsRepository } from "./threads-repository.js"

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
  mutedRoomIdsFor(userId: string, roomKind: RoomKind, roomIds: string[]): Promise<Set<string>>
}

export const THREADS_DEFAULT_LIMIT = 30

const DM_MEMBER_COUNT = 2

export interface ThreadsServiceDeps {
  repo: ThreadsRepository
  readState: ChatReadState
  dm?: DmThreadsSource
  report?: ReportThreadsSource
  group?: GroupThreadsSource
  mutes?: ThreadsMutesSource
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

export interface ThreadsPage {
  items: MessageThreadDTO[]
  nextCursor: string | null
}

export interface ThreadsService {
  list(userId: string, opts?: ListThreadsOptions): Promise<ThreadsPage>
  listThreads(userId: string, limit?: number): Promise<ThreadsPage>
}

interface ThreadLastMessage {
  body: string | null
  createdAt: Date
  senderId: string | null
}

interface ThreadEntryInput {
  id: string
  kind: MessageThreadDTO["kind"]
  title: string
  peer?: PersonDTO
  last: ThreadLastMessage | null
  unread: number
  members: number
  muted: boolean
  since: Date
  channel?: boolean
}

interface ThreadEntry {
  dto: MessageThreadDTO
  activity: number
}

function toThreadEntry(input: ThreadEntryInput, userId: string, now: () => Date): ThreadEntry {
  const { last } = input
  return {
    dto: {
      id: input.id,
      kind: input.kind,
      refId: input.id,
      title: input.title,
      ...(input.peer !== undefined ? { peer: input.peer } : {}),
      last: last !== null ? (last.body ?? "") : null,
      ago: last !== null ? relativeAgo(last.createdAt, now()) : null,
      lastMessageAt: last !== null ? last.createdAt.toISOString() : null,
      lastFromMe: last !== null && last.senderId === userId,
      unread: input.unread,
      members: input.members,
      muted: input.muted,
      ...(input.channel === true ? { channel: true as const } : {}),
    },
    activity: (last?.createdAt ?? input.since).getTime(),
  }
}

function dmThreadTitle(peer: DmThreadAggregateView["peer"]): string {
  if (peer.displayName.trim() !== "") return peer.displayName
  return peer.handle !== null ? `@${peer.handle}` : peer.displayName
}

export function makeThreadsService(deps: ThreadsServiceDeps): ThreadsService {
  const now = deps.now ?? (() => new Date())

  async function countCleanupUnread(agg: ThreadAggregate, userId: string): Promise<number> {
    const lastRead = await deps.readState.lastReadAt(agg.cleanupId, userId)
    const watermark =
      lastRead !== null && lastRead.getTime() > agg.joinedAt.getTime() ? lastRead : agg.joinedAt
    return deps.repo.countUnread(agg.cleanupId, userId, watermark)
  }

  async function list(userId: string, opts?: ListThreadsOptions): Promise<ThreadsPage> {
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

    const mutedIdsFor = async (roomKind: RoomKind, roomIds: string[]): Promise<Set<string>> =>
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

    const cleanupEntries = await Promise.all(
      aggregates.map(async (agg) =>
        toThreadEntry(
          {
            id: agg.cleanupId,
            kind: "cleanup",
            title: agg.title,
            last: agg.last,
            unread: agg.unread ?? (await countCleanupUnread(agg, userId)),
            members: agg.members,
            muted: mutedCleanup.has(agg.cleanupId),
            since: agg.joinedAt,
          },
          userId,
          now,
        ),
      ),
    )

    const dmEntries = dmAggregates.map((agg) =>
      toThreadEntry(
        {
          id: agg.threadId,
          kind: "dm",
          title: dmThreadTitle(agg.peer),
          peer: peerOf(agg.peer),
          last: agg.last,
          unread: agg.unread,
          members: DM_MEMBER_COUNT,
          muted: mutedDm.has(agg.threadId),
          since: agg.createdAt,
        },
        userId,
        now,
      ),
    )

    const reportEntries = reportAggregates.map((agg) =>
      toThreadEntry(
        {
          id: agg.reportId,
          kind: "report",
          title: agg.title,
          last: agg.last,
          unread: agg.unread,
          members: agg.members,
          muted: mutedReport.has(agg.reportId),
          since: agg.joinedAt,
        },
        userId,
        now,
      ),
    )

    const groupEntries = groupAggregates.map((agg) =>
      toThreadEntry(
        {
          id: agg.groupId,
          kind: "group",
          title: agg.title,
          last: agg.last,
          unread: agg.unread,
          members: agg.members,
          muted: mutedGroup.has(agg.groupId),
          since: agg.joinedAt,
          channel: agg.kind === "channel",
        },
        userId,
        now,
      ),
    )

    const merged = [...cleanupEntries, ...dmEntries, ...reportEntries, ...groupEntries]
      .filter((e) => isBeforeTimeCursor(e.activity, e.dto.id, cursor))
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
      return { items: page.items, nextCursor: null }
    },
  }
}
