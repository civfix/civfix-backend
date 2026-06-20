/**
 * In-memory DmRepository + BlocksRepository: dependency-free implementations for the USE_FAKE_CHAT dev
 * path (no DB) and for unit tests. They mirror the observable contract of the Drizzle impls:
 *
 *   - InMemoryDmRepository: threads keyed by the ordered pair (lo<hi); messages stored per thread, history
 *     paged newest-first before a cursor id; monotonic per-(thread,user) read watermark; listThreadsForUser
 *     excludes any thread blocked either way (via an injected block check) and computes peer + last + unread.
 *   - InMemoryBlocksRepository: directed block edges with a bidirectional check.
 *
 * Senders/users are registered so persisted DTOs carry a real `from` and threads carry a real peer. In the
 * dev path the gateway's isParticipant is permissive (see di.ts), so these just need to persist + page.
 */

import { randomUUID } from "node:crypto"
import { avatarGradient } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji, ReactionSummaryDTO } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import type {
  DmPersistInput,
  DmRepository,
  DmThread,
  DmThreadAggregate,
} from "./dm-repository.drizzle.js"
import type { BlocksRepository } from "./blocks-repository.drizzle.js"
import type { PersonDTO } from "@civfix/shared"

/** Minimal user fields the in-memory dm/threads paths need to build `from` / `peer`. */
export interface DmUser {
  id: string
  displayName: string
  handle?: string | null
  bio?: string | null
  avatarUrl?: string | null
}

interface StoredDmMessage {
  dto: ChatMessageDTO
  deleted: boolean
}

