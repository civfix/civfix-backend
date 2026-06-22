/**
 * Chat gateway wiring: assembles the seams the WS gateway needs (read-state, presence, membership, DM,
 * blocks, per-user signals, the dm bell + @-mention seam) out of the container, registers GET /ws, and
 * returns the shared handles the chat HTTP routes also use (so the gateway, the threads UNION, and the
 * reaction/delete routes share the SAME repo instances). Extracted from chat.routes.ts to keep route
 * registration thin (the wiring is its own responsibility).
 *
 * The repo factories below are MEMOIZED per chat-plugin registration (mirroring di.ts getBlocksRepo/
 * getDmRepo) so a handler reuses one instance instead of constructing a fresh Drizzle repo per call. They
 * are built off the lazily-created DB handle (container.getDb()), so merely registering the plugin opens
 * no connection; in the all-fakes dev path (USE_FAKE_CHAT, no DB) the DB-backed seams are left undefined
 * and the notify/mention paths are no-ops (parity is moot without a store).
 */

import { ErrorCode } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
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
import { makeDrizzleChatRepository, type ChatRepository } from "../services/chat-repository.drizzle.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import { recordChatMentions } from "../services/chat-mentions.drizzle.js"
import { makeDrizzleChatReadState } from "../services/chat-read-state.drizzle.js"
import { makeNotificationService, type NotificationService } from "../services/notification-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { InMemoryChatPresence, RedisChatPresence, type ChatPresence } from "../adapters/chat-presence.js"
import { InMemoryChatReadState, type ChatReadState } from "../services/threads-service.js"
import { dmNotificationTitle, dmNotificationBody, mentionAuthorName, mentionBody } from "./chat-notify-copy.js"
import type { ChatGatewayOverrides } from "./chat.routes.js"

/** Per-IP upgrade rate limit on GET /ws: a reconnect storm otherwise exhausts sockets + per-handshake
 *  resolveSession DB hits. 60/min is ample for a real client's reconnect cadence. */
const WS_UPGRADE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

/**
 * The shared handles the chat HTTP routes need after the gateway is wired: the read-state store (also used
 * by the threads service for unread), the membership probe, the dm/blocks repos (container singletons), and
 * a memoized chat-repo factory for the reaction/delete routes.
 */
export interface ChatWiring {
  readState: ChatReadState
  isMember: IsMemberFn
  dmRepo: DmRepository
  blocksRepo: BlocksRepository
  isBlockedEitherWay: IsBlockedEitherWayFn
  /** peerOf for the dm reaction route (resolves the OTHER participant, or null). */
  dmPeerOf: (threadId: string, userId: string) => Promise<string | null>
  /** Memoized cleanup-chat repo (Drizzle in prod, injected in tests). */
  getChatRepo(): ChatRepository
  listDmThreadsFor: (userId: string, limit?: number) => Promise<Awaited<ReturnType<DmRepository["listThreadsForUser"]>>>
}

/**
 * Install a per-IP rate limit on the GET /ws upgrade. The gateway registers /ws inside registerChatGateway
 * (no route-config seam there), and route plugins mount unencapsulated on the root app, so we attach a
 * global onRequest hook that self-filters to the /ws path and runs a dedicated limiter (keyed on the same
 * normalized client IP as the global plugin). Skipped when @fastify/rate-limit isn't registered (offline
 * test/dev boots that don't install it).
 */
export function applyWsUpgradeRateLimit(app: FastifyInstance): void {
  if (typeof app.createRateLimit !== "function") return
  const limiter = app.createRateLimit({
    ...WS_UPGRADE_RATE_LIMIT,
    // Namespace the key so this 60/min /ws bucket is a SEPARATE counter from the global 300/min plugin
    // (which keys on the bare normalized IP) — otherwise both would increment the same key and collide.
    keyGenerator: (req) => `ws-upgrade:${normalizeIp(req.ip)}`,
  })
  app.addHook("onRequest", async (request, reply) => {
    if ((request.url ?? "").split("?")[0] !== "/ws") return
    const result = await limiter(request)
    // @fastify/rate-limit's createRateLimit result: `isAllowed` means "allowlist-EXEMPT" (true only for an
    // allowList bypass), NOT "within limit" — it is hardcoded false on the normal path. The over-the-limit
    // verdict is `isExceeded` (current > max). Block only when not exempt AND exceeded; checking `!isAllowed`
    // alone 429s EVERY upgrade (see the library README's `!isAllowed && isExceeded` example).
    if (!result.isAllowed && result.isExceeded) {
      reply.header("retry-after", result.ttlInSeconds)
      reply.status(429).send({ code: ErrorCode.RATE_LIMITED, message: "Too many connection attempts." })
    }
  })
}

