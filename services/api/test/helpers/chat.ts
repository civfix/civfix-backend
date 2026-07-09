
import { randomUUID } from "node:crypto"
import { avatarGradient } from "@civfix/shared"
import type { ChatConnection, ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import type { ChatMessageDTO, ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"
import type { ChatRepository } from "../../src/services/chat-repository.drizzle.js"
import type { ThreadAggregate, ThreadsRepository } from "../../src/services/threads-service.js"

interface StoredMessage {
  dto: ChatMessageDTO
  deleted: boolean
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

  insertMessage(input: PersistChatInput, id: string): Promise<ChatMessageDTO> {
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
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }
    const list = this.log.get(input.cleanupId) ?? []
    list.push({ dto, deleted: false })
    this.log.set(input.cleanupId, list)
    return Promise.resolve(dto)
  }

  history(cleanupId: string, before: string | undefined, limit: number): Promise<ChatHistoryPage> {
    const list = (this.log.get(cleanupId) ?? []).filter((m) => !m.deleted)
    const ordered = [...list].reverse().map((m) => m.dto)
    let start = 0
    if (before !== undefined) {
      const idx = ordered.findIndex((m) => m.id === before)
      if (idx >= 0) start = idx + 1
    }
    const page = ordered.slice(start, start + limit)
    const nextIndex = start + limit
    const nextCursor = nextIndex < ordered.length ? (page[page.length - 1]?.id ?? null) : null
    return Promise.resolve({ items: page, nextCursor })
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
    return Promise.resolve({ ...stored.dto, reactions: this.reactionsFor(messageId, viewerUserId) })
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

  softDelete(
    cleanupId: string,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null> {
    const list = this.log.get(cleanupId)
    const found = list?.find((m) => m.dto.id === messageId)
    // Test-registered senders always populate `from`; optional-chain to satisfy the nullable contract
    // type without changing the WHERE-gate semantics for the normal (author-present) case.
    if (!found || found.deleted || found.dto.from?.id !== senderId) return Promise.resolve(null)
    found.deleted = true
    const tombstone: ChatMessageDTO = {
      ...found.dto,
      deletedAt: this.nextDate().toISOString(),
      mine: true,
    }
    return Promise.resolve(tombstone)
  }

  count(cleanupId: string): number {
    return (this.log.get(cleanupId) ?? []).filter((m) => !m.deleted).length
  }

  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    _viewerUserId?: string | null,
  ): Promise<ChatHistoryPage> {
    return this.history(reportId, before, limit)
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
  ): Promise<ChatMessageDTO | null> {
    return this.softDelete(reportId, messageId, senderId)
  }

  countReportMessages(reportId: string): Promise<number> {
    return Promise.resolve(this.count(reportId))
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