/** Order a user pair so (lo, hi) is stable regardless of who initiates. */
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export class InMemoryDmRepository implements DmRepository {
  /** threadId -> thread. */
  private readonly threads = new Map<string, DmThread>()
  /** `${lo}:${hi}` -> threadId. */
  private readonly byPair = new Map<string, string>()
  /** threadId -> append-ordered messages (oldest first). */
  private readonly log = new Map<string, StoredDmMessage[]>()
  /** `${threadId}:${userId}` -> last-read epoch ms. */
  private readonly reads = new Map<string, number>()
  /** messageId -> set of `${userId}:${emoji}` reaction keys (mirrors the chat_message_reactions PK). */
  private readonly reactions = new Map<string, Set<string>>()
  /** userId -> user fields, so `from`/`peer` resolve. */
  private readonly users = new Map<string, DmUser>()
  private tick = 0

  /** Optional injected block check so listThreadsForUser excludes blocked-either-way threads. */
  constructor(private readonly isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>) {}

  registerUser(user: DmUser): void {
    this.users.set(user.id, user)
  }

  private userOf(id: string): DmUser {
    return this.users.get(id) ?? { id, displayName: `User ${id.slice(0, 4)}`, handle: null, bio: null }
  }

  private nextDate(): Date {
    this.tick += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.tick))
  }

  openOrCreateThread(userA: string, userB: string): Promise<DmThread> {
    const [lo, hi] = orderPair(userA, userB)
    const key = `${lo}:${hi}`
    const existingId = this.byPair.get(key)
    if (existingId) return Promise.resolve(this.threads.get(existingId)!)
    const thread: DmThread = { id: randomUUID(), userLo: lo, userHi: hi, createdAt: this.nextDate() }
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

  /** The OTHER participant of the thread, or null when `userId` is not in it. */
  peerOf(threadId: string, userId: string): string | null {
    const t = this.threads.get(threadId)
    if (!t) return null
    if (t.userLo === userId) return t.userHi
    if (t.userHi === userId) return t.userLo
    return null
  }

  persist(input: DmPersistInput): Promise<ChatMessageDTO> {
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
        followers: 0,
        following: 0,
        isFollowing: false,
      },
      body: input.body,
      kind: input.kind ?? "text",
      attachments: input.attachments ?? null,
      reactions: [],
      // No persisted mentions on a fresh insert; the gateway projects a send's resolved @-mentions onto its
      // broadcast/ack copy (this in-memory repo keeps no mention store, the dev-path mention bell being moot).
      mentions: [],
      createdAt: this.nextDate().toISOString(),
      editedAt: null,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }
    const list = this.log.get(input.threadId) ?? []
    list.push({ dto, deleted: false })
    this.log.set(input.threadId, list)
    return Promise.resolve(dto)
  }

  editMessage(
    threadId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null> {
    // Mirror the Drizzle WHERE gate: the message must exist in THIS thread, be sent by `senderId`, and not be
    // soft-deleted. Otherwise return null (not-found OR forbidden — indistinguishable, like the SQL no-op).
    const stored = (this.log.get(threadId) ?? []).find(
      (m) => m.dto.id === messageId && m.dto.from.id === senderId && !m.deleted,
    )
    if (!stored) return Promise.resolve(null)
    const edited: ChatMessageDTO = {
      ...stored.dto,
      body,
      editedAt: this.nextDate().toISOString(),
    }
    stored.dto = edited
    return Promise.resolve(edited)
  }

  softDelete(
    threadId: string,
    messageId: string,
    senderId: string,
  ): Promise<ChatMessageDTO | null> {
    // Same WHERE gate as editMessage: exist in THIS thread, sent by `senderId`, not already deleted.
    const stored = (this.log.get(threadId) ?? []).find(
      (m) => m.dto.id === messageId && m.dto.from.id === senderId && !m.deleted,
    )
    if (!stored) return Promise.resolve(null)
    stored.deleted = true
    const tombstone: ChatMessageDTO = {
      ...stored.dto,
      deletedAt: this.nextDate().toISOString(),
      mine: true,
    }
    return Promise.resolve(tombstone)
  }

  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId: string | null = null,
  ): Promise<ChatHistoryPage> {
    const list = (this.log.get(threadId) ?? []).filter((m) => !m.deleted)
    // Recompute each item's reactions against the viewer so `mine` is resolved on the history page (the
    // stored DTO's reactions were last computed for whoever toggled). Mirrors the drizzle history path.
    const ordered = [...list]
      .reverse()
      .map((m) => ({ ...m.dto, reactions: this.reactionsFor(m.dto.id, viewerUserId) }))
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

  /** Aggregate a message's reactions into the wire summary, resolving `mine` for the viewer. */
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

  markRead(threadId: string, userId: string, at: Date): Promise<void> {
    const key = `${threadId}:${userId}`
    const prev = this.reads.get(key) ?? 0
    if (at.getTime() > prev) this.reads.set(key, at.getTime())
    return Promise.resolve()
  }

  lastReadAt(threadId: string, userId: string): Promise<Date | null> {
    const ms = this.reads.get(`${threadId}:${userId}`)
    return Promise.resolve(ms !== undefined ? new Date(ms) : null)
  }

  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null> {
    const found = (this.log.get(threadId) ?? []).find((m) => m.dto.id === messageId)
    return Promise.resolve(found ? new Date(found.dto.createdAt) : null)
  }

  async listThreadsForUser(userId: string): Promise<DmThreadAggregate[]> {
    const out: DmThreadAggregate[] = []
    for (const t of this.threads.values()) {
      const peerId = t.userLo === userId ? t.userHi : t.userHi === userId ? t.userLo : null
      if (peerId === null) continue
      if (this.isBlockedEitherWay && (await this.isBlockedEitherWay(userId, peerId))) continue

      const peer = this.userOf(peerId)
      const live = (this.log.get(t.id) ?? []).filter((m) => !m.deleted).map((m) => m.dto)
      const last = live.length > 0 ? live[live.length - 1]! : null
      const lastReadMs = this.reads.get(`${t.id}:${userId}`) ?? 0
      const baseline = Math.max(t.createdAt.getTime(), lastReadMs)
      const unread = live.filter(
        (m) => m.from.id === peerId && new Date(m.createdAt).getTime() > baseline,
      ).length

      out.push({
        threadId: t.id,
        createdAt: t.createdAt,
        peer: {
          id: peer.id,
          displayName: peer.displayName,
          handle: peer.handle ?? null,
          bio: peer.bio ?? null,
          avatarUrl: peer.avatarUrl ?? null,
        },
        last:
          last !== null
            ? { body: last.body ?? null, createdAt: new Date(last.createdAt), senderId: last.from.id }
            : null,
        unread,
      })
    }
    out.sort(
      (a, b) =>
        (b.last?.createdAt ?? b.createdAt).getTime() - (a.last?.createdAt ?? a.createdAt).getTime(),
    )
    return out
  }
}

/** In-memory directed block edges with a bidirectional test + a blocked-list projection. */
export class InMemoryBlocksRepository implements BlocksRepository {
  /** blockerId -> set of blockedId. */
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

  listBlocked(blockerId: string): Promise<PersonDTO[]> {
    const ids = [...(this.edges.get(blockerId) ?? [])]
    const people: PersonDTO[] = ids.map((id) => {
      const u = this.users.get(id) ?? { id, displayName: `User ${id.slice(0, 4)}` }
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
      }
    })
    return Promise.resolve(people)
  }
}
