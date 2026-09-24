import { randomUUID } from "node:crypto"
import { avatarGradient, AppError } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji, ReactionSummaryDTO, ReplyToDTO } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import { REPLY_EXCERPT_MAX, replyDeletedTarget, replyWrongRoom } from "./chat-reply-hydration.js"
import { PIN_LIST_CAP } from "./room-messages-repository.drizzle.js"
import { publicAuthorIdentity } from "./public-author.js"
import { officialPersonFlag } from "../auth/official-account.js"
import { aroundLimits } from "./chat-history-window.js"
import { toTombstoneDTO } from "./chat-tombstone.js"
import type { ConversationHidesRepository } from "./conversation-hides-repository.drizzle.js"
import { visibleAfterHides } from "./conversation-hides-repository.memory.js"
import type {
  DmMessageMeta,
  DmPersistInput,
  DmRepository,
  DmThread,
  DmThreadAggregate,
} from "./dm-repository.drizzle.js"
import type {
  BlockState,
  BlocksRepository,
  ListBlockedArgs,
  ListBlockedPage,
} from "./blocks-repository.drizzle.js"
import { LIST_BLOCKS_DEFAULT_LIMIT } from "./blocks-repository.drizzle.js"
import type { TimeCursor } from "../db/cursor-helpers.js"
import type { PersonDTO } from "@civfix/shared"

export interface DmUser {
  id: string
  displayName: string
  handle?: string | null
  bio?: string | null
  avatarUrl?: string | null
  deletedAt?: Date | null
}

interface StoredDmMessage {
  dto: ChatMessageDTO
  deleted: boolean
  deletedAt?: Date
  insertedAtMs: number
}

// Writes are stamped at fixed one-millisecond steps so ordering is deterministic.
const SYNTHETIC_EPOCH_MS = Date.UTC(2026, 0, 1)

const PLACEHOLDER_NAME_ID_CHARS = 4

function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function placeholderDisplayName(id: string): string {
  return `User ${id.slice(0, PLACEHOLDER_NAME_ID_CHARS)}`
}

function readKey(threadId: string, userId: string): string {
  return `${threadId}:${userId}`
}

function peerIn(thread: DmThread, userId: string): string | null {
  if (thread.userLo === userId) return thread.userHi
  if (thread.userHi === userId) return thread.userLo
  return null
}

function lastSenderId(message: ChatMessageDTO): string {
  if (!message.from) throw new Error("DM message unexpectedly has no author")
  return message.from.id
}

export class InMemoryDmRepository implements DmRepository {
  private readonly threads = new Map<string, DmThread>()
  private readonly byPair = new Map<string, string>()
  private readonly log = new Map<string, StoredDmMessage[]>()
  private readonly reads = new Map<string, number>()
  private readonly reactions = new Map<string, Set<string>>()
  private readonly users = new Map<string, DmUser>()
  private tick = 0

  constructor(
    private readonly isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>,
    private readonly hides?: ConversationHidesRepository,
  ) {}

  registerUser(user: DmUser): void {
    this.users.set(user.id, user)
  }

  private userOf(id: string): DmUser {
    return (
      this.users.get(id) ?? { id, displayName: placeholderDisplayName(id), handle: null, bio: null }
    )
  }

  private nextDate(): Date {
    this.tick += 1
    return new Date(SYNTHETIC_EPOCH_MS + this.tick)
  }

  private replyToFor(threadId: string, replyToId: string): ReplyToDTO | null {
    const stored = (this.log.get(threadId) ?? []).find((m) => m.dto.id === replyToId)
    if (!stored) return null
    return {
      id: replyToId,
      from: stored.dto.from ? { id: stored.dto.from.id, displayName: stored.dto.from.name } : null,
      excerpt: stored.deleted ? "" : (stored.dto.body ?? "").slice(0, REPLY_EXCERPT_MAX),
      kind: stored.dto.kind,
      ...(stored.deleted ? { deleted: true } : {}),
    }
  }

  private withReply(threadId: string, dto: ChatMessageDTO): ChatMessageDTO {
    if (dto.replyToId == null) return dto
    return { ...dto, replyTo: this.replyToFor(threadId, dto.replyToId) }
  }

  openOrCreateThread(userA: string, userB: string): Promise<DmThread> {
    const [lo, hi] = orderPair(userA, userB)
    const key = `${lo}:${hi}`
    const existingId = this.byPair.get(key)
    if (existingId) return Promise.resolve(this.threads.get(existingId)!)
    const thread: DmThread = {
      id: randomUUID(),
      userLo: lo,
      userHi: hi,
      createdAt: this.nextDate(),
    }
    this.threads.set(thread.id, thread)
    this.byPair.set(key, thread.id)
    return Promise.resolve(thread)
  }

