/**
 * Report discussion route plugin: the per-report PUBLIC comment thread (separate from the status
 * timeline), one level of replies, lightweight emoji reactions, and the author/operator soft-delete.
 *
 *   GET    /reports/:id/discussion                            [anon-ok]      page top-level messages.
 *   GET    /reports/:id/discussion/:messageId/replies         [anon-ok]      page a message's replies.
 *   POST   /reports/:id/discussion                            [auth][csrf]   post a message (or a reply).
 *   PATCH  /reports/:id/discussion/:messageId                 [auth][csrf]   author edits their message.
 *   POST   /reports/:id/discussion/:messageId/reactions       [auth][csrf]   toggle a reaction.
 *   DELETE /reports/:id/discussion/:messageId                 [auth][csrf]   author deletes their message.
 *
 * The READS are anon-ok: the viewer is the optional request.auth.userId (drives `mine`); a held/hidden
 * report 404s a non-owner (enforced inside the service). The WRITES carry csrfProtect AND a tighter per-IP
 * rate limit so a chatty/abusive client cannot flood the thread.
 *
 * The discussion service is built per request from either an injected override bundle (tests: in-memory
 * repo + fake presigner + stub OutboundMailService) or from the container (production: Drizzle repo,
 * Storage presign, OutboundMailService, ChatService WS broadcast, and the best-effort bells). Built lazily
 * so merely mounting the plugin opens no connection.
 */

import {
  CreateDiscussionMessageRequestSchema,
  EditDiscussionMessageRequestSchema,
  DiscussionHistoryQuerySchema,
  ToggleReactionRequestSchema,
  IdSchema,
  type DiscussionMessageDTO,
  type DiscussionPageResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { MEDIA_GET_URL_TTL_SEC } from "../services/media-intake-service.js"
import {
  makeDiscussionService,
  type DiscussionRepository,
  type DiscussionService,
  type DiscussionServiceDeps,
} from "../services/discussion-service.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import { resolveMentionTargets } from "../services/social-repository.drizzle.js"
import {
  makeOutboundMailService,
  type OutboundMailService,
} from "../services/admin/outbound-mail-service.js"
import { makeDrizzleMailRepository } from "../services/admin/mail-repository.drizzle.js"
import { roomKeyFor } from "../ws/gateway.js"
import { makeNotificationService } from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"

const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()
const MessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

// Tighter per-IP rate limit for discussion WRITES (post / react / delete): 30/min bounds automated
// flooding while staying ample for a real commenter. The global ceiling still applies underneath.
export const DISCUSSION_WRITE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

// fast-json-stringify response schema for the anon-ok list reads (the 2-3x serialization path). Every DTO
// field is listed so none is silently dropped; optional fields (editedAt/deletedAt/codec/thumbUrl/etc.)
// are present in `properties` but absent from `required`, preserving the wire contract.
const DiscussionMessageJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    reportId: { type: "string" },
    parentId: { type: "string", nullable: true },
    author: {
      type: "object",
      nullable: true,
      properties: {
        id: { type: "string" },
        displayName: { type: "string" },
        handle: { type: "string", nullable: true },
        avatar: { type: "array", items: { type: "string" }, nullable: true },
        avatarUrl: { type: "string", nullable: true },
        deleted: { type: "boolean" },
      },
      required: ["id", "displayName"],
    },
    body: { type: "string" },
    attachments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["image", "video"] },
          codec: { type: "string", nullable: true },
          url: { type: "string" },
          thumbUrl: { type: "string", nullable: true },
          width: { type: "number", nullable: true },
          height: { type: "number", nullable: true },
          status: { type: "string", enum: ["validating", "ready", "rejected", "held"] },
        },
        required: ["id", "kind", "url", "status"],
      },
    },
    reactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          emoji: { type: "string" },
          count: { type: "number" },
          mine: { type: "boolean" },
        },
        required: ["emoji", "count", "mine"],
      },
    },
    mentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          handle: { type: "string" },
          displayName: { type: "string" },
        },
        required: ["id", "handle", "displayName"],
      },
    },
    replyCount: { type: "number" },
    cityMention: {
      type: "object",
      nullable: true,
      properties: {
        handle: { type: "string" },
        geoid: { type: "string" },
        name: { type: "string" },
        forwarded: { type: "boolean" },
      },
      required: ["handle", "geoid", "name", "forwarded"],
    },
    forwardedToCity: { type: "boolean" },
    createdAt: { type: "string" },
    editedAt: { type: "string", nullable: true },
    deletedAt: { type: "string", nullable: true },
    mine: { type: "boolean" },
  },
  required: [
    "id",
    "reportId",
    "parentId",
    "author",
    "body",
    "attachments",
    "reactions",
    "mentions",
    "replyCount",
    "cityMention",
    "forwardedToCity",
    "createdAt",
    "mine",
  ],
} as const

const DiscussionPageResponseJsonSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: DiscussionMessageJsonSchema },
    nextCursor: { type: "string", nullable: true },
  },
  required: ["items", "nextCursor"],
} as const

// Optional injected discussion-service dependencies (tests). The broadcast/notify hooks are left to the
// service's optional deps (a test usually omits them).
export interface DiscussionServiceOverrides {
  repo: DiscussionRepository
  outboundMail: OutboundMailService
  presignMedia?: DiscussionServiceDeps["presignMedia"]
  broadcast?: DiscussionServiceDeps["broadcast"]
  notifyOnMessage?: DiscussionServiceDeps["notifyOnMessage"]
  resolveMentions?: DiscussionServiceDeps["resolveMentions"]
  notifyMention?: DiscussionServiceDeps["notifyMention"]
  newId?: DiscussionServiceDeps["newId"]
  now?: DiscussionServiceDeps["now"]
}

declare module "fastify" {
  interface FastifyInstance {
    discussionOverrides?: DiscussionServiceOverrides
  }
}

export async function registerDiscussionRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function service(): DiscussionService {
    const overrides = app.discussionOverrides
    if (overrides) {
      return makeDiscussionService({
        repo: overrides.repo,
        outboundMail: overrides.outboundMail,
        presignMedia: overrides.presignMedia ?? defaultPresign(container),
        ...(overrides.broadcast !== undefined ? { broadcast: overrides.broadcast } : {}),
        ...(overrides.notifyOnMessage !== undefined
          ? { notifyOnMessage: overrides.notifyOnMessage }
          : {}),
        ...(overrides.resolveMentions !== undefined
          ? { resolveMentions: overrides.resolveMentions }
          : {}),
        ...(overrides.notifyMention !== undefined
          ? { notifyMention: overrides.notifyMention }
          : {}),
        ...(overrides.newId !== undefined ? { newId: overrides.newId } : {}),
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      })
    }

    const sql = container.getDb().sql
    const repo: DiscussionRepository = makeDrizzleDiscussionRepository(sql)
    const outboundMail = makeOutboundMailService({
      repo: makeDrizzleMailRepository(sql),
      mailer: container.mailer,
      env: {
        MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
        MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
      },
    })
    return makeDiscussionService({
      repo,
      outboundMail,
      presignMedia: defaultPresign(container),
      // Live fan-out over the report-discussion WS room. roomKeyFor is the single source of truth for the
      // "rd:" room-key prefix; discussion writes go over HTTP, so this is the ONLY place that fans out the
      // {type:"discussion"} frame. Fire-and-forget: a fan-out failure must never affect the HTTP response.
      broadcast: (reportId, event) => {
        void Promise.resolve(
          container.chatService.broadcastEvent?.(roomKeyFor("report_discussion", reportId), {
            type: "discussion",
            reportId,
            event,
          }),
        ).catch(() => {})
      },
      // Best-effort report-owner / parent-author bell. Unwired in the all-fakes dev path (no notification
      // store), where the WS live signal + follow bell still provide awareness.
      ...(container.env.USE_FAKE_CHAT
        ? {}
        : { notifyOnMessage: makeDiscussionNotifier(container) }),
      // USER @-mention resolution over the lazily-created DB handle (no connection until a write). No
      // block/pref filtering here (that gates the notification only).
      resolveMentions: (input) => resolveMentionTargets(sql, input),
      // Best-effort per-mentioned-user bell. Block-gated here; pref-gated inside the notification service.
      ...(container.env.USE_FAKE_CHAT
        ? {}
        : { notifyMention: makeMentionNotifier(container) }),
    })
  }

  route(
    app,
    "getReportDiscussion",
    { schema: { response: { 200: DiscussionPageResponseJsonSchema } } },
    async (request, reply) => {
      const { id } = parse(ReportIdParamsSchema, request.params)
      const q = parse(DiscussionHistoryQuerySchema, request.query)
      const payload: DiscussionPageResponse = await service().list(
        id,
        viewerOf(request),
        q.cursor ?? null,
        q.limit ?? 0,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "getDiscussionReplies",
    { schema: { response: { 200: DiscussionPageResponseJsonSchema } } },
    async (request, reply) => {
      const { id, messageId } = parse(MessageParamsSchema, request.params)
      const q = parse(DiscussionHistoryQuerySchema, request.query)
      const payload: DiscussionPageResponse = await service().listReplies(
        id,
        messageId,
        viewerOf(request),
        q.cursor ?? null,
        q.limit ?? 0,
      )
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "postDiscussionMessage",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportIdParamsSchema, request.params)
      // The body schema carries the report id (the typed client fills `:id`); the authoritative id is the
      // URL path, so stamp it before validating.
      const body = parse(CreateDiscussionMessageRequestSchema, { ...(request.body as object), id })
      const dto: DiscussionMessageDTO = await service().createMessage(id, userId, {
        body: body.body,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.mediaUploadIds !== undefined ? { mediaUploadIds: body.mediaUploadIds } : {}),
        ...(body.mentionedUserIds !== undefined ? { mentionedUserIds: body.mentionedUserIds } : {}),
      })
      reply.status(201).send(dto)
    },
  )

  route(
    app,
    "editDiscussionMessage",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(MessageParamsSchema, request.params)
      // The authoritative ids are the URL path; stamp them before validating. The service enforces
      // author-only (404 if not the author).
      const body = parse(EditDiscussionMessageRequestSchema, {
        ...(request.body as object),
        id,
        messageId,
      })
      const dto: DiscussionMessageDTO = await service().editMessage(id, messageId, userId, {
        body: body.body,
        ...(body.mediaUploadIds !== undefined ? { mediaUploadIds: body.mediaUploadIds } : {}),
        ...(body.mentionedUserIds !== undefined ? { mentionedUserIds: body.mentionedUserIds } : {}),
      })
      reply.status(200).send(dto)
    },
  )

  route(
    app,
    "toggleDiscussionReaction",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(MessageParamsSchema, request.params)
      const body = parse(ToggleReactionRequestSchema, { ...(request.body as object), id, messageId })
      const dto: DiscussionMessageDTO = await service().toggleReaction(
        id,
        messageId,
        userId,
        body.emoji,
      )
      reply.status(200).send(dto)
    },
  )

  route(
    app,
    "deleteDiscussionMessage",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(MessageParamsSchema, request.params)
      // Citizen path: the actor is the message author (isOperator=false). The service forbids deleting a
      // message the caller does not own (operators remove via the audited admin route instead).
      const dto: DiscussionMessageDTO = await service().deleteMessage(id, messageId, {
        userId,
        isOperator: false,
      })
      reply.status(200).send(dto)
    },
  )
}

