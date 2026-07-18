/**
 * P4 Task 4.3: the /groups HTTP surface — ALL NINE group endpoints from the shared registry.
 *
 *   POST   /groups                          [auth][csrf][10/hour]  create group/channel  -> ChatGroupDTO (201)
 *   GET    /groups/:id                      [auth]                 fetch one             -> ChatGroupDTO
 *   PATCH  /groups/:id                      [auth][csrf]           owner/admin update    -> ChatGroupDTO
 *   GET    /groups/:id/members              [auth]                 keyset member list    -> ListGroupMembersResponse
 *   POST   /groups/:id/members              [auth][csrf][30/min]   owner/admin add       -> refreshed first page
 *   DELETE /groups/:id/members/:userId      [auth][csrf]           remove / leave        -> {ok:true}
 *   PUT    /groups/:id/members/:userId/role [auth][csrf]           owner sets role       -> GroupMemberDTO
 *   GET    /groups/:id/messages             [auth]                 room history + pins   -> ChatHistoryResponse
 *   DELETE /groups/:id/messages/:messageId  [auth][csrf]           sender/moderator del  -> tombstone ChatMessageDTO
 *
 * The management gate ladder lives in chat-group-service.ts (see its role matrix); the two message
 * routes ride the unified chat rails: history via chat-repository's group_id scope (pins on the
 * INITIAL page only, like the cleanup/report/dm history routes), delete via softDeleteGroup with the
 * chat-powers resolver's group lane (owner/admin delete-others, sender self-delete) and the standard
 * {type:"message_update"} tombstone broadcast.
 *
 * Readability: members always; NON-members may read a PUBLIC group's surface (get / members /
 * history — the "viewable pre-join" contract on ChatGroupDTO.myRole); private groups 403 with
 * fields.code not_a_member. WS join/send for group rooms lands in Task 4.4 — until then the gateway
 * fails group frames closed (see ws/frame-handler authorizeRoom).
 *
 * Repo wiring mirrors messages.routes: injected chatOverrides fakes win (chatOverrides.groups /
 * chatRepo / blocksRepo / conversationMutes), else lazily-built Drizzle repos over the container's
 * sql tag — lazy so the offline route-coverage boot never touches getDb().
 */