  getThreadForPair(userA: string, userB: string): Promise<DmThread | null> {
    const [lo, hi] = orderPair(userA, userB)
    const id = this.byPair.get(`${lo}:${hi}`)
    return Promise.resolve(id ? (this.threads.get(id) ?? null) : null)
  }

  getThread(threadId: string): Promise<DmThread | null> {
    return Promise.resolve(this.threads.get(threadId) ?? null)
  }

  isParticipant(threadId: string, userId: string): Promise<boolean> {
    const t = this.threads.get(threadId)
    return Promise.resolve(t !== undefined && (t.userLo === userId || t.userHi === userId))
  }

  peerOf(threadId: string, userId: string): string | null {
    const t = this.threads.get(threadId)
    return t ? peerIn(t, userId) : null
  }

  persist(input: DmPersistInput): Promise<ChatMessageDTO> {
    if (input.replyToId !== undefined) {
      const target = (this.log.get(input.threadId) ?? []).find((m) => m.dto.id === input.replyToId)
      if (!target) return Promise.reject(replyWrongRoom())
      if (target.deleted) return Promise.reject(replyDeletedTarget())
    }
    const sender = this.userOf(input.senderId)
    const dto: ChatMessageDTO = {
      id: randomUUID(),
      cleanupId: input.threadId,
      roomKind: "dm",
      from: {
        id: sender.id,
        name: sender.displayName,
        handle: sender.handle ?? null,
        bio: sender.bio ?? null,
        avatar: avatarGradient(sender.id),
        ...(sender.avatarUrl != null ? { avatarUrl: sender.avatarUrl } : {}),
        followers: 0,
        following: 0,
        isFollowing: false,
        ...officialPersonFlag(sender.id),
      },
      body: input.body,
      kind: input.kind ?? "text",
      attachments: [],
      reactions: [],
      mentions: [],
      createdAt: this.nextDate().toISOString(),
      ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }
    const list = this.log.get(input.threadId) ?? []
    list.push({ dto, deleted: false, insertedAtMs: Date.now() })
    this.log.set(input.threadId, list)
    return Promise.resolve({ ...this.withReply(input.threadId, dto), mine: true })
  }

  editMessage(
    threadId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    const stored = (this.log.get(threadId) ?? []).find(
      (m) => m.dto.id === messageId && m.dto.from?.id === senderId && !m.deleted,
    )
    if (!stored) return Promise.resolve(null)
    const edited: ChatMessageDTO = {
      ...stored.dto,
      body,
      editedAt: this.nextDate().toISOString(),
    }
    stored.dto = edited
    return Promise.resolve(this.withReply(threadId, edited))
  }

  findMessageMeta(messageId: string): Promise<DmMessageMeta | null> {
    for (const [threadId, list] of this.log) {
      const stored = list.find((m) => m.dto.id === messageId)
      if (stored) {
        return Promise.resolve({
          id: messageId,
          threadId,
          senderId: lastSenderId(stored.dto),
          kind: stored.dto.kind,
          createdAt: new Date(stored.insertedAtMs),
          deletedAt: stored.deleted ? new Date(stored.insertedAtMs) : null,
        })
      }
    }
    return Promise.resolve(null)
  }

