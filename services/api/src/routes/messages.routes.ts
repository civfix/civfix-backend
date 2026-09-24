import {
  AppError,
  ClosePollRequestSchema,
  CreatePollRequestSchema,
  EditMessageRequestSchema,
  ErrorCode,
  SetMessagePinnedRequestSchema,
  ToggleMessageReactionRequestSchema,
  VotePollRequestSchema,
  type ChatMessageDTO,
  type SetMessagePinnedRequest,
} from "@civfix/shared"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse, trimTextFields } from "./_validate.js"
import { route } from "../versioning/route.js"
import { makeChatEditService, type IsRoomMemberFn } from "../services/chat-edit-service.js"
import { makeDrizzleChatRepository } from "../services/chat-repository.drizzle.js"
import type { ChatRepository } from "../services/chat-repository.js"
import type { ReportChatRepository } from "../services/report-chat-repository.js"
import type { ChatGroupRepository } from "../services/chat-group-repository.js"
import type { DmRepository } from "../services/dm-repository.js"
import type { BlocksRepository } from "../services/blocks-repository.js"
import { makeReportChatRepository } from "../services/report-chat-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  canPostToGroup,
  makeChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-repository.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeDmPeerOf } from "../services/dm-peer.js"
import { messageRoomMatches, REPORT_NOT_FOUND } from "./chat-route-helpers.js"
import { neutralizeChatViewerFields } from "../services/chat-viewer-fields.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { chatMentionDeps, type ChatMentionSeam } from "./chat-gateway-wiring.js"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import { wireChatPowers } from "./chat-powers-wiring.js"
import { makeChatPollRepository } from "../services/chat-poll-repository.drizzle.js"
import { makeChatPollService, type PollRoomKind } from "../services/chat-poll-service.js"
import { makeContainerPollNotifier } from "../services/chat-poll-notifier.js"

export const EditMessageBodySchema = trimTextFields(EditMessageRequestSchema, "body")

export const CreatePollBodySchema = trimTextFields(
  CreatePollRequestSchema,
  "question",
  "options",
).superRefine((poll, ctx) => {
  const seen = new Set<string>()
  poll.options.forEach((option, index) => {
    if (seen.has(option)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index],
        message: "must not repeat an earlier option",
      })
      return
    }
    seen.add(option)
  })
})

export const EDIT_MESSAGE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export const TOGGLE_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const CREATE_POLL_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 minute" })

export const VOTE_POLL_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const CLOSE_POLL_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

const MESSAGE_NOT_FOUND = "Message not found"
const MESSAGE_DELETED = "This message was deleted."
const PIN_FORBIDDEN_FIELD_CODE = "pin_forbidden"

interface MessagesDeps {
  getChatRepo(): ChatRepository
  getReportChatRepo(): ReportChatRepository
  dmRepo(): DmRepository
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  dmPeerOf: ReturnType<typeof makeDmPeerOf>
  isCleanupMember: IsRoomMemberFn
  isGroupMember: IsRoomMemberFn
  canSendGroup: IsRoomMemberFn
  isReportChatMember: IsRoomMemberFn
  isReportVisible(reportId: string, userId: string): Promise<boolean>
  requireVisibleReport(reportId: string, userId: string): Promise<void>
  chatMentions: ChatMentionSeam | undefined
}

