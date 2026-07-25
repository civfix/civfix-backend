import type { RoomKind } from "@civfix/shared"
import type { ChatService, ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { ChatPresence } from "../adapters/chat-presence.js"
import type { RateLimiter } from "./report-rate-limit.js"

export const WS_HEARTBEAT_MS = 30_000

export type ReportVisibleFn = (reportId: string, userId: string | null) => Promise<boolean>

export const WS_CLOSE_POLICY_VIOLATION = 1008

export const TYPING_MIN_INTERVAL_MS = 1000

/**
 * SECURITY (M13): the PER-CONNECTION frame budget covering EVERY client frame type, applied in
 * handleClientFrame before dispatch.
 *
 * Before this, only `send` was metered (the per-user+room send buckets in socket-lifecycle). `join` and
 * `typing` each cost a Postgres membership query plus Redis round trips, and `ack` a watermark write —
 * all unmetered, while a single host may hold MAX_CONNECTIONS_PER_IP (30) sockets, each able to loop
 * frames as fast as the socket drains.
 *
 * 60 burst / 10 per second is far above any human client (a real session opens a handful of rooms and
 * types at ~1 typing frame/sec/room, itself throttled by TYPING_MIN_INTERVAL_MS) while bounding one
 * connection to 10 backend round trips per second sustained. Exhausting the bucket answers with a
 * RATE_LIMITED error frame and drops the frame — the socket is NOT closed, so a bursty-but-legitimate
 * client (e.g. re-joining many rooms after a reconnect) simply retries.
 */
export const WS_FRAME_LIMIT = { capacity: 60, refillPerSec: 10 } as const

/**
 * M1: how often a live socket's credential is fully re-resolved (session still exists / not revoked)
 * when the connection retained a session token. The cheap banned-account check runs on EVERY heartbeat
 * tick; the full resolve is throttled to this interval because it also slides the session's expiry.
 */
export const WS_REAUTH_INTERVAL_MS = 60_000

export const WS_BUFFER_DROP_THRESHOLD = 1024 * 1024

export const WS_BUFFER_TERMINATE_TICKS = 2

export type IsMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

export type MarkReadFn = (cleanupId: string, userId: string, upToId: string) => Promise<void>

export type MarkReadOnOpenFn = (kind: RoomKind, id: string, userId: string) => Promise<void>

export interface GatewayDmDeps {
  isParticipant(threadId: string, userId: string): Promise<boolean>
  peerOf(threadId: string, userId: string): Promise<string | null>
  persist(input: {
    threadId: string
    senderId: string
    body: string
    kind?: import("@civfix/shared").ChatMessageKind
    clientId?: string
    mediaUploadIds?: string[]
    replyToId?: string
  }): Promise<import("@civfix/shared").ChatMessageDTO>
  markRead(threadId: string, userId: string, upToId: string): Promise<void>
}

export type IsBlockedEitherWayFn = (a: string, b: string) => Promise<boolean>

export type ThreadRecipientsOf = (kind: RoomKind, id: string, senderId: string) => Promise<string[]>

export type OnDmDelivered = (
  threadId: string,
  recipientId: string,
  message: import("@civfix/shared").ChatMessageDTO,
) => Promise<void>

export type OnReportMessage = (
  reportId: string,
  message: import("@civfix/shared").ChatMessageDTO,
) => Promise<void>

/**
 * P4 4.5: post-send effect for GROUP rooms — the member bell fan-out (group-chat-notifier), fired
 * fire-and-forget from frame-handler after a group send, mirroring onReportMessage for report rooms.
 */
export type OnGroupMessage = (
  groupId: string,
  message: import("@civfix/shared").ChatMessageDTO,
) => Promise<void>

/**
 * P2 2.5 reply bell seam: fired after a send whose message replies to another user's message.
 * `targetUserId` is the replied-to message's SENDER (from the hydrated replyTo preview — never the
 * author themself, never a sender-less SYSTEM target; frame-handler filters those). Implemented by
 * chat-bells makeChatReplyNotifier in the wiring; dm rooms are a no-op (the dm delivered bell owns
 * dm reply flavor).
 */
export type OnChatReply = (input: {
  kind: RoomKind
  roomId: string
  actorUserId: string
  targetUserId: string
  message: import("@civfix/shared").ChatMessageDTO
}) => Promise<void>

/**
 * Subset of the D-C1 ReportChatRepository the WS gateway needs. Report rooms are PUBLIC to join but
 * MEMBER-ONLY to post/type; reads advance a per-member watermark. Injected via chat-gateway-wiring so
 * routes and the socket share one instance. User-message persistence stays on `deps.chat.persist`
 * ({ roomKind: "report" }) — the shipped #18 path — so this interface deliberately has no insertUserMessage.
 */
export interface GatewayReportChat {
  isMember(reportId: string, userId: string): Promise<boolean>
  advanceReadWatermark(reportId: string, userId: string, upToId: string): Promise<void>
}

/** The WS group lane's read-vs-send decision inputs (P5): membership, post permission, and public-ness. */
export interface GroupRoomAccess {
  /** Has a chat_group_members row (read watermark / reactions require this). */
  isMember: boolean
  /** May POST/type (member of a 'group', or owner/admin of a 'channel'). Read-only channel members: false. */
  canPost: boolean
  /** 'public' rooms admit non-member read-only joins; 'private' stay member-only. */
  visibility: "private" | "public"
}

/**
 * Subset of the P4 ChatGroupRepository the WS gateway needs. P5: join relaxes to public read-only
 * (non-members may open a visibility='public' room for presence + reads); send/typing require post
 * permission (`access.canPost` — channels are owner/admin-only). `access` resolves kind+visibility+role
 * in one round trip (null when the group is gone); `isMember` stays for the ack watermark's member scope.
 * Injected via chat-gateway-wiring so routes and the socket share one repo instance.
 */
export interface GatewayGroupChat {
  isMember(groupId: string, userId: string): Promise<boolean>
  access(groupId: string, userId: string): Promise<GroupRoomAccess | null>
  advanceReadWatermark(groupId: string, userId: string, upToId: string): Promise<void>
}

export interface GatewayChatMentions {
  resolveChatMentions(input: {
    handles: string[]
    userIds: string[]
    authorUserId: string
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

export type GatewayChatService = Omit<ChatService, "broadcast"> & {
  broadcast(
    cleanupId: string,
    msg: Parameters<ChatService["broadcast"]>[1],
    opts?: { excludeConnId?: string },
  ): Promise<void>
}

export interface GatewayDeps {
  chat: GatewayChatService
  isMember: IsMemberFn
  markRead?: MarkReadFn | undefined
  markReadOnOpen?: MarkReadOnOpenFn | undefined
  presence?: ChatPresence | undefined
  dm?: GatewayDmDeps | undefined
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  userChannel?: UserChannel | undefined
  threadRecipientsOf?: ThreadRecipientsOf | undefined
  onDmDelivered?: OnDmDelivered | undefined
  onReportMessage?: OnReportMessage | undefined
  onGroupMessage?: OnGroupMessage | undefined
  onChatReply?: OnChatReply | undefined
  reportVisible?: ReportVisibleFn | undefined
  reportSendLimiter?: RateLimiter | undefined
  chatMentions?: GatewayChatMentions | undefined
  reportChat?: GatewayReportChat | undefined
  groupChat?: GatewayGroupChat | undefined
}

export interface GatewaySession {
  readonly userId: string
  readonly conn: ChatConnection
  readonly joined: Set<string>
  readonly deps: GatewayDeps
  readonly typingThrottle: Map<string, number>
  /**
   * M13: this connection's all-frame-types token bucket. Deliberately OPTIONAL-and-lazily-created (see
   * handleClientFrame): every session — including ones built by tests and any future call site — gets a
   * bucket whether or not the constructing code remembered to wire one, so the throttle can never be
   * silently absent on a live socket.
   */
  frameLimiter?: RateLimiter
}

export type WsHandshakeResult =
  | {
      ok: true
      userId: string
      /**
       * M1: the long-lived session token this handshake authenticated with, when there was one (cookie
       * or bearer). ABSENT on the ?ticket= path — a single-use connect ticket is not a session
       * credential, so those sockets are re-checked with the cheap banned-account read only.
       */
      token?: string
    }
  | { ok: false; code: "FORBIDDEN" | "UNAUTHORIZED"; message: string; reason: string }

export interface RegisterGatewayOptions {
  chat: ChatService
  isMember: IsMemberFn
  sessions: import("../auth/session-service.js").SessionService | undefined
  redeemTicket?: ((ticket: string) => Promise<string | null>) | undefined
  markRead?: MarkReadFn | undefined
  markReadOnOpen?: MarkReadOnOpenFn | undefined
  presence?: ChatPresence | undefined
  dm?: GatewayDmDeps | undefined
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  userChannel?: UserChannel | undefined
  threadRecipientsOf?: ThreadRecipientsOf | undefined
  onDmDelivered?: OnDmDelivered | undefined
  onReportMessage?: OnReportMessage | undefined
  onGroupMessage?: OnGroupMessage | undefined
  onChatReply?: OnChatReply | undefined
  reportVisible?: ReportVisibleFn | undefined
  reportSendLimiter?: RateLimiter | undefined
  chatMentions?: GatewayChatMentions | undefined
  reportChat?: GatewayReportChat | undefined
  groupChat?: GatewayGroupChat | undefined
  webOrigins: readonly string[]
}
