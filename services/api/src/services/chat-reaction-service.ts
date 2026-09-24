/**
 * Authorize BEFORE resolving the target: a caller with no power in the room must not be able to tell an
 * unknown message id from a real one in a private room (the reverse order is an existence oracle), so the
 * 404 only ever reaches someone allowed to react there. The tombstone check follows authorization for the
 * same reason, and precedes the write so a reaction to a deleted message never inserts an orphan row.
 *
 * Every dep is optional on the factory, but each lane asserts its own deps at call time: a missing one is
 * a wiring bug, so it throws rather than silently skipping a gate.
 */

import { AppError, ReactionEmojiSchema } from "@civfix/shared"
import type { ChatMessageDTO, ReactionEmoji } from "@civfix/shared"
import type { ChatMessageMeta, ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

export const CHAT_REACTION_FORBIDDEN = "You can't react in this conversation."

/**
 * Report chat is view-only until you Join, which is actionable, so the refusal says how to fix it. It
 * lives beside the gate so the legacy and unified routes never answer the same refusal differently.
 */
export const REPORT_CHAT_REACTION_FORBIDDEN = "Join the chat to react to messages."

export type IsCleanupMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

export type ReactionRoomKind = "cleanup" | "report" | "group" | "dm"

export interface ChatReactionServiceDeps {
  chat?: ChatRepository
  dm?: DmRepository
  isCleanupMember?: IsCleanupMemberFn
  /** Gated in-service so a caller other than the report route is never unauthorized by default. */
  isReportChatMember?: (reportId: string, userId: string) => Promise<boolean>
  /**
   * Reacting follows membership, not send permission: a channel's read-only member may react (and vote in
   * polls), which is why this is not the canPostToGroup gate the edit lane uses.
   */
  isChatGroupMember?: (groupId: string, userId: string) => Promise<boolean>
  /**
   * Runs before membership so an unlisted or soft-deleted report answers 404 like the report-chat
   * routes' requireVisibleReport. Absent means not enforced in-service.
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

type RoomRefs = Pick<ChatMessageMeta, "cleanupId" | "reportId" | "groupId">

interface ReactionLane {
  authorize(roomId: string, userId: string): Promise<void>
  /** null when the message does not exist in THIS room. */
  resolve(roomId: string, messageId: string): Promise<{ deletedAt: Date | null } | null>
  toggle(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  read(roomId: string, messageId: string, userId: string): Promise<ChatMessageDTO | null>
}

export function makeChatReactionService(deps: ChatReactionServiceDeps): ChatReactionService {
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
    const target = await lane.resolve(roomId, messageId)
    if (target === null || target.deletedAt !== null) throw messageNotFound()
    await lane.toggle(messageId, userId, emoji)
    const updated = await lane.read(roomId, messageId, userId)
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
