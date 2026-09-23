import type { RoomKind } from "@civfix/shared"
import type { FastifyBaseLogger } from "fastify"
import type { ChatService, ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { ChatPresence } from "../adapters/chat-presence.js"
import type { RateLimiter } from "./report-rate-limit.js"

export const WS_HEARTBEAT_MS = 30_000

export type ReportVisibleFn = (reportId: string, userId: string | null) => Promise<boolean>

export const WS_CLOSE_POLICY_VIOLATION = 1008

export const WS_SESSION_ENDED_MESSAGE = "Your session ended."

export const WS_SESSION_ENDED_REASON = "session no longer valid"

export const TYPING_MIN_INTERVAL_MS = 1000

export const TYPING_THROTTLE_MAX_ROOMS = 256

export const WS_MAX_JOINED_ROOMS = 64

export const WS_FRAME_LIMIT = { capacity: 60, refillPerSec: 10 } as const

export const WS_REAUTH_INTERVAL_MS = 60_000

export const WS_REAUTH_JITTER_MS = 30_000

export const WS_BUFFER_DROP_THRESHOLD = 1024 * 1024

export const WS_BUFFER_TERMINATE_TICKS = 2

export const WS_HANDSHAKE_FRAME_BUFFER = 32

export const WS_HANDSHAKE_BUFFER_BYTES = 64 * 1024

// Counts the frame in flight. A full token-bucket burst, or a reconnect re-joining every room, has to
// fit behind one slow handler without closing the socket (a close makes the client reconnect and
// replay the same burst); the bucket still rejects the excess as each frame is dequeued.
export const WS_MAX_QUEUED_FRAMES = Math.max(WS_FRAME_LIMIT.capacity, WS_MAX_JOINED_ROOMS)

export const WS_MAX_QUEUED_BYTES = 256 * 1024

export const WS_FRAME_RATE_LIMITED_MESSAGE = "You're sending frames too fast. Please slow down."

export const WS_FRAME_BACKLOG_REASON = "too many queued frames"

export type IsMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

export type MarkReadFn = (cleanupId: string, userId: string, upToId: string) => Promise<void>

export type MarkReadOnOpenFn = (kind: RoomKind, id: string, userId: string) => Promise<void>

export interface GatewayDmDeps {
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
  actorUserId: string,
) => Promise<void>

export type OnGroupMessage = (
  groupId: string,
  message: import("@civfix/shared").ChatMessageDTO,
) => Promise<void>

export type OnChatReply = (input: {
  kind: RoomKind
  roomId: string
  actorUserId: string
  targetUserId: string
  message: import("@civfix/shared").ChatMessageDTO
}) => Promise<void>

export interface GatewayReportChat {
  isMember(reportId: string, userId: string): Promise<boolean>
  advanceReadWatermark(reportId: string, userId: string, upToId: string): Promise<void>
}

export interface GroupRoomAccess {
  isMember: boolean
  canPost: boolean
  visibility: "private" | "public"
}

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
  logger?: Pick<FastifyBaseLogger, "warn"> | undefined
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
  sendResilience?: import("./send-resilience.js").SendResilience | undefined
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
  frameLimiter?: RateLimiter
  closed?: boolean
  accountStatus?: import("../auth/stores.js").AccountStatus
  revalidateStatus?: () => Promise<import("../auth/account-status.js").SocketStatusCheck>
  closeForAuth?: () => void
}

export type WsHandshakeResult =
  | {
      ok: true
      userId: string
      sessionHash?: string
      accountStatus?: import("../auth/stores.js").AccountStatus
    }
  | { ok: false; code: "FORBIDDEN" | "UNAUTHORIZED"; message: string; reason: string }

export interface RegisterGatewayOptions {
  chat: ChatService
  isMember: IsMemberFn
  sessions: import("../auth/session-service.js").SessionService | undefined
  redeemTicket?:
    | ((ticket: string) => Promise<import("../auth/ws-ticket.js").WsTicketPayload | null>)
    | undefined
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
