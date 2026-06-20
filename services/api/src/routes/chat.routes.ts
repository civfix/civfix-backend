/**
 * Chat route plugin: the WebSocket upgrade (GET /ws) and the threads list (GET /threads).
 *
 *   GET /ws        the WebSocket chat gateway. Dual handshake auth (session cookie OR ?token=<bearer>),
 *                  then membership-gated join/send + live fan-out. See ws/gateway.ts.
 *   GET /threads   [auth]  the viewer's cleanup chat threads as MessageThreadDTO (title/last/ago/unread/
 *                  members/lastFromMe).
 *
 * @fastify/websocket is registered here (once) so GET /ws can upgrade. The gateway's membership probe and
 * the threads aggregates both come from the cleanups/threads seams: in production the Drizzle-backed
 * repos over the lazily-created DB handle; in tests an injected override bundle so the whole gateway +
 * threads flow runs offline. A single ChatReadState instance is shared between the gateway's `ack`
 * handler (writes the read watermark) and the threads service (reads it for unread counts).
 */

import fastifyWebsocket from "@fastify/websocket"
import {
  PaginationQuerySchema,
  ToggleCleanupMessageReactionRequestSchema,
  IdSchema,
  AppError,
  type ChatMessageDTO,
  type ListThreadsResponse,
} from "@civfix/shared"
import { ZodError, z, type ZodTypeAny } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import { roomKeyFor } from "../ws/gateway.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { makeDrizzleChatRepository, type ChatRepository } from "../services/chat-repository.drizzle.js"
import {
  registerChatGateway,
  type GatewayChatMentions,
  type GatewayDmDeps,
  type IsBlockedEitherWayFn,
  type IsMemberFn,
  type ThreadRecipientsOf,
} from "../ws/gateway.js"
import { resolveMentionTargets } from "../services/social-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import { THREAD_SIGNAL_MEMBER_CAP } from "../services/cleanup-service.js"
import { makeDrizzleThreadsRepository } from "../services/threads-repository.drizzle.js"
import { makeDrizzleChatReadState } from "../services/chat-read-state.drizzle.js"
import { makeNotificationService, type NotificationService } from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import {
  InMemoryChatPresence,
  RedisChatPresence,
  type ChatPresence,
} from "../adapters/chat-presence.js"
import {
  makeThreadsService,
  InMemoryChatReadState,
  THREADS_DEFAULT_LIMIT,
  type ChatReadState,
  type DmThreadsSource,
  type ThreadsRepository,
} from "../services/threads-service.js"

/**
 * Optional injected chat/threads dependencies (tests). When present the gateway + threads routes use
 * these instead of the container DB seams, so the WS gateway and GET /threads run offline. The same
 * isMember probe gates the gateway; the same readState backs both unread counts and the `ack` watermark.
 */
export interface ChatGatewayOverrides {
  isMember: IsMemberFn
  threadsRepo: ThreadsRepository
  readState?: ChatReadState
  presence?: ChatPresence
  /** Injected DM repository (tests/dev): backs the gateway dm seam + the threads UNION + the dm routes. */
  dmRepo?: DmRepository
  /** Injected chat repository (tests/dev): backs the cleanup-chat reaction toggle route. */
  chatRepo?: ChatRepository
  /** Injected blocks repository (tests/dev): backs the gateway block check + the block routes. */
  blocksRepo?: BlocksRepository
  /**
   * Injected notification service (tests): backs the dm bell-notification + the cleanup/dm read clears, so
   * the whole notify-on-dm path runs offline without a DB. When omitted in production the route builds the
   * DB-backed service; in the all-fakes dev path (no DB) the notify path is a no-op (left undefined).
   */
  notificationService?: NotificationService
  /** Injected chat @-mention seam (tests): backs the send-frame mention resolve/persist/notify path. */
  chatMentions?: GatewayChatMentions
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected chat/threads overrides (tests). See ChatGatewayOverrides. */
    chatOverrides?: ChatGatewayOverrides
  }
}