function makeMessagesDeps(app: FastifyInstance, container: Container): MessagesDeps {
  const overrides = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    overrides?.reportChat ?? (reportChatRepo ??= makeReportChatRepository(container.getDb().sql))

  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  const getCleanupRepo = (): ReturnType<typeof makeDrizzleCleanupRepository> =>
    (cleanupRepo ??= makeDrizzleCleanupRepository(container.getDb().sql))
  const isCleanupMember: IsRoomMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => getCleanupRepo().isMember(cleanupId, userId)

  let groupsRepo: ChatGroupRepository | undefined
  const getGroupsRepo = (): ChatGroupRepository | undefined =>
    overrides
      ? overrides.groups
      : (groupsRepo ??= makeChatGroupRepository(
          container.getDb().sql,
          makePrivateMediaPresigner(container.storage),
        ))
  const isGroupMember: IsRoomMemberFn = async (groupId, userId) => {
    const repo = getGroupsRepo()
    if (!repo) return false
    return (await repo.roleOf(groupId, userId)) !== null
  }
  const canSendGroup: IsRoomMemberFn = async (groupId, userId) => {
    const repo = getGroupsRepo()
    if (!repo) return false
    const access = await repo.accessOf(groupId, userId)
    return access !== null && canPostToGroup(access)
  }

  const dmRepo = (): DmRepository => overrides?.dmRepo ?? container.getDmRepo()
  const blocksRepo = (): BlocksRepository => overrides?.blocksRepo ?? container.getBlocksRepo()

  let discussionRepo: DiscussionRepository | undefined
  const getReportLookup = (): DiscussionRepository | undefined =>
    app.discussionOverrides?.repo ??
    (overrides || useFakeChat
      ? undefined
      : (discussionRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql)))

  const isReportVisible = async (reportId: string, userId: string): Promise<boolean> => {
    const injected = overrides?.reportVisible
    if (injected) return injected(reportId, userId)
    const repo = getReportLookup()
    if (repo === undefined) return true
    return isReportVisibleTo(await repo.findReportForDiscussion(reportId), userId)
  }

  return {
    getChatRepo,
    getReportChatRepo,
    dmRepo,
    isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
    dmPeerOf: makeDmPeerOf({ getThread: (threadId) => dmRepo().getThread(threadId) }),
    isCleanupMember,
    isGroupMember,
    canSendGroup,
    isReportChatMember: (roomId, userId) => getReportChatRepo().isMember(roomId, userId),
    isReportVisible,
    requireVisibleReport: async (reportId, userId) => {
      if (!(await isReportVisible(reportId, userId))) throw AppError.notFound(REPORT_NOT_FOUND)
    },
    chatMentions:
      overrides?.chatMentions ?? (useFakeChat ? undefined : chatMentionDeps(app, container)),
  }
}

type PinRoomKind = SetMessagePinnedRequest["roomKind"]

async function loadPinTarget(
  deps: MessagesDeps,
  roomKind: PinRoomKind,
  roomId: string,
  messageId: string,
): Promise<{ kind: string; deletedAt: Date | null }> {
  if (roomKind === "dm") {
    const meta = await deps.dmRepo().findMessageMeta(messageId)
    if (meta === null || meta.threadId !== roomId) throw AppError.notFound(MESSAGE_NOT_FOUND)
    return { kind: meta.kind, deletedAt: meta.deletedAt }
  }
  const meta = await deps.getChatRepo().findMessageMeta(messageId)
  if (!messageRoomMatches(meta, roomKind, roomId)) throw AppError.notFound(MESSAGE_NOT_FOUND)
  return { kind: meta.kind, deletedAt: meta.deletedAt }
}

function setPinnedIn(
  deps: MessagesDeps,
  roomKind: PinRoomKind,
  roomId: string,
  messageId: string,
  userId: string,
  pinned: boolean,
): Promise<ChatMessageDTO | null> {
  if (roomKind === "dm") return deps.dmRepo().setPinned(roomId, messageId, userId, pinned)
  const chat = deps.getChatRepo()
  if (roomKind === "report") return chat.setReportPinned(roomId, messageId, userId, pinned)
  if (roomKind === "group") return chat.setGroupPinned(roomId, messageId, userId, pinned)
  return chat.setPinned(roomId, messageId, userId, pinned)
}

