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
 *   - rooms: a ref-counted cleanupId -> Set<ChatConnection> registry of the sockets connected to THIS
 *     worker (see RefCountedSubscriptions, shared with RedisUserChannel / RedisChatPubSub).
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
import type { ChatMessageDTO, WsServerMessage } from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { chatChannel, type ChatPubSub } from "./chat-pubsub.js"
import { RefCountedSubscriptions } from "./ref-counted-subscriptions.js"
import type { ChatRepository } from "../services/chat-repository.drizzle.js"

export interface WsChatServiceDeps {
  /** Persistence seam (insert + history). Drizzle in production, in-memory in tests. */
  repo: ChatRepository
  /** Fan-out seam. Redis in production, in-memory / ioredis-mock in tests. */
  pubsub: ChatPubSub
  /** Injectable id factory for the message id (defaults to crypto.randomUUID). */
  newId?: () => string
}

export class WsChatService implements ChatService {
  private readonly repo: ChatRepository
  private readonly pubsub: ChatPubSub
  private readonly newId: () => string
  /**
   * cleanupId -> the sockets connected to THIS worker, ref-counted: the first join subscribes
   * chat:<cleanupId>, the last leave unsubscribes. The registry inserts the room BEFORE awaiting subscribe
   * (so two concurrent first-joins share ONE subscribe and neither leaks a teardown handle) and DELETES it
   * when the subscribe rejects (so the next join really re-subscribes instead of attaching to a room that
   * receives no pub/sub frames). See RefCountedSubscriptions.
   */
  private readonly rooms: RefCountedSubscriptions<ChatConnection>

  constructor(deps: WsChatServiceDeps) {
    this.repo = deps.repo
    this.pubsub = deps.pubsub
    this.newId = deps.newId ?? (() => randomUUID())
    this.rooms = new RefCountedSubscriptions<ChatConnection>((cleanupId, connections) =>
      this.pubsub.subscribe(chatChannel(cleanupId), (payload) => {
        const { frame, excludeConnId } = decodeEnvelope(payload)
        // Live set: a socket that left mid-delivery is already gone from it.
        for (const c of [...connections()]) {
          if (excludeConnId !== undefined && c.id === excludeConnId) continue
          c.send(frame)
        }
      }),
    )
  }

  /**
   * Admit a connection to a room on this worker. On the first connection for the cleanup, subscribe to
   * the pub/sub channel; the handler delivers every frame received (local or cross-worker) to the room's
   * local sockets. Membership authorization is enforced by the gateway BEFORE this is called.
   */
  async joinRoom(cleanupId: string, conn: ChatConnection, _userId: string): Promise<void> {
    await this.rooms.add(cleanupId, conn)
  }

  /**
   * Remove a connection from a room. When the room becomes empty on this worker, unsubscribe from the
   * pub/sub channel and drop the room so we stop receiving its frames.
   */
  async leaveRoom(cleanupId: string, conn: ChatConnection): Promise<void> {
    await this.rooms.remove(cleanupId, conn)
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
    await this.publishFrame(cleanupId, { type: "message", message: msg }, opts?.excludeConnId)
  }

  /**
   * Fan an EPHEMERAL, un-persisted server frame (presence delta / typing) to the room's live sockets
   * across workers via the SAME pub/sub channel + envelope as messages. Unlike broadcast(), nothing is
   * persisted and the frame is whatever WsServerMessage the gateway built ({type:"presence"} /
   * {type:"typing"}). excludeConnId keeps the originator out of the fan-out (e.g. a typist does not see
   * its own "typing", a joiner gets the presence snapshot instead of its own join delta). Cross-worker
   * recipients are unaffected: the excluded connection only exists on the originator's worker.
   */
  async broadcastEvent(
    cleanupId: string,
    frame: WsServerMessage,
    opts?: { excludeConnId?: string },
  ): Promise<void> {
    await this.publishFrame(cleanupId, frame, opts?.excludeConnId)
  }

  /**
   * Publish one client-facing frame to the room's channel inside the internal `{ frame, excludeConnId? }`
   * envelope. The subscription handler (joinRoom) strips excludeConnId before writing the clean
   * WsServerMessage to each local socket, so the wire frame always matches WsServerMessageSchema exactly.
   */
  private async publishFrame(
    cleanupId: string,
    frame: WsServerMessage,
    excludeConnId: string | undefined,
  ): Promise<void> {
    const envelope = JSON.stringify({
      frame,
      ...(excludeConnId !== undefined ? { excludeConnId } : {}),
    })
    await this.pubsub.publish(chatChannel(cleanupId), envelope)
  }

  /** Insert a message and return its DTO (sender joined). Delegates to the persistence seam. */
  persist(input: PersistChatInput): Promise<ChatMessageDTO> {
    return this.repo.insertMessage(input, this.newId())
  }

  /** Page a cleanup's history newest-first before the cursor. Delegates to the persistence seam.
   *  Forwards `viewerUserId` so each message's reactions resolve the loader's own `mine` flag, and
   *  `around` (P2 2.4) so a center-window jump fetch reaches the repo's around path. */
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage> {
    return this.repo.history(cleanupId, before, limit, viewerUserId, around)
  }

  /**
   * Tear down all room subscriptions (used at shutdown); allSettled inside closeAll, so one rejected
   * unsubscribe does not leave the other rooms behind.
   *
   * The pub/sub layer is NOT closed here: di.ts wires ONE RedisChatPubSub into BOTH this service and
   * RedisUserChannel and closes it itself, after both. Closing it here would mean this service can kill
   * the user channel's live subscriber connection mid-shutdown the moment that close order changes.
   */
  async close(): Promise<void> {
    await this.rooms.closeAll()
  }

  /** Test/diagnostic helper: number of local connections in a room. */
  roomSize(cleanupId: string): number {
    return this.rooms.size(cleanupId)
  }
}

/**
 * Decode a published pub/sub payload into the CLIENT-facing frame string plus the optional excludeConnId.
 * The internal envelope is `{ frame: WsServerMessage, excludeConnId? }`; we strip excludeConnId (it is a
 * server-internal routing hint, not part of the WsServerMessage contract) so clients only ever see the
 * schema-clean frame (`{type:"message",...}` / `{type:"presence",...}` / `{type:"typing",...}`). For
 * resilience across a mixed-version rollout we ALSO accept the legacy `{ type:"message", message }`
 * envelope (the prior message-only shape). A payload that parses as neither (defensive - a non-JSON
 * publish) is passed through verbatim with no exclusion, preserving the prior fan-out-to-all behavior.
 */
function decodeEnvelope(payload: string): { frame: string; excludeConnId: string | undefined } {
  try {
    const parsed = JSON.parse(payload) as {
      frame?: unknown
      type?: unknown
      message?: unknown
      excludeConnId?: unknown
    }
    const excludeConnId =
      typeof parsed.excludeConnId === "string" ? parsed.excludeConnId : undefined
    // Current envelope: a nested WsServerMessage under `frame`. Re-serialize the frame alone (no
    // excludeConnId) so the wire frame matches WsServerMessageSchema exactly.
    if (parsed.frame !== undefined && parsed.frame !== null && typeof parsed.frame === "object") {
      return { frame: JSON.stringify(parsed.frame), excludeConnId }
    }
    // Legacy envelope (message-only): `{ type:"message", message, excludeConnId? }`.
    if (parsed.type === "message" && parsed.message !== undefined) {
      return { frame: JSON.stringify({ type: "message", message: parsed.message }), excludeConnId }
    }
  } catch {
    // fall through: not our envelope, deliver as-is.
  }
  return { frame: payload, excludeConnId: undefined }
}
