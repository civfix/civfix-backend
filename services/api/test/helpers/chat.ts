
import { randomUUID } from "node:crypto"
import { avatarGradient, AppError } from "@civfix/shared"
import type { ChatConnection, ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import type { ChatMessageDTO, ReactionEmoji, ReactionSummaryDTO, ReplyToDTO } from "@civfix/shared"
import {
  PIN_LIST_CAP,
  type ChatMessageMeta,
  type ChatRepository,
  type SoftDeleteOpts,
} from "../../src/services/chat-repository.drizzle.js"
import {
  REPLY_EXCERPT_MAX,
  replyDeletedTarget,
  replyWrongRoom,
} from "../../src/services/chat-reply-hydration.js"
import { aroundLimits } from "../../src/services/chat-history-window.js"
import type { ThreadAggregate, ThreadsRepository } from "../../src/services/threads-service.js"

interface StoredMessage {
  dto: ChatMessageDTO
  deleted: boolean
  /**
   * REAL wall-clock insertion time. The dto's createdAt rides the deterministic 2026-01-01 tick clock
   * (stable ordering for assertions), which would make every fake message look months old to the
   * chat-edit-service EDIT_WINDOW_HOURS gate; findMessageMeta reports this instead.
   */
  insertedAtMs: number
}

export interface ChatSender {
  id: string
  displayName: string
  handle?: string | null
  bio?: string | null
}

export class InMemoryChatRepository implements ChatRepository {
  private readonly log = new Map<string, StoredMessage[]>()
  private readonly senders = new Map<string, ChatSender>()
  private readonly reactions = new Map<string, Set<string>>()
  private tick = 0

  registerSender(sender: ChatSender): void {
    this.senders.set(sender.id, sender)
  }

  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

  /**
   * Recompute the reply preview for a target id from the CURRENT store state (mirrors the drizzle
   * hydration: tombstoned target -> deleted:true + excerpt ""; excerpt = first 120 chars of body).
   */
  private replyToFor(roomId: string, replyToId: string): ReplyToDTO | null {
    const stored = (this.log.get(roomId) ?? []).find((m) => m.dto.id === replyToId)
    if (!stored) return null
    return {
      id: replyToId,
      from: stored.dto.from ? { id: stored.dto.from.id, displayName: stored.dto.from.name } : null,
      excerpt: stored.deleted ? "" : (stored.dto.body ?? "").slice(0, REPLY_EXCERPT_MAX),
      kind: stored.dto.kind,
      ...(stored.deleted ? { deleted: true } : {}),
    }
  }

  /** Project a stored DTO with its live reply preview (no-op for non-replies). */
  private withReply(roomId: string, dto: ChatMessageDTO): ChatMessageDTO {
    if (dto.replyToId == null) return dto
    return { ...dto, replyTo: this.replyToFor(roomId, dto.replyToId) }
  }

  insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO> {
    // Reply validation (P2), mirroring the drizzle repo: target must exist in THIS room (else 422
    // reply_wrong_room) and not be tombstoned (else 422 reply_deleted_target).
    if (input.replyToId !== undefined) {
      const target = (this.log.get(input.cleanupId) ?? []).find((m) => m.dto.id === input.replyToId)
      if (!target) return Promise.reject(replyWrongRoom())
      if (target.deleted) return Promise.reject(replyDeletedTarget())
    }
    const sender = this.senders.get(input.userId) ?? {
      id: input.userId,
      displayName: `User ${input.userId.slice(0, 4)}`,
      handle: null,
      bio: null,
    }
    const dto: ChatMessageDTO = {
      id,
      cleanupId: input.cleanupId,
      ...(input.roomKind === "report" ? { roomKind: "report" as const } : {}),
      ...(input.roomKind === "group" ? { roomKind: "group" as const } : {}),
      from: {
        id: sender.id,
        name: sender.displayName,
        handle: sender.handle ?? null,
        bio: sender.bio ?? null,
        avatar: avatarGradient(sender.id),
        followers: 0,
        following: 0,
        isFollowing: false,
      },
      ...(input.body !== undefined ? { body: input.body } : {}),
      kind: input.kind ?? "text",
      attachments: null,
      reactions: [],
      mentions: [],
      createdAt: this.nextDate().toISOString(),
      editedAt: null,
      ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }
    const list = this.log.get(input.cleanupId) ?? []
    list.push({ dto, deleted: false, insertedAtMs: Date.now() })
    this.log.set(input.cleanupId, list)
    return Promise.resolve(this.withReply(input.cleanupId, dto))
  }

  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    _viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    if (around !== undefined) return this.historyAround(cleanupId, around, limit)
    const allDesc = [...(this.log.get(cleanupId) ?? [])].reverse()
    // Anchor resolves against ALL rows, tombstones included (2.4 review): the anchor is only a keyset
    // position, so a deleted cursor id still pages correctly instead of falling back to the newest page.
    let afterAnchor = allDesc
    if (before !== undefined) {
      const idx = allDesc.findIndex((m) => m.dto.id === before)
      if (idx >= 0) afterAnchor = allDesc.slice(idx + 1)
    }
    const ordered = afterAnchor.filter((m) => !m.deleted).map((m) => this.withReply(cleanupId, m.dto))
    const page = ordered.slice(0, limit)
    const nextCursor = ordered.length > limit ? (page[page.length - 1]?.id ?? null) : null
    return Promise.resolve({ items: page, nextCursor })
  }

  /**
   * Around-mode window (P2 2.4), mirroring the drizzle semantics: ceil(limit/2) at-or-older rows (the
   * target INCLUDED — even a tombstoned target anchors, riding as a tombstone while every OTHER deleted
   * row stays filtered) + floor(limit/2) strictly newer, newest-first. nextCursor = older end,
   * prevCursor = newer end (null when that side reaches the edge). Missing/foreign-room target -> 404.
   */
  private historyAround(roomId: string, around: string, limit: number): Promise<ChatHistoryPage> {
    const all = this.log.get(roomId) ?? []
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
        roomId,
        // The store keeps a deleted boolean, not a timestamp; stamp a deletedAt so the tombstone
        // projects like a drizzle tombstone row.
        m.deleted ? { ...m.dto, deletedAt: new Date(m.insertedAtMs).toISOString() } : m.dto,
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
    cleanupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    const stored = (this.log.get(cleanupId) ?? []).find((m) => m.dto.id === messageId && !m.deleted)
    if (!stored) return Promise.resolve(null)
    return Promise.resolve(
      this.withReply(cleanupId, { ...stored.dto, reactions: this.reactionsFor(messageId, viewerUserId) }),
    )
  }

  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean> {
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

  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null> {
    // Id-only scan across rooms (mirrors the drizzle id-only seek), INCLUDING soft-deleted entries. The
    // store keys BOTH cleanup and report rooms by their room id in `log`; roomKind on the stored DTO tells
    // them apart (insertMessage stamps roomKind:"report" for report rows).
    for (const [roomId, list] of this.log) {
      const stored = list.find((m) => m.dto.id === messageId)
      if (stored) {
        const isReport = stored.dto.roomKind === "report"
        const isGroup = stored.dto.roomKind === "group"
        return Promise.resolve({
          id: messageId,
          cleanupId: isReport || isGroup ? null : roomId,
          reportId: isReport ? roomId : null,
          groupId: isGroup ? roomId : null,
          senderId: stored.dto.from?.id ?? null,
          kind: stored.dto.kind,
          // Real insertion time, NOT the deterministic dto clock (see StoredMessage.insertedAtMs).
          createdAt: new Date(stored.insertedAtMs),
          // The store keeps a boolean, not a tombstone timestamp; any non-null Date marks "deleted".
          deletedAt: stored.deleted ? new Date(stored.insertedAtMs) : null,
        })
      }
    }
    return Promise.resolve(null)
  }

  editMessage(
    cleanupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    // Same WHERE gate as softDelete (sender-only, room-scoped, not deleted) but SET body + editedAt.
    const list = this.log.get(cleanupId)
    const found = list?.find((m) => m.dto.id === messageId)
    if (!found || found.deleted || found.dto.from?.id !== senderId) return Promise.resolve(null)
    found.dto = { ...found.dto, body, editedAt: this.nextDate().toISOString() }
    return Promise.resolve(
      this.withReply(cleanupId, {
        ...found.dto,
        reactions: this.reactionsFor(messageId, senderId),
        mine: true,
      }),
    )
  }

  editReportMessage(
    reportId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    return this.editMessage(reportId, messageId, senderId, body)
  }

  softDelete(
    cleanupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null> {
    const list = this.log.get(cleanupId)
    const found = list?.find((m) => m.dto.id === messageId)
    if (!found || found.deleted) return Promise.resolve(null)
    // Sender gate (mirrors the drizzle WHERE): sender-only by default; a moderator bypass (Task 3.5)
    // still refuses sender-less SYSTEM rows. Test-registered senders always populate `from`;
    // optional-chain to satisfy the nullable contract type.
    if (opts?.bypassSenderGate) {
      if (found.dto.from == null) return Promise.resolve(null)
    } else if (found.dto.from?.id !== senderId) {
      return Promise.resolve(null)
    }
    found.deleted = true
    const tombstone: ChatMessageDTO = {
      ...found.dto,
      deletedAt: this.nextDate().toISOString(),
      mine: found.dto.from?.id === senderId,
    }
    return Promise.resolve(this.withReply(cleanupId, tombstone))
  }

  /**
   * Pin/unpin (P3), mirroring the drizzle gate: room-scoped, live, non-system, and only an ACTUAL state
   * change flips pinnedAt (a repeat pin keeps the original stamp). Returns the CURRENT DTO either way;
   * null when missing/deleted.
   */
  setPinned(
    roomId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    const found = (this.log.get(roomId) ?? []).find((m) => m.dto.id === messageId)
    if (!found || found.deleted) return Promise.resolve(null)
    const currentlyPinned = found.dto.pinnedAt != null
    if (found.dto.kind !== "system" && currentlyPinned !== pinned) {
      found.dto = pinned
        ? { ...found.dto, pinnedAt: this.nextDate().toISOString() }
        : (({ pinnedAt: _dropped, ...rest }) => rest)(found.dto)
    }
    return Promise.resolve(
      this.withReply(roomId, { ...found.dto, reactions: this.reactionsFor(messageId, userId) }),
    )
  }

  setReportPinned(
    reportId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    return this.setPinned(reportId, messageId, userId, pinned)
  }

  /** The room's pins, newest-pin first, capped at PIN_LIST_CAP (mirrors the drizzle partial-index query). */
  listPins(roomId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
    const pins = (this.log.get(roomId) ?? [])
      .filter((m) => !m.deleted && m.dto.pinnedAt != null)
      .sort((a, b) => {
        const at = a.dto.pinnedAt!
        const bt = b.dto.pinnedAt!
        return at === bt ? (a.dto.id < b.dto.id ? 1 : -1) : at < bt ? 1 : -1
      })
      .slice(0, PIN_LIST_CAP)
      .map((m) =>
        this.withReply(roomId, { ...m.dto, reactions: this.reactionsFor(m.dto.id, viewerUserId) }),
      )
    return Promise.resolve(pins)
  }

  listReportPins(reportId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
    return this.listPins(reportId, viewerUserId)
  }

  count(cleanupId: string): number {
    return (this.log.get(cleanupId) ?? []).filter((m) => !m.deleted).length
  }

  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    _viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return this.history(reportId, before, limit, _viewerUserId, around)
  }

  findReportMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    return this.findMessage(reportId, messageId, viewerUserId)
  }

  softDeleteReport(
    reportId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null> {
    return this.softDelete(reportId, messageId, senderId, opts)
  }

  countReportMessages(reportId: string): Promise<number> {
    return Promise.resolve(this.count(reportId))
  }

  // P4 group-room twins: like the report twins above, the store keys every room by its room id, so
  // the group methods delegate to the shared room-scoped implementations.
  groupHistory(
    groupId: string,
    before: string | undefined,
    limit: number,
    _viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return this.history(groupId, before, limit, _viewerUserId, around)
  }

  findGroupMessage(
    groupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    return this.findMessage(groupId, messageId, viewerUserId)
  }

  editGroupMessage(
    groupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    return this.editMessage(groupId, messageId, senderId, body)
  }

  softDeleteGroup(
    groupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null> {
    return this.softDelete(groupId, messageId, senderId, opts)
  }

  setGroupPinned(
    groupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null> {
    return this.setPinned(groupId, messageId, userId, pinned)
  }

  listGroupPins(groupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]> {
    return this.listPins(groupId, viewerUserId)
  }
}

interface ThreadMessage {
  createdAt: Date
  senderId: string
  body: string | null
  deleted: boolean
}

interface ThreadCleanup {
  id: string
  title: string
  members: Map<string, Date>
  messages: ThreadMessage[]
}

export class InMemoryThreadsRepository implements ThreadsRepository {
  private readonly cleanups = new Map<string, ThreadCleanup>()

  seedCleanup(title: string, id: string = randomUUID()): string {
    this.cleanups.set(id, { id, title, members: new Map(), messages: [] })
    return id
  }

  addMember(cleanupId: string, userId: string, joinedAt: Date = new Date(0)): void {
    this.cleanups.get(cleanupId)?.members.set(userId, joinedAt)
  }

  addMessage(
    cleanupId: string,
    msg: { senderId: string; body: string | null; createdAt: Date; deleted?: boolean },
  ): void {
    this.cleanups
      .get(cleanupId)
      ?.messages.push({ ...msg, deleted: msg.deleted ?? false })
  }

  listThreadsFor(userId: string, limit: number): Promise<ThreadAggregate[]> {
    const out: ThreadAggregate[] = []
    for (const c of this.cleanups.values()) {
      const joinedAt = c.members.get(userId)
      if (joinedAt === undefined) continue
      const live = c.messages.filter((m) => !m.deleted)
      const last =
        live.length > 0
          ? [...live].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!
          : null
      out.push({
        cleanupId: c.id,
        title: c.title,
        joinedAt,
        members: c.members.size,
        last:
          last !== null
            ? { body: last.body, createdAt: last.createdAt, senderId: last.senderId }
            : null,
      })
    }
    out.sort((a, b) => {
      const at = a.last?.createdAt.getTime() ?? a.joinedAt.getTime()
      const bt = b.last?.createdAt.getTime() ?? b.joinedAt.getTime()
      return bt - at
    })
    return Promise.resolve(out.slice(0, limit))
  }

  countUnread(cleanupId: string, userId: string, after: Date): Promise<number> {
    const c = this.cleanups.get(cleanupId)
    if (!c) return Promise.resolve(0)
    const n = c.messages.filter(
      (m) => !m.deleted && m.senderId !== userId && m.createdAt.getTime() > after.getTime(),
    ).length
    return Promise.resolve(n)
  }
}

export class MockConnection implements ChatConnection {
  readonly id: string
  readonly sent: string[] = []

  constructor(id?: string) {
    this.id = id ?? randomUUID()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.type === type)
  }
}