export function wireChatGateway(app: FastifyInstance, container: Container): ChatWiring {
  const overrides: ChatGatewayOverrides | undefined = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT

  // One read-state instance backs both the gateway `ack` writes and the threads `unread` reads so they
  // agree. DB-backed in prod (survives restart / spans instances); process-local in the all-fakes path.
  const readState: ChatReadState =
    overrides?.readState ??
    (useFakeChat ? new InMemoryChatReadState() : makeDrizzleChatReadState(container.getDb().sql))

  // Redis-backed in prod (shared across workers, self-healing via the heartbeat); in-memory all-fakes.
  const presence: ChatPresence =
    overrides?.presence ??
    (useFakeChat ? new InMemoryChatPresence() : new RedisChatPresence(container.getRedis()))

  // Membership probe: cleanup membership == chat membership. Memoize the cleanup repo so the gateway,
  // threadRecipientsOf, and the mention seam reuse one instance.
  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  const getCleanupRepo = (): ReturnType<typeof makeDrizzleCleanupRepository> =>
    (cleanupRepo ??= makeDrizzleCleanupRepository(container.getDb().sql))
  const isMember: IsMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => getCleanupRepo().isMember(cleanupId, userId)

  const blocksRepo: BlocksRepository = overrides?.blocksRepo ?? container.getBlocksRepo()
  const dmRepo: DmRepository = overrides?.dmRepo ?? container.getDmRepo()
  const isBlockedEitherWay: IsBlockedEitherWayFn = (a, b) => blocksRepo.isBlockedEitherWay(a, b)

  // Media presigner for the reaction/soft-delete repos (so a recomputed/tombstoned message projects its
  // attachments). The gateway's send path gets its presigner from the DI container's chat service.
  const presignMedia = makeMediaPresigner(container.storage)

  // Memoized cleanup-chat repo for the HTTP reaction/delete routes; tests inject via overrides.chatRepo.
  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ?? (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, presignMedia))

  const dmPeerOf = async (threadId: string, userId: string): Promise<string | null> => {
    const t = await dmRepo.getThread(threadId)
    if (t === null) return null
    if (t.userLo === userId) return t.userHi
    if (t.userHi === userId) return t.userLo
    return null
  }

  // DM bell + cleanup/dm read-clears. Built locally (the per-request pattern social/notifications routes
  // use): DB-backed in prod, undefined in the all-fakes path (no DB to read prefs / insert rows). Tests inject.
  const notificationService: NotificationService | undefined =
    overrides?.notificationService ??
    (useFakeChat
      ? undefined
      : makeNotificationService({
          repo: makeDrizzleNotificationRepository(container.getDb().sql),
          pushSender: container.pushSender,
          userChannel: container.userChannel,
          logger: app.log,
        }))

  // Clear the reader's bell notifications for a conversation they just READ (ack) or OPENED (join). Shared
  // by the ack markRead wrappers and the markReadOnOpen hook. Best-effort: a clear failure must NEVER break
  // the read/ack/open path (the watermark is the source of truth).
  const clearConversationBell = async (kind: "dm" | "cleanup", id: string, userId: string): Promise<void> => {
    if (!notificationService) return
    try {
      if (kind === "dm") await notificationService.clearByTypeAndLink(userId, "dm", `/messages/dm/${id}`)
      else await notificationService.clearByTypeAndLink(userId, "cleanup_chat", `/cleanups/${id}`)
    } catch (err) {
      app.log.warn({ err, kind, id, userId }, "read: clear conversation notifications failed (suppressed)")
    }
  }

  const dmGatewayDeps: GatewayDmDeps = {
    isParticipant: (threadId, userId) => dmRepo.isParticipant(threadId, userId),
    peerOf: dmPeerOf,
    persist: (input) => dmRepo.persist(input),
    markRead: async (threadId, userId, upToId) => {
      // Anchor the watermark to the acked message's created_at (not now()), so a message that arrived in
      // the ack's debounce window stays unread. A foreign/unknown id falls back to now() for liveness.
      const at = (await dmRepo.resolveMessageCreatedAt(threadId, upToId)) ?? new Date()
      await dmRepo.markRead(threadId, userId, at)
      // Reading clears the reader's `dm` bell rows; the {topic:"threads"} self-signal is fired by the
      // gateway right after this awaited markRead so the inbox refetches the decremented count (#42).
      await clearConversationBell("dm", threadId, userId)
    },
  }

  // Resolve a cleanup `ack`'s read watermark: the acked message's created_at, scoped to the room.
  // PARTITION PRUNING: chat_messages is RANGE-partitioned per calendar month; without a created_at
  // predicate the planner probes the PK index in EVERY partition. An ack is always for a recently-received
  // message, so bound the search to the last 90 days; a stale/foreign id falls back to now() (the accepted
  // liveness-precision tradeoff). In the all-fakes path (no DB) we cannot resolve it, so use now().
  const resolveReadAt: (cleanupId: string, upToId: string) => Promise<Date> = useFakeChat
    ? () => Promise.resolve(new Date())
    : async (cleanupId, upToId) => {
        const rows = await container.getDb().sql<{ created_at: Date }[]>`
          SELECT created_at FROM chat_messages
          WHERE id = ${upToId} AND cleanup_id = ${cleanupId} AND created_at >= now() - interval '90 days'
          LIMIT 1
        `
        return rows[0]?.created_at ?? new Date()
      }

  // Thread-signal recipients for a freshly-persisted message (sender excluded). DM → the peer. Cleanup →
  // the room's members minus the sender, capped. No DB in the all-fakes path → cleanup yields none.
  const threadRecipientsOf: ThreadRecipientsOf = async (kind, id, senderId) => {
    if (kind === "dm") {
      const peer = await dmPeerOf(id, senderId)
      return peer !== null ? [peer] : []
    }
    if (useFakeChat) return []
    const members = await getCleanupRepo().listMemberIds(id, THREAD_SIGNAL_MEMBER_CAP)
    return members.filter((m) => m !== senderId)
  }

  // Chat @-mention seam: resolve a send frame's @handles + ids to room-eligible users, persist them, and
  // raise a per-user bell (block + room-eligibility gated). Wired only with a DB AND a notification service;
  // a no-op otherwise. Tests inject via overrides.chatMentions.
  const chatMentions: GatewayChatMentions | undefined =
    overrides?.chatMentions ??
    (useFakeChat || !notificationService
      ? undefined
      : {
          resolveChatMentions: async (input) => {
            const resolved = await resolveMentionTargets(container.getDb().sql, {
              handles: input.handles,
              userIds: input.userIds,
              authorUserId: input.authorUserId,
            })
            if (resolved.length === 0) return resolved
            // ROOM SCOPE: you can only @-tag someone IN this room — a cleanup MEMBER for the group chat, or
            // the PEER for a dm. A non-member handle resolves to a real user but is dropped here, so it is
            // never persisted / projected / notified (the rendered mention chip stays honest).
            if (input.kind === "dm") {
              const peer = await dmPeerOf(input.roomId, input.authorUserId)
              return peer !== null ? resolved.filter((m) => m.id === peer) : []
            }
            const memberIds = new Set(await getCleanupRepo().listMemberIds(input.roomId, THREAD_SIGNAL_MEMBER_CAP))
            return resolved.filter((m) => memberIds.has(m.id))
          },
          recordChatMentions: (messageId, mentionedUserIds) =>
            recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
          notifyChatMention: async (input) => {
            const { kind, roomId, actorUserId, mentionedUserId, message } = input
            // DM: skip the mention bell entirely — a 1:1 message IS a direct message to the only other
            // participant, and onDmDelivered already raises the (presence-suppressed) `type:"dm"` bell to
            // the same link; a second mention bell would duplicate it (same type+link, not de-duped).
            if (kind === "dm") return
            // ROOM ELIGIBILITY + BLOCK GATE + MENTIONS MUTE: only notify a cleanup member who hasn't blocked
            // (and isn't blocked by) the actor, and who has the dedicated `mentions` toggle on (the reused
            // cleanup_chat type can't be distinguished from a real chat bell inside the service). Remaining
            // pref/quiet-hours gates apply inside createNotification.
            if (!(await isMember(roomId, mentionedUserId))) return
            if (await blocksRepo.isBlockedEitherWay(actorUserId, mentionedUserId)) return
            if (!(await notificationService.getPrefs(mentionedUserId)).mentions) return
            await notificationService.createNotification(mentionedUserId, {
              type: "cleanup_chat",
              title: `${mentionAuthorName(message)} mentioned you`,
              body: mentionBody(message),
              link: `/cleanups/${roomId}`,
            })
          },
        })

  applyWsUpgradeRateLimit(app)

  registerChatGateway(app, {
    chat: container.chatService,
    isMember,
    sessions: app.authServices?.sessions,
    markRead: async (cleanupId, userId, upToId) => {
      const at = await resolveReadAt(cleanupId, upToId)
      await readState.markRead(cleanupId, userId, at)
      // Reading clears the reader's `cleanup_chat` bell rows; the {topic:"threads"} self-signal is fired by
      // the gateway right after this awaited markRead (#42). The gateway already membership-gated it.
      await clearConversationBell("cleanup", cleanupId, userId)
    },
    presence,
    dm: dmGatewayDeps,
    isBlockedEitherWay,
    userChannel: container.userChannel,
    threadRecipientsOf,
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
    // Mark-read-on-open (#42): on JOIN (open), advance the read watermark to NOW and clear the bell — the
    // backstop for a dropped client read-ack on a quick/cold open. dmRepo/readState markRead are monotonic,
    // so a redundant open is a harmless no-op.
    markReadOnOpen: async (kind, id, userId) => {
      const at = new Date()
      if (kind === "dm") {
        await dmRepo.markRead(id, userId, at)
        await clearConversationBell("dm", id, userId)
      } else if (kind === "cleanup") {
        await readState.markRead(id, userId, at)
        await clearConversationBell("cleanup", id, userId)
      }
    },
    chatMentions,
    // Anti-CSWSH: the gateway rejects a cross-site upgrade Origin not in the WEB_ORIGINS allowlist.
    webOrigins: container.env.WEB_ORIGINS,
  })

  return {
    readState,
    isMember,
    dmRepo,
    blocksRepo,
    isBlockedEitherWay,
    dmPeerOf,
    getChatRepo,
    listDmThreadsFor: (userId, limit) => dmRepo.listThreadsForUser(userId, limit),
  }
}