function defaultPresign(container: Container): DiscussionServiceDeps["presignMedia"] {
  return async (r2Key: string, thumbKey: string | null) => {
    const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

/**
 * Best-effort post-create notification hook (production). Reuses the EXISTING `report_update` type (NO
 * @civfix/shared change): a new TOP-LEVEL message notifies the report owner; a REPLY notifies the parent
 * author. Self / missing recipient is skipped. Fully fire-and-forget: a notify error never affects the
 * HTTP response. Built off the lazily-created DB handle (the same per-request construction the other
 * routes use).
 */
function makeDiscussionNotifier(
  container: Container,
): NonNullable<DiscussionServiceDeps["notifyOnMessage"]> {
  return (input) => {
    const recipient = input.isReply ? input.parentAuthorUserId : input.reportOwnerUserId
    if (recipient === null || recipient === input.actorUserId) return
    void Promise.resolve()
      .then(async () => {
        const notifications = makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
        })
        await notifications.createNotification(recipient, {
          type: "report_update",
          titleKey: input.isReply ? "notification.reply.title" : "notification.comment.title",
          bodyKey: input.isReply ? "notification.reply.body" : "notification.comment.body",
          link: `/reports/${input.reportId}`,
        })
      })
      .catch(() => {})
  }
}

/**
 * Best-effort per-mentioned-user notification hook (production). Reuses `report_update` (no shared change).
 * GATED: suppressed when the actor and mentioned user blocked each other either way AND when the mentioned
 * user muted the dedicated `mentions` pref (checked here because the reused `report_update` type cannot
 * distinguish a mention in typeAllowedByPrefs). Self is already excluded by the service. Fire-and-forget.
 */
function makeMentionNotifier(
  container: Container,
): NonNullable<DiscussionServiceDeps["notifyMention"]> {
  return (input) => {
    void Promise.resolve()
      .then(async () => {
        const blocks = container.getBlocksRepo()
        if (await blocks.isBlockedEitherWay(input.actorUserId, input.mentionedUserId)) return
        const notifications = makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
        })
        const prefs = await notifications.getPrefs(input.mentionedUserId)
        if (!prefs.mentions) return
        await notifications.createNotification(input.mentionedUserId, {
          type: "report_update",
          titleKey: "notification.report_mention.title",
          bodyKey: "notification.report_mention.body",
          link: `/reports/${input.reportId}`,
        })
      })
      .catch(() => {})
  }
}

function viewerOf(request: FastifyRequest): string | null {
  return request.auth?.userId ?? null
}
