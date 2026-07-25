/**
 * The reaction toggle for every room kind: resolve the target, authorize, tombstone-gate, toggle, re-read.
 *
 * `toggleReaction` is the roomKind-dispatching entry point (the chat-edit-service pattern) and the one the
 * unified POST /messages/reactions route should call; the three legacy per-room methods are thin binders
 * onto the same core so the gate ladder exists ONCE. chat_message_reactions is room-agnostic (keyed on
 * message id), so only the resolve + authorize steps differ per kind.
 *
 * GATE ORDER — authorize BEFORE resolving the target. A caller with no power in the room must not be able
 * to tell an unknown message id from a real one in a private room (the reverse order is an existence
 * oracle), so the 403 comes first and the 404 only ever reaches someone allowed to react there. The
 * tombstone check runs AFTER authorization for the same reason, and BEFORE the write so a reaction to a
 * deleted message never inserts an orphan reactions row.
 *
 * WIRING: every dep is optional on the factory (the offline harnesses and the legacy routes wire only what
 * their lane needs) but each lane asserts its own deps at call time — a missing one is a wiring bug, so it
 * throws rather than silently skipping a gate.
 */

import { AppError, ReactionEmojiSchema } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji } from "@civfix/shared"
import type { ChatMessageMeta, ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

export const CHAT_REACTION_FORBIDDEN = "You can't react in this conversation."

/**
 * The REPORT lane's own 403 copy. Report chat is view-only until you Join, and that is actionable, so the
 * room says how to fix it instead of the generic refusal. Lives here (not in the route) because the gate
 * itself lives here now: both the legacy per-room route and the unified /messages/reactions route reach
 * the report lane through this service, and they must not answer the same refusal with different copy.
 */
export const REPORT_CHAT_REACTION_FORBIDDEN = "Join the chat to react to messages."

export type IsCleanupMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

/** The room kinds a reaction can target (the shared ToggleMessageReactionRequest vocabulary). */
export type ReactionRoomKind = "cleanup" | "report" | "group" | "dm"

export interface ChatReactionServiceDeps {
  chat?: ChatRepository
  dm?: DmRepository
  isCleanupMember?: IsCleanupMemberFn
  /**
   * report_chat_members membership. The report lane's in-service gate: report chat is view-only until you
   * Join, and relying on the route to have checked left any other caller of this service unauthorized-by-
   * default (the cleanup and dm lanes have always gated in-service).
   */
  isReportChatMember?: (reportId: string, userId: string) => Promise<boolean>
  /**
   * chat_group_members membership. Reacting follows MEMBERSHIP, not send permission: a channel's read-only
   * member may react (and vote in polls — the same product stance), which is why this is not the
   * canPostToGroup gate the edit lane uses.
   */
  isChatGroupMember?: (groupId: string, userId: string) => Promise<boolean>
  /**
   * Report VISIBILITY (isReportVisibleTo: published+public, or the reporter's own). Optional: when wired
   * it runs before membership so an unlisted / soft-deleted report answers 404 exactly like the
   * report-chat routes' requireVisibleReport. Absent = not enforced in-service.
   */
  isReportVisible?: (reportId: string, userId: string) => Promise<boolean>
  dmPeerOf?: (threadId: string, userId: string) => Promise<string | null>
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
}

export interface ToggleReactionInput {
  roomKind: ReactionRoomKind
  roomId: string
  messageId: string
  userId: string
  emoji: ReactionEmoji
}

export interface ChatReactionService {
  /** Room-kind dispatching toggle (see the module banner for the gate ladder). */
  toggleReaction(input: ToggleReactionInput): Promise<ChatMessageDTO>
  toggleCleanupReaction(
    cleanupId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
  toggleDmReaction(
    threadId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
  toggleReportReaction(
    reportId: string,
    messageId: string,
    userId: string,
    emoji: ReactionEmoji,
  ): Promise<ChatMessageDTO>
}

function requireEmoji(emoji: ReactionEmoji): ReactionEmoji {
  const parsed = ReactionEmojiSchema.safeParse(emoji)
  if (!parsed.success) throw AppError.validation({ emoji: "Unsupported reaction" })
  return parsed.data
}

const notWired = (what: string): Error => new Error(`chat-reaction-service: ${what} deps not wired`)

const messageNotFound = (): AppError => AppError.notFound("Message not found")

/** The room-ref slice of a chat_messages row a lane matches its roomId against. */
type RoomRefs = Pick<ChatMessageMeta, "cleanupId" | "reportId" | "groupId">

/** One room kind's resolve / authorize / write seam, bound to the deps its lane needs. */
interface ReactionLane {
  /** Authorization for the room (throws 403/404); runs BEFORE the target is resolved. */
  authorize(roomId: string, userId: string): Promise<void>
  /** The target's tombstone state, or null when it does not exist in THIS room. */
  resolve(roomId: string, messageId: string): Promise<{ deletedAt: Date | null } | null>
  toggle(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  read(roomId: string, messageId: string, userId: string): Promise<ChatMessageDTO | null>
}

export function makeChatReactionService(deps: ChatReactionServiceDeps): ChatReactionService {
  /** The report lane's gates: visibility (when wired) then membership. Throws 404 / 403; never returns false. */
  async function gateReportRoom(reportId: string, userId: string, strict: boolean): Promise<void> {
    if (deps.isReportVisible && !(await deps.isReportVisible(reportId, userId))) {
      throw AppError.notFound("Report not found")
    }
    const isMember = deps.isReportChatMember
    if (!isMember) {
      // The legacy per-room route performs requireVisibleReport + isMember itself, so a lenient lane
      // stays functional there; a strict (unified) lane must never run without the membership gate.
      if (strict) throw notWired("report")
      return
    }
    if (!(await isMember(reportId, userId))) {
      throw AppError.forbidden(REPORT_CHAT_REACTION_FORBIDDEN)
    }
  }

  function laneFor(kind: ReactionRoomKind, strict: boolean): ReactionLane {
    if (kind === "dm") {
      const dm = deps.dm
      const dmPeerOf = deps.dmPeerOf
      const isBlockedEitherWay = deps.isBlockedEitherWay
      if (!dm || !dmPeerOf || !isBlockedEitherWay) throw notWired("dm")
      return {
        async authorize(threadId, userId) {
          const peer = await dmPeerOf(threadId, userId)
          if (peer === null) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
          if (await isBlockedEitherWay(userId, peer)) {
            throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
          }
        },
        async resolve(threadId, messageId) {
          const meta = await dm.findMessageMeta(messageId)
          if (meta === null || meta.threadId !== threadId) return null
          return { deletedAt: meta.deletedAt }
        },
        toggle: (messageId, userId, emoji) => dm.toggleReaction(messageId, userId, emoji),
        read: (threadId, messageId, userId) => dm.findMessage(threadId, messageId, userId),
      }
    }

    const chat = deps.chat
    if (!chat) throw notWired("chat")
    // The chat_messages meta carries all three room refs; the lane checks its own.
    const resolveScoped = async (
      roomId: string,
      messageId: string,
      refOf: (meta: RoomRefs) => string | null,
    ): Promise<{ deletedAt: Date | null } | null> => {
      const meta = await chat.findMessageMeta(messageId)
      if (meta === null || refOf(meta) !== roomId) return null
      return { deletedAt: meta.deletedAt }
    }

    if (kind === "report") {
      return {
        authorize: (reportId, userId) => gateReportRoom(reportId, userId, strict),
        resolve: (reportId, messageId) => resolveScoped(reportId, messageId, (m) => m.reportId),
        toggle: (messageId, userId, emoji) => chat.toggleReaction(messageId, userId, emoji),
        read: (reportId, messageId, userId) => chat.findReportMessage(reportId, messageId, userId),
      }
    }

    if (kind === "group") {
      const isChatGroupMember = deps.isChatGroupMember
      if (!isChatGroupMember) throw notWired("group")
      return {
        async authorize(groupId, userId) {
          if (!(await isChatGroupMember(groupId, userId))) {
            throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
          }
        },
        resolve: (groupId, messageId) => resolveScoped(groupId, messageId, (m) => m.groupId),
        toggle: (messageId, userId, emoji) => chat.toggleReaction(messageId, userId, emoji),
        read: (groupId, messageId, userId) => chat.findGroupMessage(groupId, messageId, userId),
      }
    }

    const isCleanupMember = deps.isCleanupMember
    if (!isCleanupMember) throw notWired("cleanup")
    return {
      async authorize(cleanupId, userId) {
        if (!(await isCleanupMember(cleanupId, userId))) {
          throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
        }
      },
      resolve: (cleanupId, messageId) => resolveScoped(cleanupId, messageId, (m) => m.cleanupId),
      toggle: (messageId, userId, emoji) => chat.toggleReaction(messageId, userId, emoji),
      read: (cleanupId, messageId, userId) => chat.findMessage(cleanupId, messageId, userId),
    }
  }

  async function run(input: ToggleReactionInput, strict: boolean): Promise<ChatMessageDTO> {
    const emoji = requireEmoji(input.emoji)
    const { roomId, messageId, userId } = input
    const lane = laneFor(input.roomKind, strict)
    await lane.authorize(roomId, userId)
    // Cheap meta resolve (id + room ref + deleted_at), NOT a full hydration: the pre-2026-07 version
    // hydrated the whole DTO (reactions, mentions, attachment presigns, reply map, polls) purely to check
    // existence and then threw the result away.
    const target = await lane.resolve(roomId, messageId)
    if (target === null || target.deletedAt !== null) throw messageNotFound()
    await lane.toggle(messageId, userId, emoji)
    const updated = await lane.read(roomId, messageId, userId)
    // The gates above passed, so a null re-read is a lost race (the row vanished underneath us).
    if (updated === null) throw messageNotFound()
    return updated
  }

  return {
    toggleReaction: (input) => run(input, true),

    toggleCleanupReaction: (cleanupId, messageId, userId, emoji) =>
      run({ roomKind: "cleanup", roomId: cleanupId, messageId, userId, emoji }, false),

    toggleDmReaction: (threadId, messageId, userId, emoji) =>
      run({ roomKind: "dm", roomId: threadId, messageId, userId, emoji }, false),

    toggleReportReaction: (reportId, messageId, userId, emoji) =>
      run({ roomKind: "report", roomId: reportId, messageId, userId, emoji }, false),
  }
}
