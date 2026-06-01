/**
 * REAL ChatService adapter: in-process room membership for THIS node + Redis pub/sub fan-out so a
 * message published on one Node worker reaches connections on another, plus Postgres-backed persist +
 * history.
 *
 * Seam rule: the realtime transport / Redis SDK is confined to this file and the chat-pubsub / redis
 * modules; domain code talks only to the ChatService interface. Both the pub/sub layer and the
 * persistence layer are INJECTED, so tests build this real adapter over an in-memory pub/sub (or
 * ioredis-mock) and an in-memory ChatRepository to prove the fan-out + persistence with no infra.
 *
 * ROOM + FAN-OUT MODEL:
 *   - rooms: Map<cleanupId, Set<ChatConnection>> holds the sockets connected to THIS worker.
 *   - On the first local join for a cleanup, we SUBSCRIBE to the pub/sub channel chat:<cleanupId>. The
 *     subscription handler parses each delivered frame and writes it to every local connection in the
 *     room. On the last local leave, we unsubscribe and drop the room.
 *   - broadcast(cleanupId, msg) PUBLISHES the {type:"message"} frame to chat:<cleanupId>. Every worker
 *     subscribed to that channel (including this one) then delivers it to its own local sockets. This is
 *     why a sender on worker B and a recipient on worker A both see the message: the recipient's worker
 *     received it via Redis and wrote it to the recipient's socket.
 *
 * Delivering via the subscription (rather than writing to local sockets directly in broadcast) means
 * there is exactly ONE delivery path, so local and cross-worker recipients are treated identically and
 * a message is never double-sent to a local socket.
 *
 * SENDER EXACTLY-ONCE (P1-2): the sender's own socket is in the room, so the broadcast {type:"message"}
 * frame would ALSO reach it on top of the separate {type:"ack"} frame - a double-delivery the sender's
 * client would render twice. broadcast therefore accepts an optional excludeConnId (the sender's
 * connection id, threaded by the gateway). The id rides INSIDE the published envelope (not the
 * client-facing frame), and the subscription handler skips the matching local connection before sending
 * the schema-clean {type:"message"} frame to everyone else. The sender learns durability from the ack
 * alone, so delivery to the sender is exactly-once. Cross-worker recipients are unaffected: the excluded
 * connection only exists on the sender's worker, so other workers deliver to all their local sockets.
 */

import type {
  ChatService,
  ChatConnection,
  PersistChatInput,
  ChatHistoryPage,
} from "@civfix/shared/interfaces"
import type { ChatMessageDTO } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { chatChannel, type ChatPubSub } from "./chat-pubsub.js"
import type { ChatRepository } from "../services/chat-repository.drizzle.js"

export interface WsChatServiceDeps {
  /** Persistence seam (insert + history). Drizzle in production, in-memory in tests. */
  repo: ChatRepository
  /** Fan-out seam. Redis in production, in-memory / ioredis-mock in tests. */
  pubsub: ChatPubSub
  /** Injectable id factory for the message id (defaults to crypto.randomUUID). */
  newId?: () => string
}

/** Per-room local state: the connected sockets on this worker + the pub/sub unsubscribe handle. */
interface Room {
  connections: Set<ChatConnection>
  unsubscribe: () => Promise<void>
}

export class WsChatService implements ChatService {
  private readonly repo: ChatRepository
  private readonly pubsub: ChatPubSub
  private readonly newId: () => string
  private readonly rooms = new Map<string, Room>()

  constructor(deps: WsChatServiceDeps) {
    this.repo = deps.repo
    this.pubsub = deps.pubsub
    this.newId = deps.newId ?? (() => randomUUID())
  }

  /**
   * Admit a connection to a room on this worker. On the first connection for the cleanup, subscribe to
   * the pub/sub channel; the handler delivers every frame received (local or cross-worker) to the room's
   * local sockets. Membership authorization is enforced by the gateway BEFORE this is called.
   */
  async joinRoom(cleanupId: string, conn: ChatConnection, _userId: string): Promise<void> {
    let room = this.rooms.get(cleanupId)
    if (!room) {
      const connections = new Set<ChatConnection>()
      // Subscribe first so no published frame is missed once the room exists. The handler decodes the
      // internal envelope (message + optional excludeConnId), then delivers the CLIENT-facing
      // {type:"message"} frame to every local connection EXCEPT the excluded one (the sender, P1-2).
      const unsubscribe = await this.pubsub.subscribe(chatChannel(cleanupId), (payload) => {
        const current = this.rooms.get(cleanupId)
        if (!current) return
        const { frame, excludeConnId } = decodeEnvelope(payload)
        for (const c of current.connections) {
          if (excludeConnId !== undefined && c.id === excludeConnId) continue
          c.send(frame)
        }
      })
      room = { connections, unsubscribe }
      this.rooms.set(cleanupId, room)
    }
    room.connections.add(conn)
  }

