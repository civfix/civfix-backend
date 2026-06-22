import type {
  DiscussionMessageDTO,
  DiscussionPageResponse,
  ReactionEmoji,
  UserMentionDTO,
} from "@civfix/shared"
import type { OutboundMailService } from "./admin/outbound-mail-service.js"

// Default page size when a request omits `limit`; the hard cap is 50 (see clampLimit).
export const DISCUSSION_DEFAULT_LIMIT = 20

// Max attachments a single discussion message may carry (mirrors report media's cap of 5).
export const DISCUSSION_MEDIA_MAX = 5

export interface DiscussionAuthorView {
  id: string
  displayName: string
  handle: string | null
  avatarUrl: string | null
  // Non-null when the author's ACCOUNT is tombstoned; drives the public "Deleted User" rendering.
  deletedAt: Date | null
}

export interface DiscussionMediaView {
  id: string
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
}

export interface DiscussionReactionView {
  emoji: string
  count: number
  mine: boolean
}

export interface DiscussionMentionView {
  geoid: string
  name: string
  handle: string | null
  forwarded: boolean
}

// A discussion message row joined with everything a DTO needs EXCEPT the presigned media URLs (the
// service presigns the raw keys). `author` is null for a system row or a soft-removed message;
// `deletedAt` non-null marks a tombstone.
export interface DiscussionMessageRecord {
  id: string
  reportId: string
  parentId: string | null
  authorUserId: string | null
  author: DiscussionAuthorView | null
  body: string
  forwardedToCity: boolean
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  // Count of NON-deleted direct children; always 0 for a reply (replies are one level deep).
  replyCount: number
  attachments: DiscussionMediaView[]
  reactions: DiscussionReactionView[]
  mention: DiscussionMentionView | null
  userMentions: UserMentionDTO[]
}

export interface ReportJurisdictionView {
  geoid: string
  name: string
  handle: string | null
  // First usable contact email (per-category -> default -> legacy), or null when none.
  contactEmail: string | null
}

export interface DiscussionReportView {
  id: string
  reporterUserId: string | null
  status: string
  visibility: string
  deletedAt: Date | null
  jurisdiction: ReportJurisdictionView | null
  category: string
  place: string | null
}

export interface CreateDiscussionMessageTxArgs {
  messageId: string
  reportId: string
  parentId: string | null
  authorUserId: string
  body: string
  createdAt: Date
  // Finalized upload ids to attach (set discussion_message_id; unattached/own only).
  mediaUploadIds: string[]
  mention: {
    geoid: string
    forwarded: boolean
    forwardedAt: Date | null
  } | null
  forwardedToCity: boolean
  mentionedUserIds: string[]
}

// Persistence seam for the discussion domain. The Drizzle impl runs raw SQL; offline tests pass an
// in-memory impl. Keeping every read/write here is what makes the service unit-testable with no DB.
export interface DiscussionRepository {
  findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null>
  findMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<DiscussionMessageRecord | null>
  // includeDeleted=true (the operator read) ALSO returns soft-removed rows so moderation can see them;
  // the service still tombstones them when projecting, so removed content never leaks.
  listTopLevel(
    reportId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted?: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }>
  listReplies(
    reportId: string,
    parentId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
    includeDeleted?: boolean,
  ): Promise<{ records: DiscussionMessageRecord[]; nextCursor: string | null }>
  createMessage(args: CreateDiscussionMessageTxArgs): Promise<DiscussionMessageRecord>
  // Returns null when no editable row matched (wrong report / not the author / already removed / missing).
  // When `mediaUploadIds` is provided it REPLACES the attachment set; when omitted, attachments are left
  // untouched. `mentionedUserIds` REPLACES the user-mention set (empty array clears them).
  editMessage(
    reportId: string,
    messageId: string,
    authorId: string,
    body: string,
    editedAt: Date,
    mediaUploadIds: string[] | undefined,
    mentionedUserIds: string[],
  ): Promise<DiscussionMessageRecord | null>
  // True when the reaction is now PRESENT (added), false when it was removed.
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  softDelete(messageId: string, deletedAt: Date): Promise<boolean>
  countTopLevel(reportId: string): Promise<number>
}

export type DiscussionEvent = "message" | "reply" | "reaction" | "remove"

export interface DiscussionNotifyInput {
  reportId: string
  actorUserId: string
  reportOwnerUserId: string | null
  parentAuthorUserId: string | null
  isReply: boolean
}

export interface DiscussionMentionNotifyInput {
  reportId: string
  actorUserId: string
  mentionedUserId: string
}

// Who is acting on a delete: the message author themselves, or an operator (moderation).
export interface DiscussionActor {
  userId: string
  isOperator: boolean
}

export interface DiscussionServiceDeps {
  repo: DiscussionRepository
  // The SAME url-pair signer the report service uses. The repo returns raw object-store keys; the service
  // presigns them. Injected so the service stays free of the storage SDK and is fakeable.
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  outboundMail: OutboundMailService
  // Best-effort live fan-out after a successful write. OPTIONAL + fire-and-forget: a fan-out failure must
  // never affect the HTTP response, and an un-wired path (offline tests) skips the signal.
  broadcast?: (reportId: string, event: DiscussionEvent) => void
  // Best-effort report-owner / parent-author bell after a message/reply is created. OPTIONAL +
  // fire-and-forget; the actor (author) is passed so the hook can exclude self-notifications.
  notifyOnMessage?: (input: DiscussionNotifyInput) => void
  // Resolve @handles (parsed from the body) + explicit user ids to REAL, mentionable users, EXCLUDING the
  // author. Injected so the service stays DB-free; un-wired => no user mentions recorded. No block/pref
  // filtering here (those gate only the NOTIFICATION).
  resolveMentions?: (input: {
    handles: string[]
    userIds: string[]
    authorUserId: string
  }) => Promise<UserMentionDTO[]>
  // Best-effort per-mentioned-user bell, once per resolved mention (author excluded). The hook applies the
  // block + notification-pref gating; the service only supplies WHO was mentioned. Fire-and-forget.
  notifyMention?: (input: DiscussionMentionNotifyInput) => void
  newId?: () => string
  now?: () => Date
}

export interface DiscussionService {
  list(
    reportId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  // Operator view: includes soft-removed (tombstoned) rows. No report-visibility gate (the operator scope
  // already gated the route); a removed row is still tombstoned (body blanked, author nulled) on projection.
  listForOperator(
    reportId: string,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  listReplies(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<DiscussionPageResponse>
  createMessage(
    reportId: string,
    userId: string,
    input: {
      body: string
      parentId?: string | undefined
      mediaUploadIds?: string[] | undefined
      mentionedUserIds?: string[] | undefined
    },
  ): Promise<DiscussionMessageDTO>
  toggleReaction(
    reportId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<DiscussionMessageDTO>
  // Author-only; a missing / not-owned / already-removed message is a 404 (never a 403 that would leak
  // the message's existence to a non-author).
  editMessage(
    reportId: string,
    messageId: string,
    userId: string,
    input: {
      body: string
      mediaUploadIds?: string[] | undefined
      mentionedUserIds?: string[] | undefined
    },
  ): Promise<DiscussionMessageDTO>
  deleteMessage(
    reportId: string,
    messageId: string,
    actor: DiscussionActor,
  ): Promise<DiscussionMessageDTO>
}
