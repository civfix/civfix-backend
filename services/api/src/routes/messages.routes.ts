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
 * mention bells) reuses the gateway's makeChatMentionResolver scope rules, gated off under fake-chat.
 */

import {
  AppError,
  EditMessageRequestSchema,
  ErrorCode,
  SetMessagePinnedRequestSchema,
  ToggleMessageReactionRequestSchema,
  type ChatMessageDTO,
} from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { makeChatEditService, type IsRoomMemberFn } from "../services/chat-edit-service.js"
import { makeDrizzleChatRepository, type ChatRepository } from "../services/chat-repository.drizzle.js"
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
import { CHAT_REACTION_FORBIDDEN } from "../services/chat-reaction-service.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import { resolveMentionTargets } from "../services/social-repository.drizzle.js"
import { recordChatMentions } from "../services/chat-mentions.drizzle.js"
import { makeChatMentionResolver } from "../services/chat-mention-resolver.js"
import type { GatewayChatMentions } from "../ws/types.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import { wireChatPowers } from "./chat-powers-wiring.js"

/**
 * Tighter per-key limit for edits (reaction-route style): a human edits a handful of messages; 30/min
 * bounds scripted rewrite sweeps while staying ample for normal use.
 */
export const EDIT_MESSAGE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

/** Unified reaction toggle: 60/min per key, matching the legacy per-room toggle routes. */
export const TOGGLE_REACTION_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerMessagesRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const overrides = app.chatOverrides
  const useFakeChat = container.env.USE_FAKE_CHAT

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

  let reportChatRepo: ReportChatRepository | undefined
  const getReportChatRepo = (): ReportChatRepository =>
    overrides?.reportChat ??
    (reportChatRepo ??= makeReportChatRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

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
      : (groupsRepo ??= makeChatGroupRepository(container.getDb().sql, makeMediaPresigner(container.storage)))
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

  const dmPeerOf = async (threadId: string, userId: string): Promise<string | null> => {
    const t = await dmRepo().getThread(threadId)
    if (t === null) return null
    if (t.userLo === userId) return t.userHi
    if (t.userHi === userId) return t.userLo
    return null
  }

  // Resolve + record ONLY (chat-edit-service never notifies — edits don't re-fire mention bells).
  // The scope rules (report mention-free, dm peer-only, cleanup members-only) are single-sourced in
  // makeChatMentionResolver, shared with the WS gateway wiring. Absent under fake-chat (no DB), where
  // the service skips re-recording.
  const chatMentions: Pick<GatewayChatMentions, "resolveChatMentions" | "recordChatMentions"> | undefined =
    overrides?.chatMentions ??
    (useFakeChat
      ? undefined
      : {
          resolveChatMentions: makeChatMentionResolver({
            resolveTargets: (input) => resolveMentionTargets(container.getDb().sql, input),
            dmPeerOf,
            listCleanupMemberIds: (cleanupId, cap) => getCleanupRepo().listMemberIds(cleanupId, cap),
            listReportChatMemberIds: (reportId) => getReportChatRepo().listMemberIds(reportId),
            listGroupMemberIds: (groupId) => getGroupsRepo()?.listMemberIds(groupId) ?? Promise.resolve([]),
          }),
          recordChatMentions: (messageId, mentionedUserIds) =>
            recordChatMentions(container.getDb().sql, messageId, mentionedUserIds),
        })

  route(
    app,
    "editChatMessage",
    { preHandler: csrfProtect, config: { rateLimit: EDIT_MESSAGE_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(EditMessageRequestSchema, request.body)

      const edits = makeChatEditService({
        chat: getChatRepo(),
        dm: dmRepo(),
        isCleanupMember,
        isReportMember: (reportId, uid) => getReportChatRepo().isMember(reportId, uid),
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

      // 1. Resolve the message by id in the correct table and verify its room ref matches roomId ->
      //    404 otherwise (also plain-missing). Soft-deleted rows resolve here so they can 422 below.
      let kind: string
      let deletedAt: Date | null
      if (roomKind === "dm") {
        const meta = await dmRepo().findMessageMeta(messageId)
        if (meta === null || meta.threadId !== roomId) throw AppError.notFound("Message not found")
        ;({ kind, deletedAt } = meta)
      } else {
        const meta = await getChatRepo().findMessageMeta(messageId)
        const roomMatches =
          meta !== null &&
          (roomKind === "report"
            ? meta.reportId === roomId
            : roomKind === "group"
              ? meta.groupId === roomId
              : meta.cleanupId === roomId)
        if (meta === null || !roomMatches) throw AppError.notFound("Message not found")
        ;({ kind, deletedAt } = meta)
      }

      // 2. Powers gate BEFORE the per-row state gates (mirrors the edit ladder's no-leak ordering: a
      //    caller without pin power learns nothing about a message's deleted-ness or kind).
      const powers = await resolveChatPowers({ roomKind, roomId, userId })
      if (!powers.canPin) {
        throw new AppError(ErrorCode.FORBIDDEN, "You can't pin messages in this chat.", {
          fields: { code: "pin_forbidden" },
        })
      }

      // 3. State gates: system rows and tombstones are never pinnable/unpinnable -> 422.
      if (kind === "system") throw AppError.validation({ messageId: "System messages can't be pinned." })
      if (deletedAt !== null) throw AppError.validation({ messageId: "This message was deleted." })

      // 4. The gated repo flip. IDEMPOTENT by design: pinning an already-pinned message (or unpinning an
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
  // room-agnostic (keyed on message id), so ONE toggle serves every kind; only the resolve + permission
  // steps dispatch. Ladder mirrors the edit route's no-leak ordering:
  //   1. resolve the message in the correct table + room-ref match -> 404;
  //   2. room-SEND permission (the SAME checks the edit ladder runs: cleanup/report/group member, dm
  //      peer + not blocked either way) -> generic 403 (CHAT_REACTION_FORBIDDEN);
  //   3. toggle + re-read the hydrated DTO (refreshed reaction summary, viewer-aware `mine*` bits);
  //   4. broadcast the LEGACY {type:"reaction"} frame — exactly what the per-room toggles fan out
  //      (cleanup omits roomKind; every other kind stamps it) so connected clients are agnostic to
  //      which route toggled.
  route(
    app,
    "toggleMessageReaction",
    { preHandler: csrfProtect, config: { rateLimit: TOGGLE_REACTION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ToggleMessageReactionRequestSchema, request.body)
      const { roomKind, roomId, messageId, emoji } = body

      let updated: ChatMessageDTO | null
      if (roomKind === "dm") {
        const meta = await dmRepo().findMessageMeta(messageId)
        if (meta === null || meta.threadId !== roomId) throw AppError.notFound("Message not found")
        const peer = await dmPeerOf(roomId, userId)
        if (peer === null) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
        if (await blocksRepo().isBlockedEitherWay(userId, peer)) {
          throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
        }
        // Tombstone gate (4.4 review, AFTER the permission check so it leaks nothing to outsiders):
        // the legacy per-room toggles 404 a deleted message BEFORE writing (their re-read filters
        // deleted_at); without this the room-agnostic toggle would insert an orphan reaction row.
        if (meta.deletedAt !== null) throw AppError.notFound("Message not found")
        await dmRepo().toggleReaction(messageId, userId, emoji)
        updated = await dmRepo().findMessage(roomId, messageId, userId)
      } else {
        const meta = await getChatRepo().findMessageMeta(messageId)
        const roomMatches =
          meta !== null &&
          (roomKind === "report"
            ? meta.reportId === roomId
            : roomKind === "group"
              ? meta.groupId === roomId
              : meta.cleanupId === roomId)
        if (meta === null || !roomMatches) throw AppError.notFound("Message not found")
        const allowed =
          roomKind === "report"
            ? await getReportChatRepo().isMember(roomId, userId)
            : roomKind === "group"
              ? await isGroupMember(roomId, userId)
              : await isCleanupMember(roomId, userId)
        if (!allowed) throw AppError.forbidden(CHAT_REACTION_FORBIDDEN)
        // Tombstone gate (4.4 review): 404 BEFORE the toggle so a reaction to a deleted message never
        // inserts an orphan chat_message_reactions row (legacy per-room toggle parity).
        if (meta.deletedAt !== null) throw AppError.notFound("Message not found")
        await getChatRepo().toggleReaction(messageId, userId, emoji)
        updated =
          roomKind === "report"
            ? await getChatRepo().findReportMessage(roomId, messageId, userId)
            : roomKind === "group"
              ? await getChatRepo().findGroupMessage(roomId, messageId, userId)
              : await getChatRepo().findMessage(roomId, messageId, userId)
      }
      // The gates above passed, so a null re-read is a lost race (row vanished underneath us).
      if (updated === null) throw AppError.notFound("Message not found")

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
}
