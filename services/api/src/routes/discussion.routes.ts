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
 * Method/path/version + auth come from the shared endpoint registry via route(); each body/param/query is
 * validated against the shared Zod schema (the same parse() -> AppError.validation pattern as the other
 * route files). The READS are anon-ok: the viewer is the optional request.auth.userId (drives `mine` +
 * per-emoji `mine`); a held/hidden report 404s a non-owner (enforced inside the service). The WRITES carry
 * csrfProtect AND a tighter per-IP rate limit (the same @fastify/rate-limit route-level config the dm /
 * users routes use) so a chatty/abusive client cannot flood the thread.
 *
 * The discussion service is built per request from either an injected override bundle (tests: an in-memory
 * repo + a fake presigner + a stub OutboundMailService, so the whole flow runs offline) or from the
 * container (production: the Drizzle repo, the Storage presign seam, the OutboundMailService over the
 * Drizzle mail repo, the ChatService WS broadcast, and the best-effort report-owner/parent-author bell).
 * Built lazily so merely mounting the plugin opens no connection.
 */

import {
  CreateDiscussionMessageRequestSchema,
  EditDiscussionMessageRequestSchema,
  DiscussionHistoryQuerySchema,
  ToggleReactionRequestSchema,
  IdSchema,
  AppError,
  type DiscussionMessageDTO,
  type DiscussionPageResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
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

/** Path-param schema for the report-id-only routes. */
const ReportIdParamsSchema = z.object({ id: IdSchema }).strict()
/** Path-param schema for the routes that also carry a message id (replies / reactions / delete). */
const MessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

/**
 * Tighter per-IP rate limit for discussion WRITES (post / react / delete): a real commenter posts a
 * handful of times a minute; 30/min bounds automated flooding while staying ample for normal use. Mirrors
 * the dm/users route-level @fastify/rate-limit config (the global ceiling still applies underneath).
 */
export const DISCUSSION_WRITE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

/**
 * Optional injected discussion-service dependencies (tests). When present the routes build the service
 * from these instead of the container, so the whole read/post/react/delete HTTP flow runs offline. The
 * broadcast/notify hooks are left to the service's optional deps (a test usually omits them).
 */
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
    /** Injected discussion-service overrides (tests). See DiscussionServiceOverrides. */
    discussionOverrides?: DiscussionServiceOverrides
  }
}