  /**
   * Remove a connection from a room. When the room becomes empty on this worker, unsubscribe from the
   * pub/sub channel and drop the room so we stop receiving its frames.
   */
  async leaveRoom(cleanupId: string, conn: ChatConnection): Promise<void> {
    const room = this.rooms.get(cleanupId)
    if (!room) return
    room.connections.delete(conn)
    if (room.connections.size === 0) {
      this.rooms.delete(cleanupId)
      await room.unsubscribe()
    }
  }

  /**
   * Publish a message to the cleanup's channel. Delivery to sockets happens in the subscription handler
   * (single delivery path), so this method does not touch local sockets directly. The OPTIONAL
   * excludeConnId (the sender's connection id) rides inside the internal envelope so the handler can skip
   * the sender's own socket - the sender reconciles via the separate ack frame instead (exactly-once,
   * P1-2). The third parameter is optional, so this still satisfies the (2-arg) ChatService.broadcast.
   */
  async broadcast(
    cleanupId: string,
    msg: ChatMessageDTO,
    opts?: { excludeConnId?: string },
  ): Promise<void> {
    const envelope = JSON.stringify({
      type: "message",
      message: msg,
      ...(opts?.excludeConnId !== undefined ? { excludeConnId: opts.excludeConnId } : {}),
    })
    await this.pubsub.publish(chatChannel(cleanupId), envelope)
  }

  /** Insert a message and return its DTO (sender joined). Delegates to the persistence seam. */
  persist(input: PersistChatInput): Promise<ChatMessageDTO> {
    return this.repo.insertMessage(input, this.newId())
  }

  /** Page a cleanup's history newest-first before the cursor. Delegates to the persistence seam. */
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
  ): Promise<ChatHistoryPage> {
    return this.repo.history(cleanupId, before, limit)
  }

  /**
   * Tear down all room subscriptions AND the pub/sub layer (used at shutdown). Unsubscribing each room
   * leaves the underlying Redis subscriber connection open; the pub/sub owns that DEDICATED duplicated
   * connection (see RedisChatPubSub), so we must close it here. The DI container's `redis.disconnect()`
   * only closes the SHARED client, not the duplicate - so without this the subscriber connection would
   * leak and keep the event loop alive, preventing a clean process exit on SIGTERM.
   */
  async close(): Promise<void> {
    const unsubs = [...this.rooms.values()].map((r) => r.unsubscribe())
    this.rooms.clear()
    await Promise.all(unsubs)
    await this.pubsub.close()
  }

  /** Test/diagnostic helper: number of local connections in a room. */
  roomSize(cleanupId: string): number {
    return this.rooms.get(cleanupId)?.connections.size ?? 0
  }
}

/**
 * Decode a published pub/sub payload into the CLIENT-facing frame string plus the optional excludeConnId.
 * The internal envelope is `{ type:"message", message, excludeConnId? }`; we strip excludeConnId (it is a
 * server-internal routing hint, not part of the WsServerMessage contract) so clients only ever see the
 * schema-clean `{ type:"message", message }`. A payload that does not parse as such an envelope (defensive
 * - a future frame shape, or a non-JSON publish) is passed through verbatim with no exclusion, preserving
 * the prior fan-out-to-all behavior.
 */
function decodeEnvelope(payload: string): { frame: string; excludeConnId: string | undefined } {
  try {
    const parsed = JSON.parse(payload) as {
      type?: unknown
      message?: unknown
      excludeConnId?: unknown
    }
    if (parsed.type === "message" && parsed.message !== undefined) {
      const excludeConnId =
        typeof parsed.excludeConnId === "string" ? parsed.excludeConnId : undefined
      // Re-serialize WITHOUT excludeConnId so the wire frame matches WsServerMessageSchema exactly.
      const frame = JSON.stringify({ type: "message", message: parsed.message })
      return { frame, excludeConnId }
    }
  } catch {
    // fall through: not our envelope, deliver as-is.
  }
  return { frame: payload, excludeConnId: undefined }
}
