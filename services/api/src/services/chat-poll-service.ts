import { AppError, ErrorCode } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { ChatPollRepository, PollRoomColumn } from "./chat-poll-repository.drizzle.js"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { neutralizeChatViewerFields } from "./chat-viewer-fields.js"

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
  canSend(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  isMember(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  isModerator(roomKind: PollRoomKind, roomId: string, userId: string): Promise<boolean>
  isReportVisible?(reportId: string, userId: string): Promise<boolean>
  newId(): string
  broadcastMessage(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  broadcastUpdate(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
  notifyRoom(roomKind: PollRoomKind, roomId: string, message: ChatMessageDTO): void
}

const ROOM_COLUMN: Record<PollRoomKind, PollRoomColumn> = {
  cleanup: "cleanup_id",
  report: "report_id",
  group: "group_id",
}

const POLL_ERROR_CODE = {
  closed: "poll_closed",
  forbidden: "poll_forbidden",
  notMember: "poll_not_member",
  closeForbidden: "poll_close_forbidden",
} as const

const pollNotFound = (): AppError => AppError.notFound("Poll not found")

const pollClosed = (): AppError =>
  new AppError(ErrorCode.CONFLICT, "This poll is closed.", {
    fields: { code: POLL_ERROR_CODE.closed },
  })

const pollCloseForbidden = (): AppError =>
  new AppError(ErrorCode.FORBIDDEN, "You can't close this poll.", {
    fields: { code: POLL_ERROR_CODE.closeForbidden },
  })

export interface ChatPollService {
  createPoll(input: CreatePollInput): Promise<ChatMessageDTO>
  votePoll(input: VotePollInput): Promise<ChatMessageDTO>
  closePoll(input: ClosePollInput): Promise<ChatMessageDTO>
}

export function makeChatPollService(deps: ChatPollServiceDeps): ChatPollService {
  async function requireVisibleRoom(
    roomKind: PollRoomKind,
    roomId: string,
    userId: string,
  ): Promise<void> {
    if (roomKind !== "report" || !deps.isReportVisible) return
    if (!(await deps.isReportVisible(roomId, userId))) throw AppError.notFound("Report not found")
  }

  function findRoomMessage(
    roomKind: PollRoomKind,
    roomId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null> {
    if (roomKind === "report") return deps.chat.findReportMessage(roomId, messageId, viewerUserId)
    if (roomKind === "group") return deps.chat.findGroupMessage(roomId, messageId, viewerUserId)
    return deps.chat.findMessage(roomId, messageId, viewerUserId)
  }

  async function readMessage(
    roomKind: PollRoomKind,
    roomId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO> {
    const dto = await findRoomMessage(roomKind, roomId, messageId, viewerUserId)
    if (dto === null) throw pollNotFound()
    return dto
  }

  async function resolvePollRoom(
    messageId: string,
  ): Promise<{ roomKind: PollRoomKind; roomId: string }> {
    const meta = await deps.chat.findMessageMeta(messageId)
    if (meta === null || meta.kind !== "poll" || meta.deletedAt !== null) {
      throw pollNotFound()
    }
    if (meta.reportId !== null) return { roomKind: "report", roomId: meta.reportId }
    if (meta.groupId !== null) return { roomKind: "group", roomId: meta.groupId }
    return { roomKind: "cleanup", roomId: meta.cleanupId! }
  }

  /** Everyone else gets the viewer-neutral read; the caller gets their own vote state back. */
  async function rereadAndBroadcastUpdate(
    roomKind: PollRoomKind,
    roomId: string,
    messageId: string,
    userId: string,
  ): Promise<ChatMessageDTO> {
    const [message, roomView] = await Promise.all([
      readMessage(roomKind, roomId, messageId, userId),
      readMessage(roomKind, roomId, messageId, null),
    ])
    deps.broadcastUpdate(roomKind, roomId, roomView)
    return message
  }

  return {
    async createPoll(input: CreatePollInput): Promise<ChatMessageDTO> {
      const { roomKind, roomId, userId } = input
      await requireVisibleRoom(roomKind, roomId, userId)
      if (!(await deps.canSend(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't create a poll in this chat.", {
          fields: { code: POLL_ERROR_CODE.forbidden },
        })
      }
      assertNoSlur(input.question, "question")
      for (const option of input.options) assertNoSlur(option, "options")
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
      deps.broadcastMessage(roomKind, roomId, neutralizeChatViewerFields(message))
      deps.notifyRoom(roomKind, roomId, message)
      return message
    },

    async votePoll(input: VotePollInput): Promise<ChatMessageDTO> {
      const { messageId, userId } = input
      const optionIdxs = [...new Set(input.optionIdxs)]
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      await requireVisibleRoom(roomKind, roomId, userId)
      if (!(await deps.isMember(roomKind, roomId, userId))) {
        throw new AppError(ErrorCode.FORBIDDEN, "You must be a member to vote.", {
          fields: { code: POLL_ERROR_CODE.notMember },
        })
      }
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw pollNotFound()
      if (pollMeta.closedAt !== null) throw pollClosed()
      if (optionIdxs.length > 1 && !pollMeta.allowMultiple) {
        throw AppError.validation({ optionIdxs: "This poll allows only one choice." })
      }
      const valid = new Set(pollMeta.optionIdxs)
      if (optionIdxs.some((idx) => !valid.has(idx))) {
        throw AppError.validation({ optionIdxs: "Unknown poll option." })
      }
      await deps.chatPolls.replaceVotes(messageId, userId, optionIdxs)
      return rereadAndBroadcastUpdate(roomKind, roomId, messageId, userId)
    },

    async closePoll(input: ClosePollInput): Promise<ChatMessageDTO> {
      const { messageId, userId } = input
      const { roomKind, roomId } = await resolvePollRoom(messageId)
      await requireVisibleRoom(roomKind, roomId, userId)
      const pollMeta = await deps.chatPolls.findPollMeta(messageId)
      if (pollMeta === null) throw pollNotFound()
      const isAuthor = pollMeta.createdBy === userId
      const isModerator = await deps.isModerator(roomKind, roomId, userId)
      if (!(await deps.isMember(roomKind, roomId, userId)) && !isModerator) {
        throw pollCloseForbidden()
      }
      if (!isAuthor && !isModerator) {
        throw pollCloseForbidden()
      }
      await deps.chatPolls.close(messageId)
      return rereadAndBroadcastUpdate(roomKind, roomId, messageId, userId)
    },
  }
}