export async function registerChatRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  // Register the websocket plugin once so GET /ws can upgrade. maxPayload bounds an oversized frame.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 64 * 1024 },
  })

  const overrides = app.chatOverrides

  // The shared read-state store. In production it is DB-backed (cleanup_members.last_read_at) so unread
  // counts decrement on read AND survive a restart / span instances; in the all-fakes dev/test path
  // (USE_FAKE_CHAT, no DB) it is process-local. One instance backs both the gateway `ack` writes and the
  // threads `unread` reads so they agree.
  const readState: ChatReadState =
    overrides?.readState ??
    (container.env.USE_FAKE_CHAT
      ? new InMemoryChatReadState()
      : makeDrizzleChatReadState(container.getDb().sql))

  // The presence registry powers the live "N online" snapshot/deltas. Redis-backed in production (shared
  // source of truth across workers, self-healing via the heartbeat); in-memory in the all-fakes path.
  const presence: ChatPresence =
    overrides?.presence ??
    (container.env.USE_FAKE_CHAT
      ? new InMemoryChatPresence()
      : new RedisChatPresence(container.getRedis()))

  // Membership probe: injected (tests) or the Drizzle cleanup repo's isMember (production). Built lazily
  // so merely registering the plugin opens no DB connection.
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => makeDrizzleCleanupRepository(container.getDb().sql).isMember(cleanupId, userId)

  // DM + blocks seams. Tests inject them through the overrides; otherwise they come from the container's
  // MEMOIZED singletons (Drizzle-backed in production, in-memory in the all-fakes dev path), so the
  // gateway, the threads UNION, and the dm/block routes all share the SAME store. A partial override is
  // allowed (a test may inject only one); the other falls back to the container singleton.
  const blocksRepo: BlocksRepository = overrides?.blocksRepo ?? container.getBlocksRepo()
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()

  // The notification service backs the dm BELL notification (a `type:"dm"` row + the normal inline push)
  // and the cleanup/dm read-path CLEARS. Built LOCALLY here (the same per-request construction pattern
  // social.routes/notifications.routes use: a DB-backed notification repo + the container's push/userChannel
  // seams + a logger), NOT lifted onto the DI Container. Tests inject it; in production it is the DB-backed
  // service; in the all-fakes dev path (USE_FAKE_CHAT, no DB) there is no DB to read prefs/insert rows, so
  // the notify path is a no-op (undefined) — DM bell parity in dev is moot. Built off the lazily-created DB
  // handle, so merely registering the plugin opens no connection.
  const notificationService: NotificationService | undefined =
    overrides?.notificationService ??
    (container.env.USE_FAKE_CHAT
      ? undefined
      : makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
          logger: app.log,
        }))

  // The DM read watermark resolves an acked message's created_at scoped to the thread (mirrors the cleanup
  // resolveReadAt below); a foreign/unknown id falls back to now() so a stray ack still advances liveness.
  const dmGatewayDeps: GatewayDmDeps = {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: async (threadId, userId) => {
      const t = await dmRepo.getThread(threadId)
      if (t === null) return null
      if (t.userLo === userId) return t.userHi
      if (t.userHi === userId) return t.userLo
      return null
    },
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId, upToId) => {
      const at = (await dmRepo.resolveMessageCreatedAt(threadId, upToId)) ?? new Date()
      await dmRepo.markRead(threadId, userId, at)
      // (b) Cross-update: reading this dm conversation clears the reader's `dm` bell notifications that link
      // to it (`/messages/dm/<threadId>`), then fires the {topic:"notifications"} signal (inside the service)
      // so an open bell refreshes. The gateway already participation-gated this markRead (peerOf != null).
      // Best-effort: a notify-clear failure must NEVER break the read/ack path.
      if (notificationService) {
        try {
          await notificationService.clearByTypeAndLink(userId, "dm", `/messages/dm/${threadId}`)
        } catch (err) {
          app.log.warn({ err, threadId, userId }, "dm read: clear dm notifications failed (suppressed)")
        }
      }
    },
  }
  const isBlockedEitherWay: IsBlockedEitherWayFn = (a, b) => blocksRepo.isBlockedEitherWay(a, b)

  // The DM half of the inbox: a thin source over the dm repo's listThreadsForUser, merged with cleanup
  // threads by the threads service.
  const dmThreadsSource: DmThreadsSource = {
    listDmThreadsFor: (userId) => dmRepo.listThreadsForUser(userId),
  }

  // Resolve the read watermark for an `ack`: the created_at of the acked message (upToId), NOT the
  // server's wall clock. Stamping now() would push the watermark past the acked message and silently mark
  // a message that arrived in the ack's debounce/network window as read (undercounting unread). Anchoring
  // to the message's own timestamp marks read EXACTLY up to what the client acked; a later message stays
  // unread until its own ack. The lookup is a partition-wise PK seek on chat_messages(id, ...), scoped to
  // the room for safety; a foreign/unknown id falls back to now() so a stray ack still advances liveness.
  // In the all-fakes dev path (no DB) we cannot resolve it, so we use now() (unread precision is moot in
  // dev). Reads come off the lazily-created DB handle, so this opens no connection until an ack lands.
  //
  // PARTITION PRUNING: chat_messages is PARTITIONED BY RANGE (created_at), one partition per calendar
  // month (drizzle/0002_chat_partitioning.sql). Without a created_at predicate the planner cannot prune,
  // so this probes the PK index (id, created_at) in EVERY monthly partition (plus DEFAULT) on every ack —
  // a cost that grows unbounded with calendar time. The `ack` frame carries only upToId (no created_at),
  // but an ack is always for a very recently received message, so we bound the search to the last 90 days.
  // That lets the planner prune to the few recent partitions while still always matching a real ack target;
  // a stale/foreign id (older than the window or unknown) simply falls back to now() as before.
  const resolveReadAt: (cleanupId: string, upToId: string) => Promise<Date> = container.env.USE_FAKE_CHAT
    ? () => Promise.resolve(new Date())
    : async (cleanupId, upToId) => {
        const rows = await container.getDb().sql<{ created_at: Date }[]>`
          SELECT created_at FROM chat_messages
          WHERE id = ${upToId} AND cleanup_id = ${cleanupId} AND created_at >= now() - interval '90 days'
          LIMIT 1
        `
        return rows[0]?.created_at ?? new Date()
      }

  // Resolve the thread-signal recipients for a freshly-persisted message (excludes the sender). DM →
  // the peer (always a single recipient, never the sender). Cleanup → the room's members minus the sender,
  // capped to a soft fan-out bound. In the all-fakes dev path (no DB) we cannot read cleanup membership,
  // so cleanup yields no recipients (the signal is a freshness hint; its absence in dev is harmless). Built
  // off the lazily-created DB handle, so this opens no connection until a message is sent.
  const threadRecipientsOf: ThreadRecipientsOf = async (kind, id, senderId) => {
    if (kind === "dm") {
      const peer = await dmGatewayDeps.peerOf(id, senderId)
      return peer !== null ? [peer] : []
    }
    if (container.env.USE_FAKE_CHAT) return []
    const members = await makeDrizzleCleanupRepository(container.getDb().sql).listMemberIds(
      id,
      THREAD_SIGNAL_MEMBER_CAP,
    )
    return members.filter((m) => m !== senderId)
  }

  // Chat @-mention seam (B2): resolve a send frame's @handles + mentionedUserIds to real users, persist them
  // to chat_message_mentions (one table for cleanup + dm), and raise a per-user bell (block + room-eligibility
  // gated). Only wired when there is a DB (resolve/record/notify all need it) AND a notification service; in
  // the all-fakes dev path there is no store, so mentions in dev chat are a no-op (parity is moot). Tests may
  // inject it via overrides. Built off the lazily-created DB handle, so this opens no connection until a send.
  const chatMentions: GatewayChatMentions | undefined =
    overrides?.chatMentions ??
    (container.env.USE_FAKE_CHAT || !notificationService
      ? undefined
      : {
          resolveChatMentions: (input) => resolveMentionTargets(container.getDb().sql, input),
          recordChatMentions: async (messageId, mentionedUserIds) => {
            // One table for cleanup + dm (message id is a globally-unique uuid). Composite PK de-dupes; the
            // service already de-duped + self-excluded the ids.
            for (const mentionedUserId of mentionedUserIds) {
              await container.getDb().sql`
                INSERT INTO chat_message_mentions (message_id, mentioned_user_id)
                VALUES (${messageId}, ${mentionedUserId})
                ON CONFLICT (message_id, mentioned_user_id) DO NOTHING
              `
            }
          },
          notifyChatMention: async (input) => {
            // ROOM ELIGIBILITY: only notify a user who can actually see the room — a cleanup MEMBER for the
            // cleanup chat, or a thread PARTICIPANT for a dm. (A mention of a non-member is recorded but
            // raises no bell.) BLOCK GATE: suppress when either party blocked the other. PREF gate is applied
            // inside the notification service. Best-effort throughout; the gateway already swallows failures.
            const { kind, roomId, actorUserId, mentionedUserId, message } = input
            // DM: skip the mention bell entirely. A 1:1 DM message IS already a direct message to the only
            // other participant, and the onDmDelivered path below already raises the (presence-suppressed)
            // `type:"dm"` bell for them to the same `/messages/dm/<id>` link — a second mention bell would
            // duplicate it (same type+link, which the notification store does not de-dupe). Cleanup chat has
            // no such peer-delivery bell, so its mention bell is the only signal and is kept.
            if (kind === "dm") return
            if (!(await isMember(roomId, mentionedUserId))) return
            if (await blocksRepo.isBlockedEitherWay(actorUserId, mentionedUserId)) return
            await notificationService.createNotification(mentionedUserId, {
              // Reuse the EXISTING cleanup-room notification type (no frozen-contract change). The title makes
              // it a mention; the body is the message author's name (mirrors the dm bell copy).
              type: "cleanup_chat",
              title: `${mentionAuthorName(message)} mentioned you`,
              body: mentionBody(message),
              link: `/cleanups/${roomId}`,
            })
          },
        })

  // -------------------------------------------------------------------------
  // GET /ws  (WebSocket upgrade; dual handshake auth inside the gateway)
  // -------------------------------------------------------------------------
  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
    markRead: async (cleanupId, userId, upToId) => {
      const at = await resolveReadAt(cleanupId, upToId)
      await readState.markRead(cleanupId, userId, at)
      // (a) Cross-update: reading this cleanup conversation clears the reader's `cleanup_chat` bell
      // notifications that link to it (the admin "Cleanup update" broadcasts link to `/cleanups/<id>`), then
      // fires the {topic:"notifications"} signal (inside the service) so an open bell refreshes. The gateway
      // already membership-gated this markRead. Best-effort: never break the read/ack path.
      if (notificationService) {
        try {
          await notificationService.clearByTypeAndLink(userId, "cleanup_chat", `/cleanups/${cleanupId}`)
        } catch (err) {
          app.log.warn({ err, cleanupId, userId }, "cleanup read: clear notifications failed (suppressed)")
        }
      }
    },
    presence,
    // DM routing: the gateway uses these for `roomKind:"dm"` frames (participant + not-blocked gating,
    // persist, dm read-state). Cleanup group chat is unaffected.
    dm: dmGatewayDeps,
    isBlockedEitherWay,
    // Per-user realtime signals: subscribe each socket's user on the channel for its lifetime, and fan a
    // thread-unread signal to a new message's recipients (resolved above, sender excluded).
    userChannel: container.userChannel,
    threadRecipientsOf,
    // (b) DM bell notification: when a dm message lands and the recipient is NOT actively viewing the room
    // (the gateway suppresses via presence), create a `type:"dm"` notification (+ inline push) for the peer.
    // The gateway resolves the peer (never the sender) and runs the presence check; this builds the copy.
    onDmDelivered: notificationService
      ? async (threadId, recipientId, message) => {
          await notificationService.createNotification(recipientId, {
            type: "dm",
            title: dmNotificationTitle(message),
            body: dmNotificationBody(message),
            link: `/messages/dm/${threadId}`,
          })
        }
      : undefined,
    // Chat @-mentions: resolve/persist/notify on a `send` frame (no-op when the seam is unwired).
    chatMentions,
    // Anti-CSWSH: the gateway rejects a cross-site upgrade Origin not in the WEB_ORIGINS allowlist.
    webOrigins: container.env.WEB_ORIGINS,
  })

  // -------------------------------------------------------------------------
  // GET /threads  [auth]
  // -------------------------------------------------------------------------
  route(app, "listThreads", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    // The shared limit is optional with no baked-in default (each resource owns its page size), so apply
    // the threads default explicitly rather than passing undefined down to the repo's SQL LIMIT.
    const limit = pagination.limit ?? THREADS_DEFAULT_LIMIT
    const threadsRepo: ThreadsRepository = overrides
      ? overrides.threadsRepo
      : makeDrizzleThreadsRepository(container.getDb().sql)
    // Merge cleanup threads with the viewer's DM threads (the dm source already excludes blocked-either-way
    // threads + computes peer/last/unread).
    const threads = makeThreadsService({ repo: threadsRepo, readState, dm: dmThreadsSource })
    const result = await threads.listThreads(userId, limit)
    const payload: ListThreadsResponse = { items: result.items, nextCursor: result.nextCursor }
    reply.status(200).send(payload)
  })

  // -------------------------------------------------------------------------
  // POST /cleanups/:cleanupId/messages/:messageId/reactions  [auth][csrf]  (rate-limited)
  // -------------------------------------------------------------------------
  // Toggle an emoji reaction on a cleanup group-chat message. Mirrors toggleDiscussionReaction: auth + csrf +
  // a per-IP write rate limit; membership-gated (cleanup membership == chat membership) inside the service;
  // returns the recomputed ChatMessageDTO and BROADCASTS a {type:"reaction"} frame to the room.
  route(
    app,
    "toggleCleanupMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: CHAT_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { cleanupId, messageId } = parse(ReactionParamsSchema, request.params)
      // The body schema carries the path ids (the typed client fills them in); the authoritative ids are the
      // URL path, so stamp them before validating the bounded `emoji`.
      const body = parse(ToggleCleanupMessageReactionRequestSchema, {
        ...(request.body as object),
        cleanupId,
        messageId,
      })
      const chatRepo: ChatRepository =
        overrides?.chatRepo ?? makeDrizzleChatRepository(container.getDb().sql)
      const reactions = makeChatReactionService({
        chat: chatRepo,
        dm: dmRepo,
        isCleanupMember: isMember,
        dmPeerOf: dmGatewayDeps.peerOf,
        isBlockedEitherWay,
      })
      const updated: ChatMessageDTO = await reactions.toggleCleanupReaction(
        cleanupId,
        messageId,
        userId,
        body.emoji,
      )
      // REALTIME: fan a {type:"reaction"} frame to the room (the recomputed message), so connected sockets
      // re-render that message's reactions without a refetch. Best-effort + fire-and-forget: a fan-out
      // failure must never fail the toggle (mirrors the discussion route's HTTP-side broadcast). Cleanup is
      // the implicit roomKind (omitted), matching the gateway's stampRoomKind convention.
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor("cleanup", cleanupId), {
          type: "reaction",
          cleanupId,
          message: updated,
        }),
      ).catch(() => {})
      reply.status(200).send(updated)
    },
  )
}

