
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
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import { makeDrizzleChatRepository, type ChatRepository } from "../services/chat-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeMediaPresigner } from "../services/media-presign.js"
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

const REPORT_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerReportChatRoutes(app: FastifyInstance, container: Container): Promise<void> {
  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    app.chatOverrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

  // Report-chat MEMBERSHIP repo (report_chat_members). Mirrors getChatRepo: an injected fake
  // (app.chatOverrides.reportChat) wins, else a lazily-built drizzle repo. Fake-chat route tests MUST
  // supply chatOverrides.reportChat because the real repo touches the DB.
  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    app.chatOverrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

  let discussionRepo: DiscussionRepository | undefined
  const getReportRepo = (): DiscussionRepository =>
    app.discussionOverrides?.repo ??
    (discussionRepo ??= makeDrizzleDiscussionRepository(container.getDb().sql))

  const requireVisibleReport = async (reportId: string, viewerUserId: string | null): Promise<void> => {
    const report = await getReportRepo().findReportForDiscussion(reportId)
    if (!isReportVisibleTo(report, viewerUserId)) throw AppError.notFound("Report not found")
  }

  route(app, "reportMessages", async (request, reply) => {
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    const q = parse(ReportChatHistoryRequestSchema, { ...(request.query as object), id })
    const limit = Math.min(Math.max(q.limit ?? REPORT_CHAT_HISTORY_DEFAULT, 1), REPORT_CHAT_HISTORY_MAX)
    const viewerUserId = request.auth?.userId ?? null
    await requireVisibleReport(id, viewerUserId)
    // `around` (P2 2.4) centers the page on a target message (schema rejects around+before together).
    // Pins (P3) ride ONLY the initial page (no before, no around): pagination/around pages stay lean
    // and the client refreshes its pin rail exactly when it (re)opens the room.
    const isInitialPage = q.before === undefined && q.around === undefined
    const [page, pins] = await Promise.all([
      getChatRepo().reportHistory(id, q.before, limit, viewerUserId, q.around),
      isInitialPage ? getChatRepo().listReportPins(id, viewerUserId) : Promise.resolve(undefined),
    ])
    // prevCursor is ABSENT on before-mode pages (byte-identical to pre-2.4 responses) and always
    // present — possibly null (window reaches the live head) — on around-mode pages.
    const payload: ChatHistoryResponse = {
      items: page.items,
      nextCursor: page.nextCursor,
      ...(page.prevCursor !== undefined ? { prevCursor: page.prevCursor } : {}),
      ...(pins !== undefined ? { pins } : {}),
    }
    reply.status(200).send(payload)
  })

  const resolveChatPowers = wireChatPowers(app, container)

  route(app, "deleteReportMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id, messageId } = parse(ReportChatMessageParamsSchema, request.params)
    parse(DeleteReportMessageRequestSchema, { id, messageId })
    await requireVisibleReport(id, userId)
    // Report chat is view-only until you Join: a MEMBER may self-delete (sender-gated in the repo).
    // A non-member is NOT pre-gated out entirely (P3 Task 3.5): platform OPERATORS hold delete-others
    // power in the public report rooms WITHOUT a membership row, so when the sender path doesn't apply
    // we consult the chat-powers resolver before rejecting. Report owners do NOT get delete-others.
    let tombstone: ChatMessageDTO | null = null
    if (await getReportChatRepo().isMember(id, userId)) {
      tombstone = await getChatRepo().softDeleteReport(id, messageId, userId)
    }
    if (tombstone === null) {
      const powers = await resolveChatPowers({ roomKind: "report", roomId: id, userId })
      if (!powers.canDeleteOthers) throw AppError.forbidden("You can't delete this message.")
      tombstone = await getChatRepo().softDeleteReport(id, messageId, userId, { bypassSenderGate: true })
    }
    if (tombstone === null) throw AppError.forbidden("You can't delete this message.")
    void Promise.resolve(
      container.chatService.broadcast(roomKeyFor("report", id), tombstone),
    ).catch(() => {})
    // P0: {type:"message_update"} with the tombstoned DTO so connected clients drop the bubble live
    // (previously they only learned of a delete on refetch). Best-effort, alongside the legacy frame.
    broadcastMessageUpdate(container.chatService, "report", id, tombstone)
    reply.status(200).send(tombstone)
  })

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
      await requireVisibleReport(id, userId)
      // View-only until you Join: only members may react to report messages.
      if (!(await getReportChatRepo().isMember(id, userId))) {
        throw AppError.forbidden("Join the chat to react to messages.")
      }
      const reactions = makeChatReactionService({ chat: getChatRepo() })
      const updated: ChatMessageDTO = await reactions.toggleReportReaction(id, messageId, userId, body.emoji)
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

  route(app, "joinReportChat", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    parse(JoinReportChatRequestSchema, { id })
    // The report must still be visible to the joiner (do not let a held/private report be joined).
    await requireVisibleReport(id, userId)
    await getReportChatRepo().join(id, userId, "member")
    // Nudge the joiner's own inbox so the newly-joined report chat surfaces (best-effort; the client also
    // invalidates on the mutation).
    void Promise.resolve(container.userChannel?.publishToUser(userId, { topic: "threads" })).catch(() => {})
    reply.status(200).send({ ok: true })
  })

  route(app, "leaveReportChat", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(ReportChatIdParamsSchema, request.params)
    parse(LeaveReportChatRequestSchema, { id })
    await getReportChatRepo().leave(id, userId)
    void Promise.resolve(container.userChannel?.publishToUser(userId, { topic: "threads" })).catch(() => {})
    reply.status(200).send({ ok: true })
  })
}