  softDelete(
    threadId: string,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null> {
    const stored = (this.log.get(threadId) ?? []).find(
      (m) => m.dto.id === messageId && m.dto.from?.id === senderId && !m.deleted,
    )
    if (!stored) return Promise.resolve(null)
    stored.deleted = true
    stored.deletedAt = this.nextDate()
    const tombstone = toTombstoneDTO({ ...stored.dto, mine: true }, stored.deletedAt)
    return Promise.resolve(this.withReply(threadId, tombstone))
  }

  setPinned(
    threadId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    const found = (this.log.get(threadId) ?? []).find((m) => m.dto.id === messageId)
    if (!found || found.deleted) return Promise.resolve(null)
    const currentlyPinned = found.dto.pinnedAt != null
    if (found.dto.kind !== "system" && currentlyPinned !== pinned) {
      found.dto = pinned
        ? { ...found.dto, pinnedAt: this.nextDate().toISOString() }
        : (({ pinnedAt: _dropped, ...rest }) => rest)(found.dto)
    }
    return Promise.resolve(
      this.withReply(threadId, { ...found.dto, reactions: this.reactionsFor(messageId, userId) }),
    )
  }

  listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
    const pins = (this.log.get(threadId) ?? [])
      .filter((m) => !m.deleted && m.dto.pinnedAt != null)
      .sort((a, b) => {
        const at = a.dto.pinnedAt!
        const bt = b.dto.pinnedAt!
        return at === bt ? (a.dto.id < b.dto.id ? 1 : -1) : at < bt ? 1 : -1
      })
      .slice(0, PIN_LIST_CAP)
      .map((m) =>
        this.withReply(threadId, {
          ...m.dto,
          reactions: this.reactionsFor(m.dto.id, viewerUserId),
        }),
      )
    return Promise.resolve(pins)
  }

  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId: string | null = null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    if (around !== undefined) return this.historyAround(threadId, around, limit, viewerUserId)
    const allDesc = [...(this.log.get(threadId) ?? [])].reverse()
    let afterAnchor = allDesc
    if (before !== undefined) {
      const idx = allDesc.findIndex((m) => m.dto.id === before)
      if (idx >= 0) afterAnchor = allDesc.slice(idx + 1)
    }
    const ordered = afterAnchor
      .filter((m) => !m.deleted)
      .map((m) =>
        this.withReply(threadId, {
          ...m.dto,
          reactions: this.reactionsFor(m.dto.id, viewerUserId),
        }),
      )
    const page = ordered.slice(0, limit)
    const nextCursor = ordered.length > limit ? (page[page.length - 1]?.id ?? null) : null
    return Promise.resolve({ items: page, nextCursor })
  }

  private historyAround(
    threadId: string,
    around: string,
    limit: number,
    viewerUserId: string | null,
  ): Promise<ChatHistoryPage> {
    const all = this.log.get(threadId) ?? []
    if (!all.some((m) => m.dto.id === around)) {
      return Promise.reject(AppError.notFound("Message not found"))
    }
    const ordered = [...all].filter((m) => !m.deleted || m.dto.id === around).reverse()
    const idx = ordered.findIndex((m) => m.dto.id === around)
    const { olderLimit, newerLimit } = aroundLimits(limit)
    const newerStart = Math.max(0, idx - newerLimit)
    const window = ordered.slice(newerStart, idx + olderLimit)
    const items = window.map((m) =>
      this.withReply(
        threadId,
        m.deleted
          ? toTombstoneDTO(m.dto, m.deletedAt ?? new Date(m.insertedAtMs))
          : { ...m.dto, reactions: this.reactionsFor(m.dto.id, viewerUserId) },
      ),
    )
    return Promise.resolve({
      items,
      nextCursor: idx + olderLimit < ordered.length ? (items[items.length - 1]?.id ?? null) : null,
      prevCursor: newerStart > 0 ? (items[0]?.id ?? null) : null,
    })
  }

  private reactionsFor(messageId: string, viewerUserId: string | null): ReactionSummaryDTO[] {
    const set = this.reactions.get(messageId)
    if (!set || set.size === 0) return []
    const counts = new Map<string, { count: number; mine: boolean }>()
    for (const key of set) {
      const sep = key.indexOf(":")
      const uid = key.slice(0, sep)
      const emoji = key.slice(sep + 1)
      const cur = counts.get(emoji) ?? { count: 0, mine: false }
      cur.count += 1
      if (viewerUserId !== null && uid === viewerUserId) cur.mine = true
      counts.set(emoji, cur)
    }
    return [...counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([emoji, v]) => ({ emoji: emoji as ReactionEmoji, count: v.count, mine: v.mine }))
  }

  findMessage(
    threadId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    const stored = (this.log.get(threadId) ?? []).find((m) => m.dto.id === messageId && !m.deleted)
    if (!stored) return Promise.resolve(null)
    return Promise.resolve(
      this.withReply(threadId, {
        ...stored.dto,
        reactions: this.reactionsFor(messageId, viewerUserId),
      }),
    )
  }

  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
    const exists = [...this.log.values()].some((list) =>
      list.some((m) => m.dto.id === messageId && !m.deleted),
    )
    if (!exists) return Promise.resolve(false)
    const set = this.reactions.get(messageId) ?? new Set<string>()
    const key = `${userId}:${emoji}`
    let present: boolean
    if (set.has(key)) {
      set.delete(key)
      present = false
    } else {
      set.add(key)
      present = true
    }
    this.reactions.set(messageId, set)
    return Promise.resolve(present)
  }

  markRead(threadId: string, userId: string, at: Date): Promise<void> {
    const key = readKey(threadId, userId)
    const prev = this.reads.get(key) ?? 0
    if (at.getTime() > prev) this.reads.set(key, at.getTime())
    return Promise.resolve()
  }

  lastReadAt(threadId: string, userId: string): Promise<Date | null> {
    const ms = this.reads.get(readKey(threadId, userId))
    return Promise.resolve(ms !== undefined ? new Date(ms) : null)
  }

  countUnread(threadId: string, userId: string): Promise<number> {
    const thread = this.threads.get(threadId)
    if (!thread) return Promise.resolve(0)
    const baseline = Math.max(
      thread.createdAt.getTime(),
      this.reads.get(readKey(threadId, userId)) ?? 0,
    )
    const unread = (this.log.get(threadId) ?? []).filter(
      (m) =>
        !m.deleted && m.dto.from?.id !== userId && new Date(m.dto.createdAt).getTime() > baseline,
    ).length
    return Promise.resolve(unread)
  }

  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null> {
    const found = (this.log.get(threadId) ?? []).find((m) => m.dto.id === messageId)
    return Promise.resolve(found ? new Date(found.dto.createdAt) : null)
  }

  async listThreadsForUser(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregate[]> {
    const out: DmThreadAggregate[] = []
    for (const t of this.threads.values()) {
      const peerId = peerIn(t, userId)
      if (peerId === null) continue
      if (this.isBlockedEitherWay && (await this.isBlockedEitherWay(userId, peerId))) continue

      const peer = this.userOf(peerId)
      const identity = publicAuthorIdentity({
        id: peer.id,
        displayName: peer.displayName,
        handle: peer.handle ?? null,
        avatarUrl: peer.avatarUrl ?? null,
        deletedAt: peer.deletedAt ?? null,
      })
      const live = (this.log.get(t.id) ?? []).filter((m) => !m.deleted).map((m) => m.dto)
      const last = live.length > 0 ? live[live.length - 1]! : null
      const lastReadMs = this.reads.get(readKey(t.id, userId)) ?? 0
      const baseline = Math.max(t.createdAt.getTime(), lastReadMs)
      const unread = live.filter(
        (m) => m.from?.id === peerId && new Date(m.createdAt).getTime() > baseline,
      ).length

      out.push({
        threadId: t.id,
        createdAt: t.createdAt,
        peer: {
          id: peer.id,
          displayName: identity.name,
          handle: identity.handle,
          bio: identity.deleted ? null : (peer.bio ?? null),
          avatarUrl: identity.avatarUrl ?? null,
          deleted: identity.deleted,
        },
        last:
          last !== null
            ? {
                body: last.body ?? null,
                createdAt: new Date(last.createdAt),
                senderId: lastSenderId(last),
              }
            : null,
        unread,
      })
    }
    const activityOf = (a: DmThreadAggregate): number =>
      (a.last?.createdAt ?? a.createdAt).getTime()
    const visible = await visibleAfterHides(
      this.hides,
      userId,
      "dm",
      out,
      (a) => a.threadId,
      activityOf,
    )
    visible.sort(
      (a, b) =>
        activityOf(b) - activityOf(a) ||
        (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0),
    )
    const paged =
      cursor !== null && cursor !== undefined
        ? visible.filter(
            (a) =>
              activityOf(a) < cursor.at.getTime() ||
              (activityOf(a) === cursor.at.getTime() && a.threadId < cursor.id),
          )
        : visible
    return limit !== undefined ? paged.slice(0, limit) : paged
  }
}

