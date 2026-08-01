import {
  ReportChatHistoryRequestSchema,
  DeleteReportMessageRequestSchema,
  ToggleReportMessageReactionRequestSchema,
  JoinReportChatRequestSchema,
  LeaveReportChatRequestSchema,
  IdSchema,
  AppError,
  type ChatMessageDTO,
  type ChatHistoryResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { chatHistoryPayload, deleteMessageWithPowers } from "./chat-route-helpers.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { wireChatPowers } from "./chat-powers-wiring.js"

/**
 * Test injection seam for the report-lookup the report-chat routes use (visibility + @city forward gating).
 * A fake `repo` wins over the real drizzle repo so route tests can run without a DB. (Named `discussion*`
 * for continuity with the fastify decoration key that predates the discussion system's removal.)
 */
export interface DiscussionServiceOverrides {
  repo?: DiscussionRepository
}

declare module "fastify" {
  interface FastifyInstance {
    discussionOverrides?: DiscussionServiceOverrides
  }
}

const ReportChatIdParamsSchema = z.object({ id: IdSchema }).strict()
const ReportChatMessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

const REPORT_CHAT_HISTORY_DEFAULT = 30
const REPORT_CHAT_HISTORY_MAX = 50

export const REPORT_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

/** L11: message deletes are state changes with a broadcast; 30/min matches the cleanup-room delete cap. */
export const REPORT_DELETE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

/**
 * L11: report-chat join/leave churn is deliberately bounded TIGHTER than the other chat limits. Each
 * pair writes and deletes a report_chat_members row and moves the caller in and out of a public room's
 * roster + notification fan-out, so an unbounded loop is both a write amplifier and a roster-flicker
 * nuisance for everyone else. 20/min is far more than any real user (who joins a room once).
 */
export const REPORT_CHAT_MEMBERSHIP_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute" })

export async function registerReportChatRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    app.chatOverrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  // Report-chat MEMBERSHIP repo (report_chat_members). Mirrors getChatRepo: an injected fake
  // (app.chatOverrides.reportChat) wins, else a lazily-built drizzle repo. Fake-chat route tests MUST
  // supply chatOverrides.reportChat because the real repo touches the DB.
  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    app.chatOverrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  let discussionRepo: DiscussionRepository | undefined
  const getReportRepo = (): DiscussionRepository =>
    app.discussionOverrides?.repo ??
    (discussionRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql))

  const requireVisibleReport = async (
    reportId: string,
    viewerUserId: string | null,
  ): Promise<void> => {
    const report = await getReportRepo().findReportForDiscussion(reportId)
    if (!isReportVisibleTo(report, viewerUserId)) throw AppError.notFound("Report not found")
  }

  route(app, "reportMessages", async (request, reply) => {
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    const q = parse(ReportChatHistoryRequestSchema, { ...(request.query as object), id })
    const limit = Math.min(
      Math.max(q.limit ?? REPORT_CHAT_HISTORY_DEFAULT, 1),
      REPORT_CHAT_HISTORY_MAX,
    )
    const viewerUserId = request.auth?.userId ?? null
    await requireVisibleReport(id, viewerUserId)
    // `around` (P2 2.4) centers the page on a target message (schema rejects around+before together);
    // the pins-on-the-initial-page-only contract lives in chatHistoryPayload.
    const payload: ChatHistoryResponse = await chatHistoryPayload(
      {
        history: (before, pageLimit, around) =>
          getChatRepo().reportHistory(id, before, pageLimit, viewerUserId, around),
        listPins: () => getChatRepo().listReportPins(id, viewerUserId),
      },
      q,
      limit,
    )
    reply.status(200).send(payload)
  })

  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "deleteReportMessage",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_DELETE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(ReportChatMessageParamsSchema, request.params)
      parse(DeleteReportMessageRequestSchema, { id, messageId })
      await requireVisibleReport(id, userId)
      // Report chat is view-only until you Join: a MEMBER may self-delete (sender-gated in the repo).
      // A non-member is NOT pre-gated out entirely (P3 Task 3.5): platform OPERATORS hold delete-others
      // power in the public report rooms WITHOUT a membership row, so the ladder still consults the
      // chat-powers resolver before rejecting. Report owners do NOT get delete-others.
      const chatRepo = getChatRepo()
      const tombstone = await deleteMessageWithPowers({
        roomKind: "report",
        roomId: id,
        messageId,
        userId,
        senderPath: await getReportChatRepo().isMember(id, userId),
        softDelete: (opts) => chatRepo.softDeleteReport(id, messageId, userId, opts),
        findMessageMeta: (mid) => chatRepo.findMessageMeta(mid),
        resolveChatPowers,
        chat: container.chatService,
        legacyBroadcast: true,
      })
      reply.status(200).send(tombstone)
    },
  )

  route(
    app,
    "toggleReportMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(ReportChatMessageParamsSchema, request.params)
      const body = parse(ToggleReportMessageReactionRequestSchema, {
        ...(request.body as object),
        id,
        messageId,
      })
      // GATES: both of them (report VISIBILITY -> 404 "Report not found", then report_chat_members
      // membership -> 403 "Join the chat to react to messages.") run INSIDE the service below, in that
      // order, off the two deps wired here. This route deliberately does NOT pre-run them: the duplicate
      // pre-checks cost two extra round trips (a report read + a membership read) on the hottest chat
      // mutation and answered with the same status and the same copy the service produces.
      const reactions = makeChatReactionService({
        chat: getChatRepo(),
        isReportChatMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
        isReportVisible: async (reportId, uid) =>
          isReportVisibleTo(await getReportRepo().findReportForDiscussion(reportId), uid),
      })
      const updated: ChatMessageDTO = await reactions.toggleReportReaction(
        id,
        messageId,
        userId,
        body.emoji,
      )
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("report", id), {
          type: "reaction",
          cleanupId: id,
          roomKind: "report",
          message: updated,
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )

  route(
    app,
    "joinReportChat",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CHAT_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportChatIdParamsSchema, request.params)
      parse(JoinReportChatRequestSchema, { id })
      // The report must still be visible to the joiner (do not let a held/private report be joined).
      await requireVisibleReport(id, userId)
      await getReportChatRepo().join(id, userId, "member")
      // Nudge the joiner's own inbox so the newly-joined report chat surfaces (best-effort; the client
      // also invalidates on the mutation).
      void Promise.resolve(
        container.userChannel?.publishToUser(userId, { topic: "threads" }),
      ).catch(() => {})
      reply.status(200).send({ ok: true })
    },
  )

  route(
    app,
    "leaveReportChat",
    { preHandler: csrfProtect, config: { rateLimit: REPORT_CHAT_MEMBERSHIP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportChatIdParamsSchema, request.params)
      parse(LeaveReportChatRequestSchema, { id })
      await getReportChatRepo().leave(id, userId)
      void Promise.resolve(
        container.userChannel?.publishToUser(userId, { topic: "threads" }),
      ).catch(() => {})
      reply.status(200).send({ ok: true })
    },
  )
}
