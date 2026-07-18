/**
 * P6 Task 6.3/6.4: the poll create / vote / close orchestration — gate ladder + atomic writes +
 * broadcast + member fan-out, over injected seams (chat-edit-service style: pure flow here, repos and
 * transport wired in the route). A poll is a chat message with kind='poll'; the write goes through the
 * poll repo, then the message is RE-READ through the chat repository so the returned + broadcast DTO
 * carries the fully-hydrated poll payload (chat-repository loadPollsFor).
 *
 * GATES:
 *   - createPoll: room SEND permission (cleanup member / report member / group member+canPost — a
 *     channel's read-only members can't create). Broadcasts a NEW `message` frame + fires the room's
 *     member bells (the same fan-out a normal send raises).
 *   - votePoll:   room MEMBERSHIP (any member incl. a channel's read-only readers; a public non-member
 *     403s). Closed poll -> 409 (fields.code poll_closed); an idx with no matching option, or a
 *     multi-idx ballot on a single-choice poll -> 422. The write is an ATOMIC replace (delete the
 *     voter's ballots + insert the new set in one tx); an empty ballot retracts. Broadcasts message_update.
 *   - closePoll:  the poll AUTHOR (created_by) OR a room MODERATOR (resolveChatPowers isModerator).
 *     Idempotent (a re-close keeps the original closed_at). Broadcasts message_update.
 *
 * A vote/close request carries only a messageId, so the room (kind + id) is resolved from the message
 * row; a missing / non-poll / tombstoned id is a 404 before any gate.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { ChatPollRepository, PollRoomColumn } from "./chat-poll-repository.drizzle.js"

/** The rooms a poll can live in (dm excluded upstream — a poll needs an audience). */
export type PollRoomKind = "cleanup" | "report" | "group"

export interface CreatePollInput {
  roomKind: PollRoomKind
  roomId: string
  question: string
  options: string[]
  allowMultiple: boolean
  anonymous: boolean
  userId: string
}

export interface VotePollInput {
  messageId: string
  optionIdxs: number[]
  userId: string
}

export interface ClosePollInput {
  messageId: string
  userId: string
}

