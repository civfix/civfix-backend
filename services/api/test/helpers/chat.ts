/**
 * Offline chat test helpers:
 *   - InMemoryChatRepository: a ChatRepository (persist + history) faithful to the Drizzle impl's
 *     observable contract (insert returns a ChatMessageDTO with `from`; history pages newest-first
 *     before a cursor id, excluding soft-deleted rows). Lets the real WsChatService persist/history
 *     paths run with no DB.
 *   - MockConnection: a ChatConnection that records every frame written to it, so a two-connection
 *     real-time test can assert what each side received.
 *
 * The Drizzle-backed repository + the partitioned chat_messages reads are covered by the Docker-gated
 * integration test; these fakes exercise the same seam locally.
 */

import { randomUUID } from "node:crypto"
import { avatarGradient } from "@civfix/shared"
import type { ChatConnection, ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatRepository } from "../../src/services/chat-repository.drizzle.js"
import type { ThreadAggregate, ThreadsRepository } from "../../src/services/threads-service.js"

/** A stored chat message (the persisted fields + the sender person snapshot for the `from` projection). */
interface StoredMessage {
  dto: ChatMessageDTO
  deleted: boolean
}

/** Minimal sender person fields the in-memory repo joins into ChatMessageDTO.from. */
export interface ChatSender {
  id: string
  displayName: string
  handle?: string | null
  bio?: string | null
}

/** An in-memory ChatRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryChatRepository implements ChatRepository {
  /** cleanupId -> append-ordered messages (oldest first). */
  private readonly log = new Map<string, StoredMessage[]>()
  /** userId -> sender person fields, so `from` resolves. */
  private readonly senders = new Map<string, ChatSender>()
  /** Monotonic clock so created_at ordering is deterministic across inserts. */
  private tick = 0

  /** Register (or update) a sender's person fields so persisted messages carry a real `from`. */
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
      attachments: input.attachments ?? null,
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
    // Newest-first.
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

  /** Test helper: soft-delete a message (so history excludes it). */
  softDelete(cleanupId: string, messageId: string): void {
    const list = this.log.get(cleanupId)
    const found = list?.find((m) => m.dto.id === messageId)
    if (found) found.deleted = true
  }

  /** Test helper: total persisted (non-deleted) messages for a cleanup. */
  count(cleanupId: string): number {
    return (this.log.get(cleanupId) ?? []).filter((m) => !m.deleted).length
  }
}

/** A message in the in-memory threads store (the subset countUnread + last-message need). */
interface ThreadMessage {
  createdAt: Date
  senderId: string
  body: string | null
  deleted: boolean
}

/** A cleanup thread in the in-memory threads store: members (with joined_at) + its messages. */
interface ThreadCleanup {
  id: string
  title: string
  members: Map<string, Date> // userId -> joinedAt
  messages: ThreadMessage[]
}

/**
 * A self-contained in-memory ThreadsRepository for the GET /threads tests. Faithful to the Drizzle
 * impl's observable contract: listThreadsFor returns the viewer's cleanups (membership) with the
 * last-message + member-count, most-recent-activity first; countUnread counts others' messages strictly
 * after the watermark, excluding soft-deleted rows.
 */
export class InMemoryThreadsRepository implements ThreadsRepository {
  private readonly cleanups = new Map<string, ThreadCleanup>()

  /** Seed a cleanup with a title. Returns its id. */
  seedCleanup(title: string, id: string = randomUUID()): string {
    this.cleanups.set(id, { id, title, members: new Map(), messages: [] })
    return id
  }

  /** Add a member (with an optional joined_at) to a seeded cleanup. */
  addMember(cleanupId: string, userId: string, joinedAt: Date = new Date(0)): void {
    this.cleanups.get(cleanupId)?.members.set(userId, joinedAt)
  }

  /** Append a message to a seeded cleanup. */
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
      if (joinedAt === undefined) continue // not a member -> not the viewer's thread.
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
    // Most recent activity first (last message, else joined_at).
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

/**
 * A ChatConnection that records every frame written to it. Stands in for a real WebSocket so a
 * two-connection test can assert exactly what each side received (the broadcast frame, the ack frame).
 */
export class MockConnection implements ChatConnection {
  readonly id: string
  readonly sent: string[] = []

  constructor(id?: string) {
    this.id = id ?? randomUUID()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Parsed view of every frame received, for convenient assertions. */
  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  /** The frames of a given `type`. */
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.type === type)
  }
}