export class InMemoryBlocksRepository implements BlocksRepository {
  private readonly edges = new Map<string, Set<string>>()
  private readonly users = new Map<string, DmUser>()

  registerUser(user: DmUser): void {
    this.users.set(user.id, user)
  }

  block(blockerId: string, blockedId: string): Promise<void> {
    const set = this.edges.get(blockerId) ?? new Set<string>()
    set.add(blockedId)
    this.edges.set(blockerId, set)
    return Promise.resolve()
  }

  unblock(blockerId: string, blockedId: string): Promise<void> {
    this.edges.get(blockerId)?.delete(blockedId)
    return Promise.resolve()
  }

  isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const aBlocksB = this.edges.get(a)?.has(b) ?? false
    const bBlocksA = this.edges.get(b)?.has(a) ?? false
    return Promise.resolve(aBlocksB || bBlocksA)
  }

  blockState(viewerId: string, targetId: string): Promise<BlockState> {
    return Promise.resolve({
      blockedByViewer: this.edges.get(viewerId)?.has(targetId) ?? false,
      blockedByTarget: this.edges.get(targetId)?.has(viewerId) ?? false,
    })
  }

  listBlocked(blockerId: string, args?: ListBlockedArgs): Promise<ListBlockedPage> {
    const limit = args?.limit ?? LIST_BLOCKS_DEFAULT_LIMIT
    const ids = [...(this.edges.get(blockerId) ?? [])].slice(0, limit)
    const blocked: PersonDTO[] = ids.map((id) => {
      const u = this.users.get(id) ?? { id, displayName: placeholderDisplayName(id) }
      return {
        id: u.id,
        name: u.displayName,
        handle: u.handle ?? null,
        bio: u.bio ?? null,
        avatar: avatarGradient(u.id),
        ...(u.avatarUrl != null ? { avatarUrl: u.avatarUrl } : {}),
        followers: 0,
        following: 0,
        isFollowing: false,
        ...officialPersonFlag(u.id),
      }
    })
    return Promise.resolve({ blocked, nextCursor: null })
  }
}
