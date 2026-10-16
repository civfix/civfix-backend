import type {
  ChatService,
  ChatConnection,
  PersistChatInput,
  ChatHistoryPage,
} from "../interfaces/chat-service.js"
import type { WsServerMessage, ChatMessageDTO, PersonDTO } from "@civfix/contract"
import { makeIdFactory } from "./ids.js"

function fakePerson(userId: string): PersonDTO {
  return {
    id: userId,
    name: `User ${userId.slice(0, 4)}`,
    handle: null,
    bio: null,
    avatar: null,
    followers: 0,
    following: 0,
    isFollowing: false,
  }
}

/**
 * In-process ChatService. Rooms are a Map of cleanupId -> Set<ChatConnection>; broadcast calls
 * conn.send for every member; persist appends to an in-memory log and history pages over it.
 */
export class FakeChatService implements ChatService {
  private readonly rooms = new Map<string, Set<ChatConnection>>()
  private readonly messages = new Map<string, ChatMessageDTO[]>()
  private readonly nextId = makeIdFactory(42)
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  joinRoom(cleanupId: string, conn: ChatConnection, _userId: string): Promise<void> {
    let room = this.rooms.get(cleanupId)
    if (!room) {
      room = new Set()
      this.rooms.set(cleanupId, room)
    }
    room.add(conn)
    return Promise.resolve()
  }

  leaveRoom(cleanupId: string, conn: ChatConnection): Promise<void> {
    this.rooms.get(cleanupId)?.delete(conn)
    return Promise.resolve()
  }

  broadcast(cleanupId: string, msg: ChatMessageDTO): Promise<void> {
    const room = this.rooms.get(cleanupId)
    if (room) {
      const frame = JSON.stringify({ type: "message", message: msg })
      for (const conn of room) conn.send(frame)
    }
    return Promise.resolve()
  }

  /**
   * Fan a non-message server frame (presence delta / typing) to the room, skipping the originator. Keeps
   * parity with the real WS+Redis adapter so the all-fakes dev path renders presence + typing too.
   */
  broadcastEvent(
    cleanupId: string,
    frame: WsServerMessage,
    opts?: { excludeConnId?: string },
  ): Promise<void> {
    const room = this.rooms.get(cleanupId)
    if (room) {
      const data = JSON.stringify(frame)
      for (const conn of room) {
        if (opts?.excludeConnId !== undefined && conn.id === opts.excludeConnId) continue
        conn.send(data)
      }
    }
    return Promise.resolve()
  }

  persist(input: PersistChatInput): Promise<ChatMessageDTO> {
    const msg: ChatMessageDTO = {
      id: this.nextId(),
      cleanupId: input.cleanupId,
      ...(input.roomKind !== undefined ? { roomKind: input.roomKind } : {}),
      from: fakePerson(input.userId),
      body: input.body,
      kind: input.kind ?? "text",
      // The fake has no media pipeline, so a media send over the all-fakes dev path echoes back with no
      // attachments.
      attachments: null,
      createdAt: new Date(this.now()).toISOString(),
      editedAt: null,
      reactions: [],
      mentions: [],
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    }
    const log = this.messages.get(input.cleanupId) ?? []
    log.push(msg)
    this.messages.set(input.cleanupId, log)
    return Promise.resolve(msg)
  }

  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    _viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    const log = this.messages.get(cleanupId) ?? []
    // Newest first. `before` is the id to page backwards from.
    const ordered = [...log].reverse()

    // Around-mode centers the window on the target: ceil(limit/2) rows at-or-older than it (target
    // INCLUDED) + floor(limit/2) strictly newer, still newest-first. nextCursor is the older end (null at
    // the tail), prevCursor the newer end (null at the live head); clients read prevCursor only as a
    // "there are newer messages" signal, since there is no `after` param. An unknown target is a 404,
    // unlike an unknown `before` cursor: a jump target the client explicitly named must exist.
    if (around !== undefined) {
      const idx = ordered.findIndex((m) => m.id === around)
      // NOT AppError: the fakes entry is bundled separately from the package index, so its AppError
      // would be a DIFFERENT class object and consumers' `instanceof AppError` handlers would map it
      // to 500. A fastify-style `statusCode` duck-typed Error renders as an honest 404 everywhere.
      if (idx < 0) return Promise.reject(Object.assign(new Error("Message not found"), { statusCode: 404 }))
      const olderLimit = Math.ceil(limit / 2)
      const newerLimit = Math.floor(limit / 2)
      const newerStart = Math.max(0, idx - newerLimit)
      const window = ordered.slice(newerStart, idx + olderLimit)
      return Promise.resolve({
        items: window,
        nextCursor: idx + olderLimit < ordered.length ? (window[window.length - 1]?.id ?? null) : null,
        prevCursor: newerStart > 0 ? (window[0]?.id ?? null) : null,
      })
    }

    let start = 0
    if (before) {
      const idx = ordered.findIndex((m) => m.id === before)
      if (idx >= 0) start = idx + 1
    }
    const slice = ordered.slice(start, start + limit)
    const nextIndex = start + limit
    const nextCursor = nextIndex < ordered.length ? (slice[slice.length - 1]?.id ?? null) : null
    return Promise.resolve({ items: slice, nextCursor })
  }

  /** Test helper: number of connections currently in a room. */
  roomSize(cleanupId: string): number {
    return this.rooms.get(cleanupId)?.size ?? 0
  }

  reset(): void {
    this.rooms.clear()
    this.messages.clear()
  }
}
