import type { RoomKind } from "@civfix/shared"
import type { ChatService, ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { ChatPresence } from "../adapters/chat-presence.js"

export const WS_HEARTBEAT_MS = 30_000

/** RFC 6455 policy-violation close code, used when a handshake is rejected. */
export const WS_CLOSE_POLICY_VIOLATION = 1008

/** Server-side typing-throttle window: at most one typing fan-out per room per connection. */
export const TYPING_MIN_INTERVAL_MS = 1000

/**
 * Outbound-buffer backpressure threshold (bytes). A slow/stalled client whose `bufferedAmount` exceeds
 * this is shedding load: droppable frames (presence/typing) are skipped, and a client that stays over it
 * across consecutive heartbeat ticks is terminated. 1 MiB; pairs with the heartbeat reaper.
 */
export const WS_BUFFER_DROP_THRESHOLD = 1024 * 1024

/** Consecutive over-threshold heartbeat ticks before a backpressured socket is terminated. */
export const WS_BUFFER_TERMINATE_TICKS = 2

/** Membership probe: is `userId` a member of `cleanupId`? (cleanup membership == chat membership). */
export type IsMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

/** Optional read-state updater (per-user last-read), used by the `ack` frame. No-op when omitted. */
export type MarkReadFn = (cleanupId: string, userId: string, upToId: string) => Promise<void>

/**
 * Optional "mark read on OPEN" updater: advance `userId`'s read watermark for a conversation up to NOW when
 * they JOIN (open) it — distinct from the id-anchored `ack` markRead. A quick/cold open can drop the client
 * read-ack (the conversation history, and so the newest message id to ack, has not loaded before the viewer
 * taps back), which left the unread badge stuck (#42). The `join` frame is the reliable "opened this thread"
 * signal (and is re-sent on auto-rejoin), so the watermark advances here regardless of client timing. Wired
 * for cleanup + dm; report_discussion has no per-user read-state. No-op when omitted. Best-effort: a join
 * must never fail on a read-state error.
 */
export type MarkReadOnOpenFn = (kind: RoomKind, id: string, userId: string) => Promise<void>

/**
 * The DM seam the gateway drives for `roomKind:"dm"` frames, addressed by thread id: a participant probe,
 * a persist (returns the broadcastable DTO), a markRead watermark, and a peerOf lookup (the OTHER
 * participant) so block checks can run before a join or send. Optional on GatewayDeps; the frame handler
 * refuses dm frames when it is absent.
 */
export interface GatewayDmDeps {
  isParticipant(threadId: string, userId: string): Promise<boolean>
  /** The OTHER participant of the thread (for the block check), or null when `userId` is not in it. */
  peerOf(threadId: string, userId: string): Promise<string | null>
  persist(input: {
    threadId: string
    senderId: string
    body: string
    kind?: import("@civfix/shared").ChatMessageKind
    clientId?: string
    mediaUploadIds?: string[]
  }): Promise<import("@civfix/shared").ChatMessageDTO>
  markRead(threadId: string, userId: string, upToId: string): Promise<void>
}

/** Bidirectional block check: is `a` blocked by `b` or vice versa? Used to gate dm join/send. */
export type IsBlockedEitherWayFn = (a: string, b: string) => Promise<boolean>

/**
 * Resolve the per-user signal recipients for a freshly-persisted message in room `(kind, id)`, EXCLUDING
 * the sender. Lets the gateway fire a `{topic:"threads", id}` invalidate-signal WITHOUT importing any repo
 * (the caller wires the cleanup-members / dm-peer lookup). Best-effort: a failure here must never affect
 * the send path.
 */
export type ThreadRecipientsOf = (kind: RoomKind, id: string, senderId: string) => Promise<string[]>

/**
 * Best-effort hook fired AFTER a dm message is persisted + broadcast + acked, when the recipient is NOT
 * actively viewing that dm room (presence-suppressed so a message the recipient is reading right now does
 * not also raise a bell). `recipientId` is the peer (never the sender). A failure here MUST NEVER affect
 * the send path.
 */
export type OnDmDelivered = (
  threadId: string,
  recipientId: string,
  message: import("@civfix/shared").ChatMessageDTO,
) => Promise<void>

/**
 * The chat @-mention seam the gateway drives on a `send` frame. Split into three optional hooks; all run
 * AFTER persist, so a mention failure can never block the message. Anyone may be named; blocks/prefs gate
 * only the NOTIFICATION.
 */
export interface GatewayChatMentions {
  resolveChatMentions(input: {
    handles: string[]
    userIds: string[]
    authorUserId: string
    /** The room being posted to — scopes mentions to people IN that room (a non-member @handle resolves
     *  to nothing). */
    kind: RoomKind
    roomId: string
  }): Promise<import("@civfix/shared").UserMentionDTO[]>
  recordChatMentions(messageId: string, mentionedUserIds: string[]): Promise<void>
  notifyChatMention(input: {
    kind: RoomKind
    roomId: string
    actorUserId: string
    mentionedUserId: string
    message: import("@civfix/shared").ChatMessageDTO
  }): Promise<void>
}

/**
 * The ChatService the gateway drives. Identical to the shared ChatService except `broadcast` accepts an
 * OPTIONAL excludeConnId so the gateway can keep the sender out of the fan-out (it learns durability from
 * the ack instead, P1-2). A 2-arg ChatService.broadcast is assignable here, so both the real
 * WsChatService (which uses the hint) and the FakeChatService (which ignores it) satisfy this type without
 * a change to the frozen shared interface.
 */
export type GatewayChatService = Omit<ChatService, "broadcast"> & {
  broadcast(
    cleanupId: string,
    msg: Parameters<ChatService["broadcast"]>[1],
    opts?: { excludeConnId?: string },
  ): Promise<void>
}

/** The dependencies the gateway frame handler needs (no Fastify/socket types here so it stays testable). */
export interface GatewayDeps {
  chat: GatewayChatService
  isMember: IsMemberFn
  markRead?: MarkReadFn | undefined
  markReadOnOpen?: MarkReadOnOpenFn | undefined
  presence?: ChatPresence | undefined
  /** Absent ⇒ dm refused. */
  dm?: GatewayDmDeps | undefined
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  userChannel?: UserChannel | undefined
  threadRecipientsOf?: ThreadRecipientsOf | undefined
  onDmDelivered?: OnDmDelivered | undefined
  chatMentions?: GatewayChatMentions | undefined
}

/**
 * Per-connection session: the authenticated user, the wrapped connection, the rooms this socket has joined
 * (so close can leave them all), the deps, and a per-room typing throttle clock. One per socket.
 */
export interface GatewaySession {
  readonly userId: string
  readonly conn: ChatConnection
  readonly joined: Set<string>
  readonly deps: GatewayDeps
  /** Per-room last typing-broadcast epoch ms (server-side throttle). Mutated in place. */
  readonly typingThrottle: Map<string, number>
}

export type WsHandshakeResult =
  | { ok: true; userId: string }
  | { ok: false; code: "FORBIDDEN" | "UNAUTHORIZED"; message: string; reason: string }

export interface RegisterGatewayOptions {
  chat: ChatService
  isMember: IsMemberFn
  /** Session service for resolving the ?token query param (mobile). */
  sessions: import("../auth/session-service.js").SessionService | undefined
  markRead?: MarkReadFn | undefined
  markReadOnOpen?: MarkReadOnOpenFn | undefined
  presence?: ChatPresence | undefined
  dm?: GatewayDmDeps | undefined
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  /**
   * Optional per-user signal channel. When wired, every authenticated socket subscribes its user on the
   * channel for the socket's lifetime, and the `send` handler fires a `{topic:"threads"}` signal to the
   * message recipients.
   */
  userChannel?: UserChannel | undefined
  threadRecipientsOf?: ThreadRecipientsOf | undefined
  onDmDelivered?: OnDmDelivered | undefined
  chatMentions?: GatewayChatMentions | undefined
  /** CORS/WS Origin allowlist (env.WEB_ORIGINS). Empty allows all (dev). See isAllowedWsOrigin. */
  webOrigins: readonly string[]
}
