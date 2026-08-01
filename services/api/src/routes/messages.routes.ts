/**
 * Unified message route plugin (P0 Task 0.3).
 *
 *   PATCH /messages   [auth][csrf][rate-limit 30/min]  edit ANY room kind's message (cleanup, report,
 *                     dm) through the single roomKind-dispatching chat-edit-service. The body carries
 *                     {roomKind, roomId, messageId, body, mentionedUserIds?}; the full gate ladder
 *                     (room-ref 404, membership/peer 403, not_sender 403, deleted 409, kind 422,
 *                     edit-window 403, slur filter) plus the {type:"message_update"} broadcast live in
 *                     the service. This is the ONE client path going forward — 'dm' is accepted here
 *                     too (the legacy PATCH /dm/:threadId/messages/:messageId stays mounted for
 *                     pre-P0 clients and delegates to the same service).
 *
 * Repo wiring mirrors report-chat.routes / chat-gateway-wiring: injected chatOverrides fakes win, else
 * lazily-built Drizzle repos over the container's sql tag (lazy so the offline route-coverage boot
 * never touches getDb()). The optional mention seam (resolve + record, NO notify — edits never re-fire
 * mention bells) comes from chat-gateway-wiring's memoized chatMentionDeps, so the mention SCOPE RULES
 * have one source shared with the WS lane; gated off under fake-chat.
 *
 * The per-room gate ladders are the SERVICES' (chat-edit-service, chat-reaction-service,
 * chat-poll-service): every route below wires their deps — including the optional report-VISIBILITY dep,
 * which is inert unless passed — and keeps only the parts a service has no opinion on (legacy broadcast
 * frames, the pin route's own ladder).
 */

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
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  canPostToGroup,
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeChatReactionService } from "../services/chat-reaction-service.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"
import { makeDmPeerOf } from "../services/dm-peer.js"
import { messageRoomMatches } from "./chat-route-helpers.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import { chatMentionDeps, type ChatMentionSeam } from "./chat-gateway-wiring.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
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

/**
 * Tighter per-key limit for edits (reaction-route style): a human edits a handful of messages; 30/min
 * bounds scripted rewrite sweeps while staying ample for normal use.
 */
export const EDIT_MESSAGE_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

/** Unified reaction toggle: 60/min per key, matching the legacy per-room toggle routes. */
export const TOGGLE_REACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

/** Poll create (P6): 10/min per key — a poll is a deliberate, heavier action than a chat send. */
export const CREATE_POLL_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 minute" })

/** Poll vote (P6): 60/min per key — voting/retracting is lightweight and interactive. */
export const VOTE_POLL_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