/** Path-param schema for the reaction route (the `:cleanupId`/`:messageId` segments). */
const ReactionParamsSchema = z.object({ cleanupId: IdSchema, messageId: IdSchema }).strict()

/**
 * Tighter per-IP rate limit for chat reaction toggles: a real user toggles a handful per minute; 60/min
 * bounds automated flooding while staying ample. Mirrors the discussion write rate limit shape.
 */
const CHAT_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

/** Max chars of a text dm preview surfaced in the bell body (server-side truncation). */
const DM_PREVIEW_MAX = 80

/**
 * Title for a dm bell notification: the sender's @handle if present, else their display name, else a
 * generic phrase (mirrors the new_follower name fallback in notification-service).
 */
function dmNotificationTitle(message: ChatMessageDTO): string {
  const from = message.from
  if (from.handle) return `@${from.handle}`
  if (from.name.trim() !== "") return from.name
  return "New message"
}

/**
 * Body for a dm bell notification: a server-truncated preview of a text message (~80 chars, ellipsized),
 * or a generic "Sent you a message" for a non-text dm (share_pin / task_complete / rsvp_change / a body-less
 * frame), so we never leak a structured payload as the preview.
 */
function dmNotificationBody(message: ChatMessageDTO): string {
  const body = message.body
  if (message.kind === "text" && typeof body === "string" && body.trim() !== "") {
    const trimmed = body.trim()
    return trimmed.length > DM_PREVIEW_MAX ? `${trimmed.slice(0, DM_PREVIEW_MAX - 1)}…` : trimmed
  }
  return "Sent you a message"
}

/**
 * The mentioning author's display name for a mention bell title: @handle if present, else display name, else
 * a generic phrase. Mirrors dmNotificationTitle's fallback chain (shared copy convention).
 */
function mentionAuthorName(message: ChatMessageDTO): string {
  const from = message.from
  if (from.handle) return `@${from.handle}`
  if (from.name.trim() !== "") return from.name
  return "Someone"
}

/** Body for a mention bell: the same server-truncated text preview / generic fallback as the dm bell. */
function mentionBody(message: ChatMessageDTO): string {
  return dmNotificationBody(message)
}

/**
 * Validate `data` against a Zod schema, throwing AppError.validation (422 with field details) on
 * failure so the canonical envelope is returned instead of a generic 500. Mirrors the other routes.
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