export async function registerMessagesRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect
  const overrides = app.chatOverrides
  const deps = makeMessagesDeps(app, container)
  const {
    getChatRepo,
    getReportChatRepo,
    dmRepo,
    isBlockedEitherWay,
    dmPeerOf,
    isCleanupMember,
    isGroupMember,
    canSendGroup,
    isReportChatMember,
    isReportVisible,
    requireVisibleReport,
    chatMentions,
  } = deps

  route(
    app,
    "editChatMessage",
    { preHandler: csrfProtect, config: { rateLimit: EDIT_MESSAGE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(EditMessageBodySchema, request.body)
      if (body.roomKind === "report") await requireVisibleReport(body.roomId, userId)

      const edits = makeChatEditService({
        chat: getChatRepo(),
        dm: dmRepo(),
        isCleanupMember,
        isReportMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
        isReportVisible,
        isGroupMember: canSendGroup,
        dmPeerOf,
        isBlockedEitherWay,
        ...(chatMentions ? { chatMentions } : {}),
        broadcastEvent: (roomKey, frame) => container.chatService.broadcastEvent?.(roomKey, frame),
      })
      const updated = await edits.editMessage({
        roomKind: body.roomKind,
        roomId: body.roomId,
        messageId: body.messageId,
        userId,
        body: body.body,
        mentionedUserIds: body.mentionedUserIds,
      })

      reply.status(200).send(updated)
    },
  )

  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "setMessagePinned",
    { preHandler: csrfProtect, config: { rateLimit: EDIT_MESSAGE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(SetMessagePinnedRequestSchema, request.body)
      const { roomKind, roomId, messageId, pinned } = body

      if (roomKind === "report") await requireVisibleReport(roomId, userId)

      const powers = await resolveChatPowers({ roomKind, roomId, userId })
      if (!powers.canPin) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't pin messages in this chat.", {
          fields: { code: PIN_FORBIDDEN_FIELD_CODE },
        })
      }

      const { kind, deletedAt } = await loadPinTarget(deps, roomKind, roomId, messageId)
      if (kind === "system") {
        throw AppError.validation({ messageId: "System messages can't be pinned." })
      }
      if (deletedAt !== null) throw AppError.validation({ messageId: MESSAGE_DELETED })

      const updated = await setPinnedIn(deps, roomKind, roomId, messageId, userId, pinned)
      if (updated === null) throw AppError.validation({ messageId: MESSAGE_DELETED })

      broadcastMessageUpdate(
        container.chatService,
        roomKind,
        roomId,
        neutralizeChatViewerFields(updated),
      )

      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "toggleMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: TOGGLE_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ToggleMessageReactionRequestSchema, request.body)
      const { roomKind, roomId, messageId, emoji } = body

      const reactions = makeChatReactionService({
        chat: getChatRepo(),
        dm: dmRepo(),
        isCleanupMember,
        isReportChatMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
        isChatGroupMember: isGroupMember,
        dmPeerOf,
        isBlockedEitherWay,
        isReportVisible,
      })
      const updated: ChatMessageDTO = await reactions.toggleReaction({
        roomKind,
        roomId,
        messageId,
        userId,
        emoji,
      })

      const frame = {
        type: "reaction" as const,
        cleanupId: roomId,
        ...(roomKind === "cleanup" ? {} : { roomKind }),
        message: neutralizeChatViewerFields(updated),
      }
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor(roomKind, roomId), frame),
      ).catch(() => {})

      reply.status(200).send(updated)
    },
  )

  let pollService: ReturnType<typeof makeChatPollService> | undefined
  const pollNotifier = makeContainerPollNotifier(container, app.log)
  const getPollService = (): ReturnType<typeof makeChatPollService> =>
    (pollService ??= makeChatPollService({
      chat: getChatRepo(),
      chatPolls: overrides?.chatPolls ?? makeChatPollRepository(container.getDb().sql),
      isReportVisible,
      canSend: (roomKind, roomId, userId) =>
        roomKind === "report"
          ? isReportChatMember(roomId, userId)
          : roomKind === "group"
            ? canSendGroup(roomId, userId)
            : isCleanupMember(roomId, userId),
      isMember: (roomKind, roomId, userId) =>
        roomKind === "report"
          ? isReportChatMember(roomId, userId)
          : roomKind === "group"
            ? isGroupMember(roomId, userId)
            : isCleanupMember(roomId, userId),
      isModerator: async (roomKind, roomId, userId) =>
        (await resolveChatPowers({ roomKind, roomId, userId })).isModerator,
      newId: () => randomUUID(),
      broadcastMessage: (roomKind, roomId, message) => {
        void Promise.resolve(
          container.chatService.broadcast(roomKeyFor(roomKind, roomId), message),
        ).catch(() => {})
      },
      broadcastUpdate: (roomKind, roomId, message) =>
        broadcastMessageUpdate(container.chatService, roomKind, roomId, message),
      notifyRoom: (roomKind, roomId, message) => pollNotifier(roomKind, roomId, message),
    }))

  route(
    app,
    "createPoll",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_POLL_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreatePollBodySchema, request.body)
      const created = await getPollService().createPoll({
        roomKind: body.roomKind as PollRoomKind,
        roomId: body.roomId,
        question: body.question,
        options: body.options,
        allowMultiple: body.allowMultiple,
        anonymous: body.anonymous,
        userId,
      })
      reply.status(200).send(created)
    },
  )

  route(
    app,
    "votePoll",
    { preHandler: csrfProtect, config: { rateLimit: VOTE_POLL_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(VotePollRequestSchema, request.body)
      const updated = await getPollService().votePoll({
        messageId: body.messageId,
        optionIdxs: body.optionIdxs,
        userId,
      })
      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "closePoll",
    { preHandler: csrfProtect, config: { rateLimit: CLOSE_POLL_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ClosePollRequestSchema, request.body)
      const closed = await getPollService().closePoll({ messageId: body.messageId, userId })
      reply.status(200).send(closed)
    },
  )
}