/** Poll close (P6): 30/min per key — a rare author/moderator action. */
export const CLOSE_POLL_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export async function registerMessagesRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

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
    overrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  let cleanupRepo: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  const getCleanupRepo = (): ReturnType<typeof makeDrizzleCleanupRepository> =>
    (cleanupRepo ??= makeDrizzleCleanupRepository(container.getDb().sql))
  const isCleanupMember: IsRoomMemberFn = overrides
    ? overrides.isMember
    : (cleanupId, userId) => getCleanupRepo().isMember(cleanupId, userId)

  // P4 4.4 group lane. Same override stance as the mutes/report repos: when chatOverrides is present
  // WITHOUT a groups fake we must not touch getDb() (offline harness) — group membership then fails
  // closed, mirroring the WS gateway's unwired-group behavior.
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
  // P5 send-permission (edit lane): member AND post power — a channel's read-only members can't edit
  // (belt-and-braces: they can't have authored posts, but the gate must 403 the SAME as WS send). For a
  // regular 'group' this collapses to membership, so non-channel behavior is unchanged. Reactions
  // deliberately keep `isGroupMember` (a joined read-only channel member CAN react; a public non-member can't).
  const canSendGroup: IsRoomMemberFn = async (groupId, userId) => {
    const repo = getGroupsRepo()
    if (!repo) return false
    const access = await repo.accessOf(groupId, userId)
    return access !== null && canPostToGroup(access)
  }

  const dmRepo = (): DmRepository => overrides?.dmRepo ?? container.getDmRepo()
  const blocksRepo = (): BlocksRepository => overrides?.blocksRepo ?? container.getBlocksRepo()

  const dmPeerOf = makeDmPeerOf({ getThread: (threadId) => dmRepo().getThread(threadId) })

  // Report-lane VISIBILITY, the gate report-chat.routes' requireVisibleReport and the WS authorizeRoom
  // lane already apply: a report room only exists while its report is visible to the caller, so a
  // moderation-held / unlisted / deleted report must not stay reactable, editable, pinnable or pollable
  // by the members it had. Seam stance mirrors the repos above: an injected reportVisible or discussion
  // repo wins; a chatOverrides harness carrying NEITHER has no report to read and skips the check (as
  // listThreads skips its absent report half); production always builds the real lookup, lazily.
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

  /** 404 (never 403) for a report the caller can't see — byte-identical to report-chat.routes. */
  const requireVisibleReport = async (reportId: string, userId: string): Promise<void> => {
    if (!(await isReportVisible(reportId, userId))) throw AppError.notFound("Report not found")
  }

  // Resolve + record ONLY (chat-edit-service never notifies — edits don't re-fire mention bells). The
  // scope rules (report chat-members-only, dm peer-only, cleanup/group members-only) live in the memoized
  // seam this shares with the WS gateway lane. Absent under fake-chat (no DB), where the service skips
  // re-recording.
  const chatMentions: ChatMentionSeam | undefined =
    overrides?.chatMentions ?? (useFakeChat ? undefined : chatMentionDeps(app, container))

  route(
    app,
    "editChatMessage",
    { preHandler: csrfProtect, config: { rateLimit: EDIT_MESSAGE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(EditMessageBodySchema, request.body)
      // Before the service's own ladder: the report must still be visible (the service gates on
      // report-chat membership alone).
      if (body.roomKind === "report") await requireVisibleReport(body.roomId, userId)

      const edits = makeChatEditService({
        chat: getChatRepo(),
        dm: dmRepo(),
        isCleanupMember,
        isReportMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
        // Same gate as the pre-check above, wired IN so the service no longer depends on a caller having
        // run it (it gates report edits on membership alone otherwise, and a membership row outlives the
        // report going held/unlisted). Runs ahead of the membership check, so the 404 still wins.
        isReportVisible,
        // Edit reuses the SEND-permission gate (channels: owner/admin only), not bare membership.
        isGroupMember: canSendGroup,
        dmPeerOf,
        isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
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

  // P3 Task 3.4: PUT /messages/pin — pin/unpin a message in its room. The chat-powers resolver
  // (chat-room-roles.ts) is the ONLY authorization: dm participants, cleanup organizers, report owners,
  // and operators-in-report-rooms may pin. Deliberately NO membership pre-gate — operator powers in
  // report rooms apply WITHOUT a membership row.
  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "setMessagePinned",
    { preHandler: csrfProtect, config: { rateLimit: EDIT_MESSAGE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(SetMessagePinnedRequestSchema, request.body)
      const { roomKind, roomId, messageId, pinned } = body

      // 1. A report room whose report is no longer visible to the caller is gone (404), exactly as it is
      //    for that room's history/react/delete routes — checked before anything is resolved.
      if (roomKind === "report") await requireVisibleReport(roomId, userId)

      // 2. Powers gate BEFORE the message is resolved — the same ordering the unified reaction service
      //    settled on. Resolving first made this an EXISTENCE ORACLE: a caller with no pin power in a
      //    private room could tell a real message id from an unknown one by the 404-vs-403 it got back.
      //    Now the 403 comes first and only someone who may pin there ever sees a 404. (No membership
      //    pre-gate: operator powers in report rooms apply WITHOUT a membership row.)
      const powers = await resolveChatPowers({ roomKind, roomId, userId })
      if (!powers.canPin) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't pin messages in this chat.", {
          fields: { code: "pin_forbidden" },
        })
      }

      // 3. Resolve the message by id in the correct table and verify its room ref matches roomId ->
      //    404 otherwise (also plain-missing). Soft-deleted rows resolve here so they can 422 below.
      let kind: string
      let deletedAt: Date | null
      if (roomKind === "dm") {
        const meta = await dmRepo().findMessageMeta(messageId)
        if (meta === null || meta.threadId !== roomId) throw AppError.notFound("Message not found")
        ;({ kind, deletedAt } = meta)
      } else {
        const meta = await getChatRepo().findMessageMeta(messageId)
        if (!messageRoomMatches(meta, roomKind, roomId)) {
          throw AppError.notFound("Message not found")
        }
        ;({ kind, deletedAt } = meta)
      }

      // 4. State gates: system rows and tombstones are never pinnable/unpinnable -> 422.
      if (kind === "system")
        throw AppError.validation({ messageId: "System messages can't be pinned." })
      if (deletedAt !== null) throw AppError.validation({ messageId: "This message was deleted." })

      // 5. The gated repo flip. IDEMPOTENT by design: pinning an already-pinned message (or unpinning an
      //    unpinned one) is a no-op that returns the CURRENT DTO — pinned_at is never refreshed by a
      //    repeat pin. A null here is a lost race (deleted underneath us) -> same 422 as the gate above.
      const updated: ChatMessageDTO | null =
        roomKind === "dm"
          ? await dmRepo().setPinned(roomId, messageId, userId, pinned)
          : roomKind === "report"
            ? await getChatRepo().setReportPinned(roomId, messageId, userId, pinned)
            : roomKind === "group"
              ? await getChatRepo().setGroupPinned(roomId, messageId, userId, pinned)
              : await getChatRepo().setPinned(roomId, messageId, userId, pinned)
      if (updated === null) throw AppError.validation({ messageId: "This message was deleted." })

      // Realtime: the SAME {type:"message_update"} frame the edit/delete paths use — clients reconcile
      // the bubble (and their pin rail) from message.pinnedAt. Best-effort fire-and-forget.
      broadcastMessageUpdate(container.chatService, roomKind, roomId, updated)

      reply.status(200).send(updated)
    },
  )

  // P4 Task 4.4: POST /messages/reactions — the unified roomKind-scoped reaction toggle. Group rooms
  // are the driver (they have no per-room reaction route); cleanup/report/dm get the unified path for
  // free (their legacy per-room toggles stay mounted for pre-P4 clients). chat_message_reactions is
  // room-agnostic (keyed on message id), so ONE toggle serves every kind.
  //
  // The whole ladder — authorize, resolve, tombstone-gate, toggle, re-read — lives in
  // chat-reaction-service, which the legacy per-room routes bind onto too, so the gates exist ONCE. This
  // route inlined its own copy of them, and the copy resolved the message BEFORE authorizing: an
  // existence oracle for a private room (404 for unknown vs 403 for known). The service authorizes first,
  // so a non-member now gets 403 for BOTH; the tombstone 404 only reaches someone allowed to react there.
  //
  // The route keeps one job the service has no opinion on: broadcasting the LEGACY {type:"reaction"}
  // frame — exactly what the per-room toggles fan out (cleanup omits roomKind; every other kind stamps
  // it) so connected clients are agnostic to which route toggled.
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
        // MEMBERSHIP, not send permission: a joined read-only channel member MAY react (the same product
        // stance as poll voting), so this is isGroupMember and deliberately NOT canSendGroup.
        isChatGroupMember: isGroupMember,
        dmPeerOf,
        isBlockedEitherWay: (a, b) => blocksRepo().isBlockedEitherWay(a, b),
        // Report VISIBILITY runs inside the service, ahead of the membership gate — the 404 the route
        // used to raise itself via requireVisibleReport, now in the one place every reaction lane shares.
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
        message: updated,
      }
      void Promise.resolve(
        container.chatService.broadcastEvent?.(roomKeyFor(roomKind, roomId), frame),
      ).catch(() => {})

      reply.status(200).send(updated)
    },
  )

  // P6 Tasks 6.3/6.4: poll create / vote / close. The poll repo owns the DB writes; the poll service
  // orchestrates the gate ladder + re-reads the hydrated DTO through the SHARED chat repo (which now
  // attaches the poll payload) + broadcasts. Lazily built over the container sql (offline harnesses with
  // chatOverrides but no groups/DB seam fail the group lane closed, mirroring the reaction lane).
  let pollService: ReturnType<typeof makeChatPollService> | undefined
  const pollNotifier = makeContainerPollNotifier(container, app.log)
  // The report lane's VISIBILITY gate is the poll service's own (requireVisibleRoom runs ahead of every
  // create/vote/close gate and 404s exactly like report-chat.routes' requireVisibleReport) — but it is
  // INERT unless wired, which is why it is passed below. Folding it into the membership booleans instead
  // (the shape this replaced) turned a held/unlisted report into a 403 rather than the room's 404.
  const isReportChatMember = (roomId: string, userId: string): Promise<boolean> =>
    getReportChatRepo().isMember(roomId, userId)
  const getPollService = (): ReturnType<typeof makeChatPollService> =>
    (pollService ??= makeChatPollService({
      chat: getChatRepo(),
      chatPolls: overrides?.chatPolls ?? makeChatPollRepository(container.getDb().sql),
      isReportVisible,
      // SEND permission (create): cleanup/report member, group member+canPost (channel owner/admin only).
      canSend: (roomKind, roomId, userId) =>
        roomKind === "report"
          ? isReportChatMember(roomId, userId)
          : roomKind === "group"
            ? canSendGroup(roomId, userId)
            : isCleanupMember(roomId, userId),
      // MEMBERSHIP (vote): bare member incl. a channel's read-only readers; a public non-member is false.
      isMember: (roomKind, roomId, userId) =>
        roomKind === "report"
          ? isReportChatMember(roomId, userId)
          : roomKind === "group"
            ? isGroupMember(roomId, userId)
            : isCleanupMember(roomId, userId),
      // Room moderator (close fallback) via the shared chat-powers resolver.
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