import {
  AddGroupMembersRequestSchema,
  AppError,
  CreateChatGroupRequestSchema,
  GetChatGroupRequestSchema,
  GroupHistoryRequestSchema,
  IdSchema,
  ListGroupMembersRequestSchema,
  RemoveGroupMemberRequestSchema,
  SetGroupMemberRoleRequestSchema,
  UpdateChatGroupRequestSchema,
  type ChatHistoryResponse,
  type ChatMessageDTO,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import { broadcastMessageUpdate } from "../ws/gateway.js"
import { makeMediaPresigner } from "../services/media-presign.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeChatGroupService, type ChatGroupService } from "../services/chat-group-service.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { wireChatPowers } from "./chat-powers-wiring.js"

const GroupIdParamsSchema = z.object({ id: IdSchema }).strict()
const GroupMemberParamsSchema = z.object({ id: IdSchema, userId: IdSchema }).strict()
const GroupMessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

const GROUP_HISTORY_DEFAULT = 30
const GROUP_HISTORY_MAX = 50

/** Creating rooms is rare and deliberate; 10/hour bounds scripted room spam per user/IP key. */
export const CREATE_GROUP_RATE_LIMIT = { max: 10, timeWindow: "1 hour" } as const
/** Bulk invites: bounded so a hijacked session can't blast invite sweeps; ample for normal use. */
export const ADD_GROUP_MEMBERS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const

export async function registerChatGroupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const overrides = app.chatOverrides

  let groupsRepo: ChatGroupRepository | undefined
  const getGroups = (): ChatGroupRepository =>
    overrides?.groups ??
    (groupsRepo ??= makeChatGroupRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(container.getDb().sql, makeMediaPresigner(container.storage)))

  const getBlocks = (): BlocksRepository => overrides?.blocksRepo ?? container.getBlocksRepo()

  // Mute lookup for ChatGroupDTO.muted. When chatOverrides is present WITHOUT a mutes fake we must
  // not touch getDb() (offline harness) — fail open to muted:false, mirroring listThreads' stance.
  let mutesRepo: ConversationMutesRepository | undefined
  const getMutes = (): ConversationMutesRepository | undefined =>
    overrides
      ? overrides.conversationMutes
      : (mutesRepo ??= makeConversationMutesRepository(container.getDb().sql))

  const svc = (): ChatGroupService => {
    const mutes = getMutes()
    return makeChatGroupService({
      groups: getGroups(),
      isBlockedEitherWay: (a, b) => getBlocks().isBlockedEitherWay(a, b),
      ...(mutes ? { isMutedFor: (userId, groupId) => mutes.isMuted(userId, "group", groupId) } : {}),
    })
  }

  route(
    app,
    "createChatGroup",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_GROUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateChatGroupRequestSchema, request.body)
      const dto = await svc().createGroup(userId, body)
      reply.status(201).send(dto)
    },
  )

  route(app, "getChatGroup", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GetChatGroupRequestSchema, request.params)
    reply.status(200).send(await svc().getGroup(userId, id))
  })

  route(app, "updateChatGroup", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GroupIdParamsSchema, request.params)
    const body = parse(UpdateChatGroupRequestSchema, { ...(request.body as object), id })
    reply.status(200).send(await svc().updateGroup(userId, body))
  })

  route(app, "listGroupMembers", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GroupIdParamsSchema, request.params)
    const q = parse(ListGroupMembersRequestSchema, { ...(request.query as object), id })
    reply.status(200).send(await svc().listMembers(userId, q))
  })

  route(
    app,
    "addGroupMembers",
    { preHandler: csrfProtect, config: { rateLimit: ADD_GROUP_MEMBERS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(GroupIdParamsSchema, request.params)
      const body = parse(AddGroupMembersRequestSchema, { ...(request.body as object), id })
      reply.status(200).send(await svc().addMembers(userId, body))
    },
  )

  route(app, "removeGroupMember", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireAuth(request)
    const params = parse(GroupMemberParamsSchema, request.params)
    parse(RemoveGroupMemberRequestSchema, params)
    await svc().removeMember(actorId, params.id, params.userId)
    reply.status(200).send({ ok: true })
  })

  route(app, "setGroupMemberRole", { preHandler: csrfProtect }, async (request, reply) => {
    const actorId = requireAuth(request)
    const params = parse(GroupMemberParamsSchema, request.params)
    const body = parse(SetGroupMemberRoleRequestSchema, { ...(request.body as object), ...params })
    reply.status(200).send(await svc().setMemberRole(actorId, body.id, body.userId, body.role))
  })

  route(app, "groupMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GroupIdParamsSchema, request.params)
    const q = parse(GroupHistoryRequestSchema, { ...(request.query as object), id })
    // 404 unknown / 403 private non-member; a PUBLIC group's history is readable pre-join.
    await svc().requireReadable(userId, id)
    const limit = Math.min(Math.max(q.limit ?? GROUP_HISTORY_DEFAULT, 1), GROUP_HISTORY_MAX)
    // Pins ride ONLY the initial page (no before, no around) — same contract as the other rooms.
    const isInitialPage = q.before === undefined && q.around === undefined
    const [page, pins] = await Promise.all([
      getChatRepo().groupHistory(id, q.before, limit, userId, q.around),
      isInitialPage ? getChatRepo().listGroupPins(id, userId) : Promise.resolve(undefined),
    ])
    const payload: ChatHistoryResponse = {
      items: page.items,
      nextCursor: page.nextCursor,
      ...(page.prevCursor !== undefined ? { prevCursor: page.prevCursor } : {}),
      ...(pins !== undefined ? { pins } : {}),
    }
    reply.status(200).send(payload)
  })

  const resolveChatPowers = wireChatPowers(app, container)

  route(app, "deleteGroupMessage", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id, messageId } = parse(GroupMessageParamsSchema, request.params)
    // Membership pre-gate doubles as the room-existence check (a member row implies the group row).
    const role = await svc().requireReadable(userId, id)
    // Sender path first (sender-gated in the repo's WHERE) — members may always self-delete.
    let tombstone: ChatMessageDTO | null = null
    if (role !== null) {
      tombstone = await getChatRepo().softDeleteGroup(id, messageId, userId)
    }
    if (tombstone === null) {
      // Not the sender (or not a member): the chat-powers group lane decides (owner/admin only).
      const powers = await resolveChatPowers({ roomKind: "group", roomId: id, userId })
      if (!powers.canDeleteOthers) throw AppError.forbidden("You can't delete this message.")
      tombstone = await getChatRepo().softDeleteGroup(id, messageId, userId, { bypassSenderGate: true })
    }
    if (tombstone === null) throw AppError.forbidden("You can't delete this message.")
    broadcastMessageUpdate(container.chatService, "group", id, tombstone)
    reply.status(200).send(tombstone)
  })
}