export interface ChatPollServiceDeps {
  chat: ChatRepository
  chatPolls: ChatPollRepository
  /** SEND permission for the create gate (cleanup member / report member / group member+canPost). */
  canSend(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /** MEMBERSHIP for the vote gate (any member incl. channel readers; a public non-member is false). */
  isMember(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /** Room moderator (close gate fallback) — resolveChatPowers().isModerator. */
  isModerator(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  /** Injected message-id factory (matches the chat write paths' id source). */
  newId(): string
  /** Fan a NEW-message frame to the room (poll create). Best-effort. */
  broadcastMessage(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  /** Fan a message_update frame to the room (vote / close). Best-effort. */
  broadcastUpdate(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  /** Fire the room's member fan-out bells (create only; same bells a normal send raises). Best-effort. */
  notifyRoom(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
}

const ROOM_COLUMN: Record<PollRoomKind, PollRoomColumn> = {
  cleanup: "cleanup_id",
  report: "report_id",
  group: "group_id",
}

const pollClosed = (): AppError =>
  new AppError(ErrorCode.CONFLICT, "This poll is closed.", { fields: { code: "poll_closed" } })

export interface ChatPollService {
  createPoll(input: CreatePollInput): Promise<ChatMessageDTO>
  votePoll(input: VotePollInput): Promise<ChatMessageDTO>
  closePoll(input: ClosePollInput): Promise<ChatMessageDTO>
}

export function makeChatPollService(deps: ChatPollServiceDeps): ChatPollService {
  /** Re-read the hydrated poll message (carries the poll DTO) for the actor's viewer scope. */
  async function readMessage(
    roomKind: PollRoomKind,
    roomId: string,
    messageId: string,
    viewerUserId: string,
  ): Promise<ChatMessageDTO> {
    const dto =
      roomKind === "report"
        ? await deps.chat.findReportMessage(roomId, messageId, viewerUserId)
        : roomKind === "group"
          ? await deps.chat.findGroupMessage(roomId, messageId, viewerUserId)
          : await deps.chat.findMessage(roomId, messageId, viewerUserId)
    // The row was just written/updated in this request; a null re-read is a lost race (deleted underneath).
    if (dto === null) throw AppError.notFound("Poll not found")
    return dto
  }

  /** Resolve a poll message's room (kind + id) from its row; 404 when missing / not a poll / tombstoned. */
  async function resolvePollRoom(
    messageId: string,
  ): Promise<{ roomKind: PollRoomKind; roomId: string }> {
    const meta = await deps.chat.findMessageMeta(messageId)
    if (meta === null || meta.kind !== "poll" || meta.deletedAt !== null) {
      throw AppError.notFound("Poll not found")
    }
    if (meta.reportId !== null) return { roomKind: "report", roomId: meta.reportId }
    if (meta.groupId !== null) return { roomKind: "group", roomId: meta.groupId }
    // A poll always sets exactly one room ref; cleanup is the remaining branch.
    return { roomKind: "cleanup", roomId: meta.cleanupId! }
  }

  return {
    async createPoll(input: CreatePollInput): Promise<ChatMessageDTO> {
      const { roomKind, roomId, userId } = input
      if (!(await deps.canSend(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't create a poll in this chat.", {
          fields: { code: "poll_forbidden" },
        })
      }
      const messageId = deps.newId()
      await deps.chatPolls.create(
        {
          roomColumn: ROOM_COLUMN[roomKind],
          roomId,
          question: input.question,
          options: input.options,
          allowMultiple: input.allowMultiple,
          anonymous: input.anonymous,
          createdBy: userId,
        },
        messageId,
      )
      const message = await readMessage(roomKind, roomId, messageId, userId)
      // Realtime: a NEW `message` frame (with the poll DTO) to the room, then the member bells a normal
      // send raises. Both best-effort — a fan-out failure never fails the create.
      deps.broadcastMessage(roomKind, roomId, message)
      deps.notifyRoom(roomKind, roomId, message)
      return message
    },

    async votePoll(input: VotePollInput): Promise<ChatMessageDTO> {
      const { messageId, optionIdxs, userId } = input
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      // Membership (not send-permission): a channel's read-only member may vote; a public non-member 403s.
      if (!(await deps.isMember(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You must be a member to vote.", {
          fields: { code: "poll_not_member" },
        })
      }
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw AppError.notFound("Poll not found")
      if (pollMeta.closedAt !== null) throw pollClosed()
      // Multi-idx on a single-choice poll -> 422 (before the per-idx existence check).
      if (optionIdxs.length > 1 && !pollMeta.allowMultiple) {
        throw AppError.validation({ optionIdxs: "This poll allows only one choice." })
      }
      const valid = new Set(pollMeta.optionIdxs)
      if (optionIdxs.some((idx) => !valid.has(idx))) {
        throw AppError.validation({ optionIdxs: "Unknown poll option." })
      }
      // Atomic replace (empty = retract), then re-read the refreshed viewer-aware DTO.
      await deps.chatPolls.replaceVotes(messageId, userId, optionIdxs)
      const message = await readMessage(roomKind, roomId, messageId, userId)
      deps.broadcastUpdate(roomKind, roomId, message)
      return message
    },

    async closePoll(input: ClosePollInput): Promise<ChatMessageDTO> {
      const { messageId, userId } = input
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw AppError.notFound("Poll not found")
      const isAuthor = pollMeta.createdBy === userId
      if (!isAuthor && !(await deps.isModerator(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't close this poll.", {
          fields: { code: "poll_close_forbidden" },
        })
      }
      // Idempotent: a re-close keeps the original closed_at (COALESCE in the repo).
      await deps.chatPolls.close(messageId)
      const message = await readMessage(roomKind, roomId, messageId, userId)
      deps.broadcastUpdate(roomKind, roomId, message)
      return message
    },
  }
}