export async function registerDiscussionRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  /** Build the discussion service from injected overrides (tests) or the container seams (production). */
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
      // Live fan-out over the report-discussion WS room. Best-effort + fire-and-forget: the broadcast
      // signal must NEVER affect the HTTP response, so we void the (optional) broadcastEvent promise and
      // swallow any fan-out failure (mirrors the gateway's fire-and-forget signals). roomKeyFor is the
      // single source of truth for the "rd:" room-key prefix (exported from the gateway). Discussion
      // writes go over HTTP, so this is the ONLY place that fans out the {type:"discussion"} frame.
      broadcast: (reportId, event) => {
        void Promise.resolve(
          container.chatService.broadcastEvent?.(roomKeyFor("report_discussion", reportId), {
            type: "discussion",
            reportId,
            event,
          }),
        ).catch(() => {})
      },
      // Best-effort report-owner / parent-author bell on a new message/reply (reuses the EXISTING
      // `report_update` notification type — no contract change). Fully fire-and-forget: a notify failure
      // must never affect the HTTP response. In the all-fakes dev path (no DB) there is no notification
      // store, so the hook is left unwired (the WS live signal + the follow bell still provide awareness).
      ...(container.env.USE_FAKE_CHAT
        ? {}
        : { notifyOnMessage: makeDiscussionNotifier(container) }),
      // USER @-mention resolution: combine parsed @handles + the request's mentionedUserIds into real users
      // (self excluded). Anyone may be tagged; the resolver applies NO block/pref filtering (that gates the
      // notification only). Runs over the lazily-created DB handle, so no connection opens until a write.
      resolveMentions: (input) => resolveMentionTargets(sql, input),
      // Best-effort per-mentioned-user bell (reuses the EXISTING `report_update` notification type — no
      // contract change). Block-gated here (a mentioner the target blocked, or vice versa, raises no bell);
      // pref-gated inside the notification service. Skipped in the all-fakes dev path (no notification store).
      ...(container.env.USE_FAKE_CHAT
        ? {}
        : { notifyMention: makeMentionNotifier(container) }),
    })
  }

  // -------------------------------------------------------------------------
  // GET /reports/:id/discussion  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "getReportDiscussion", async (request, reply) => {
    const { id } = parse(ReportIdParamsSchema, request.params)
    const q = parse(DiscussionHistoryQuerySchema, request.query)
    const payload: DiscussionPageResponse = await service().list(
      id,
      viewerOf(request),
      q.cursor ?? null,
      q.limit ?? 0,
    )
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // GET /reports/:id/discussion/:messageId/replies  (anon-ok)
  // -------------------------------------------------------------------------
  route(app, "getDiscussionReplies", async (request, reply) => {
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
  })

  // -------------------------------------------------------------------------
  // POST /reports/:id/discussion  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
  route(
    app,
    "postDiscussionMessage",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(ReportIdParamsSchema, request.params)
      // The body schema carries the report id (the typed client fills `:id` into the object); the
      // authoritative id is the URL path, so stamp it before validating.
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

  // -------------------------------------------------------------------------
  // PATCH /reports/:id/discussion/:messageId  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
  route(
    app,
    "editDiscussionMessage",
    { preHandler: csrfProtect, config: { rateLimit: DISCUSSION_WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(MessageParamsSchema, request.params)
      // The body schema carries both path ids (the typed client fills them in); the authoritative ids are
      // the URL path, so stamp them before validating. `body` (1..4000) is required; `mediaUploadIds`
      // (optional) REPLACES the attachment set. The service enforces author-only (404 if not the author).
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

  // -------------------------------------------------------------------------
  // POST /reports/:id/discussion/:messageId/reactions  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // DELETE /reports/:id/discussion/:messageId  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
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

/** Build the default media presigner over the container's Storage seam (mirrors the report path). */
function defaultPresign(container: Container): DiscussionServiceDeps["presignMedia"] {
  return async (r2Key: string, thumbKey: string | null) => {
    const url = await container.storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await container.storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

/**
 * Build the best-effort post-create notification hook (production). Reuses the EXISTING `report_update`
 * notification type (so NO @civfix/shared contract change): on a new TOP-LEVEL message the report's owner
 * is notified; on a REPLY the parent message's author is notified. The actor (author) is always excluded,
 * and a missing recipient (anonymous report / system-authored parent / self) is skipped. Fully
 * fire-and-forget: the hook voids the createNotification promise and swallows failures, so a notify error
 * never affects the discussion-post HTTP response (the notification service ALSO swallows its push/signal
 * failures internally). The notification service is built off the lazily-created DB handle here, the same
 * per-request construction the chat/social/notification routes use.
 */
function makeDiscussionNotifier(
  container: Container,
): NonNullable<DiscussionServiceDeps["notifyOnMessage"]> {
  return (input) => {
    // Resolve the single recipient: the parent author for a reply, else the report owner. Exclude self.
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
          title: input.isReply ? "New reply on your comment" : "New comment on your report",
          body: input.isReply
            ? "Someone replied to your comment."
            : "Someone commented on your report.",
          link: `/reports/${input.reportId}`,
        })
      })
      .catch(() => {})
  }
}

/**
 * Build the best-effort per-mentioned-user notification hook (production). Reuses the EXISTING `report_update`
 * notification type so NO @civfix/shared contract change (the frozen notification enum gains nothing). The
 * mention bell is GATED: it is suppressed when the actor and the mentioned user blocked each other either way
 * (so a block silences a mention ping) AND when the mentioned user has muted the dedicated `mentions` pref
 * (checked here because the reused `report_update` type cannot distinguish a mention in typeAllowedByPrefs),
 * and the notification service then applies the user's notification prefs/quiet-hours to the push. Self is
 * already excluded by the service. Fully fire-and-forget: a notify
 * failure (or a blocks/DB hiccup) never affects the discussion HTTP response. Built off the lazily-created DB
 * handle, the same per-request construction the chat/social/notification routes use.
 */
function makeMentionNotifier(
  container: Container,
): NonNullable<DiscussionServiceDeps["notifyMention"]> {
  return (input) => {
    void Promise.resolve()
      .then(async () => {
        // Block gate: do not raise a mention bell when either party blocked the other.
        const blocks = container.getBlocksRepo()
        if (await blocks.isBlockedEitherWay(input.actorUserId, input.mentionedUserId)) return
        const notifications = makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
        })
        // Honor the dedicated `mentions` mute. The bell reuses the `report_update` type, so the per-type
        // pref gate inside the service cannot distinguish a mention — enforce the mentions toggle here.
        const prefs = await notifications.getPrefs(input.mentionedUserId)
        if (!prefs.mentions) return
        await notifications.createNotification(input.mentionedUserId, {
          type: "report_update",
          title: "You were mentioned",
          body: "Someone mentioned you in a report discussion.",
          link: `/reports/${input.reportId}`,
        })
      })
      .catch(() => {})
  }
}

/** Resolve the optional viewer user id from the resolved auth (anon-ok reads). */
function viewerOf(request: FastifyRequest): string | null {
  return request.auth?.userId ?? null
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on failure
 * so the canonical envelope is returned instead of a generic 500. Mirrors the other route plugins.
 */
function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
