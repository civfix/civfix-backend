
import {
  MarkThreadReadRequestSchema,
  ToggleMuteRequestSchema,
  ToggleHiddenRequestSchema,
  AppError,
  type MarkThreadReadResponse,
  type ToggleMuteResponse,
  type ToggleHiddenResponse,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import {
  makeConversationHidesRepository,
  type ConversationHidesRepository,
} from "../services/conversation-hides-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { conversationReadSeam } from "./chat-gateway-wiring.js"
import type { MarkRoomRead } from "../services/room-read-service.js"

export interface ConversationRoutesOverrides {
  repo: ConversationMutesRepository
  hides?: ConversationHidesRepository
  participates?: (
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userId: string,
  ) => Promise<boolean>
  markRoomRead?: MarkRoomRead
}

export const CONVERSATION_MUTE_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const THREAD_READ_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export const CONVERSATION_HIDE_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

declare module "fastify" {
  interface FastifyInstance {
    conversationRoutesOverrides?: ConversationRoutesOverrides
  }
}

const MUTABLE_ROOM_KINDS = new Set<ConversationMuteRoomKind>(["cleanup", "dm", "report", "group"])

function isMutableRoomKind(roomKind: string): roomKind is ConversationMuteRoomKind {
  return MUTABLE_ROOM_KINDS.has(roomKind as ConversationMuteRoomKind)
}

export async function registerConversationRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  const overrides = app.conversationRoutesOverrides
  let repo: ConversationMutesRepository | undefined
  const getRepo = (): ConversationMutesRepository =>
    overrides?.repo ?? (repo ??= makeConversationMutesRepository(container.getDb().sql))

  let hidesRepo: ConversationHidesRepository | undefined
  const getHidesRepo = (): ConversationHidesRepository =>
    overrides?.hides ?? (hidesRepo ??= makeConversationHidesRepository(container.getDb().sql))

  let cleanups: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let reportChat: ReportChatRepository | undefined
  let groups: ChatGroupRepository | undefined
  let reports: DiscussionRepository | undefined
  let dmParticipant: ReturnType<Container["getDmRepo"]> | undefined

  const participatesReal = async (
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userId: string,
  ): Promise<boolean> => {
    const sql = container.getDb().sql
    if (roomKind === "dm") {
      return (dmParticipant ??= container.getDmRepo()).isParticipant(roomId, userId)
    }
    if (roomKind === "cleanup") {
      return (cleanups ??= makeDrizzleCleanupRepository(sql)).isMember(roomId, userId)
    }
    if (roomKind === "report") {
      if (await (reportChat ??= makeReportChatRepository(sql)).isMember(roomId, userId)) return true
      const report = await (reports ??= makeDrizzleDiscussionRepository(sql)).findReportForDiscussion(roomId)
      return isReportVisibleTo(report, userId)
    }
    const access = await (groups ??= makeChatGroupRepository(sql)).accessOf(roomId, userId)
    return access !== null && (access.role !== null || access.visibility === "public")
  }

  const participates = overrides ? overrides.participates : participatesReal

  let markRoomRead: MarkRoomRead | undefined
  const getMarkRoomRead = (): MarkRoomRead =>
    overrides?.markRoomRead ?? (markRoomRead ??= conversationReadSeam(app, container).markRoomRead)

  route(
    app,
    "toggleConversationMute",
    { preHandler: csrfProtect, config: { rateLimit: CONVERSATION_MUTE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ToggleMuteRequestSchema, request.body)
      if (!isMutableRoomKind(body.roomKind)) {
        throw AppError.validation({ roomKind: "This conversation kind cannot be muted." })
      }
      if (participates && !(await participates(body.roomKind, body.roomId, userId))) {
        throw AppError.forbidden("You can't change notifications for this conversation.")
      }
      await getRepo().setMuted(userId, body.roomKind, body.roomId, body.muted)
      const payload: ToggleMuteResponse = { muted: body.muted }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "toggleConversationHidden",
    { preHandler: csrfProtect, config: { rateLimit: CONVERSATION_HIDE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ToggleHiddenRequestSchema, request.body)
      if (!isMutableRoomKind(body.roomKind)) {
        throw AppError.validation({ roomKind: "This conversation kind cannot be hidden." })
      }
      if (participates && !(await participates(body.roomKind, body.roomId, userId))) {
        throw AppError.forbidden("You can't change this conversation.")
      }
      await getHidesRepo().setHidden(userId, body.roomKind, body.roomId, body.hidden)
      void Promise.resolve(
        container.userChannel?.publishToUser(userId, { topic: "threads", id: body.roomId }),
      ).catch(() => {})
      const payload: ToggleHiddenResponse = { hidden: body.hidden }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "markThreadRead",
    { preHandler: csrfProtect, config: { rateLimit: THREAD_READ_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(MarkThreadReadRequestSchema, request.body)
      if (participates && !(await participates(body.roomKind, body.roomId, userId))) {
        throw AppError.forbidden("You can't open this conversation.")
      }
      await getMarkRoomRead()(body.roomKind, body.roomId, userId)
      void Promise.resolve(
        container.userChannel?.publishToUser(userId, { topic: "threads", id: body.roomId }),
      ).catch(() => {})
      const payload: MarkThreadReadResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )
}
