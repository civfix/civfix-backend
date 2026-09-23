// NON-members may read a PUBLIC group's surface (get, members, history: the "viewable pre-join"
// contract on ChatGroupDTO.myRole); a private group answers 403 not_a_member. Repos are built lazily
// so the offline route-coverage boot never touches getDb().

import {
  AddGroupMembersRequestSchema,
  CreateChatGroupRequestSchema,
  GetChatGroupRequestSchema,
  GroupHistoryRequestSchema,
  IdSchema,
  ListGroupMembersRequestSchema,
  RemoveGroupMemberRequestSchema,
  SetGroupMemberRoleRequestSchema,
  UpdateChatGroupRequestSchema,
  type ChatHistoryResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse, trimTextFields } from "./_validate.js"
import { route } from "../versioning/route.js"
import {
  chatHistoryPayload,
  clampChatHistoryLimit,
  deleteMessageWithPowers,
} from "./chat-route-helpers.js"
import { makePrivateMediaPresigner } from "../services/media-presign.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeChatGroupService, type ChatGroupService } from "../services/chat-group-service.js"
import { nudgeThreads } from "../services/threads-nudge.js"
import {
  makeDrizzleChatRepository,
  type ChatRepository,
} from "../services/chat-repository.drizzle.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import { wireChatPowers } from "./chat-powers-wiring.js"

export const CreateChatGroupBodySchema = trimTextFields(
  CreateChatGroupRequestSchema,
  "name",
  "description",
)
export const UpdateChatGroupBodySchema = trimTextFields(
  UpdateChatGroupRequestSchema,
  "name",
  "description",
)

const GroupIdParamsSchema = z.object({ id: IdSchema }).strict()
const GroupMemberParamsSchema = z.object({ id: IdSchema, userId: IdSchema }).strict()
const GroupMessageParamsSchema = z.object({ id: IdSchema, messageId: IdSchema }).strict()

/** Creating rooms is rare and deliberate; 10/hour bounds scripted room spam per user/IP key. */
export const CREATE_GROUP_RATE_LIMIT = perIdentity({ max: 10, timeWindow: "1 hour" })
/** Bulk invites: bounded so a hijacked session can't blast invite sweeps; ample for normal use. */
export const ADD_GROUP_MEMBERS_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })
/** 20/min bounds scripted join sweeps across public rooms; ample for a real user. */
export const JOIN_GROUP_RATE_LIMIT = perIdentity({ max: 20, timeWindow: "1 minute" })
/**
 * Each of these is a moderation action a human performs a handful of times per session, so 30/min is
 * generous while bounding a hijacked session's ability to churn a room's name, roster or roles or
 * sweep its history.
 */
export const GROUP_MODERATION_RATE_LIMIT = perIdentity({ max: 30, timeWindow: "1 minute" })

export async function registerChatGroupRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  const overrides = app.chatOverrides

  let groupsRepo: ChatGroupRepository | undefined
  const getGroups = (): ChatGroupRepository =>
    overrides?.groups ??
    (groupsRepo ??= makeChatGroupRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  let chatRepo: ChatRepository | undefined
  const getChatRepo = (): ChatRepository =>
    overrides?.chatRepo ??
    (chatRepo ??= makeDrizzleChatRepository(
      container.getDb().sql,
      makePrivateMediaPresigner(container.storage),
    ))

  // With chatOverrides present but no mutes fake, getDb() must not be touched (offline harness), so
  // ChatGroupDTO.muted fails open to false, as listThreads does.
  let mutesRepo: ConversationMutesRepository | undefined
  const getMutes = (): ConversationMutesRepository | undefined =>
    overrides
      ? overrides.conversationMutes
      : (mutesRepo ??= makeConversationMutesRepository(container.getDb().sql))

  const svc = (): ChatGroupService => {
    const mutes = getMutes()
    return makeChatGroupService({
      groups: getGroups(),
      ...(overrides?.groups ? {} : { affiliations: container.getAffiliationLoader() }),
      ...(mutes
        ? { isMutedFor: (userId, groupId) => mutes.isMuted(userId, "group", groupId) }
        : {}),
    })
  }

  route(
    app,
    "createChatGroup",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_GROUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(CreateChatGroupBodySchema, request.body)
      const dto = await svc().createGroup(userId, body)
      reply.status(201).send(dto)
    },
  )

  route(app, "getChatGroup", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GetChatGroupRequestSchema, request.params)
    reply.status(200).send(await svc().getGroup(userId, id))
  })

  route(
    app,
    "updateChatGroup",
    { preHandler: csrfProtect, config: { rateLimit: GROUP_MODERATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(GroupIdParamsSchema, request.params)
      const body = parse(UpdateChatGroupBodySchema, { ...(request.body as object), id })
      reply.status(200).send(await svc().updateGroup(userId, body))
    },
  )

  route(
    app,
    "joinChatGroup",
    { preHandler: csrfProtect, config: { rateLimit: JOIN_GROUP_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(GetChatGroupRequestSchema, request.params)
      const dto = await svc().joinGroup(userId, id)
      nudgeThreads(container.userChannel, userId)
      reply.status(200).send(dto)
    },
  )

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
      const { page, added } = await svc().addMembers(userId, body)
      // `added`, not the returned page, decides who is nudged: an invitee the block filter dropped must
      // learn nothing, and in a group at or over GROUP_MEMBERS_DEFAULT_LIMIT members a fresh member sorts
      // past page one, so a page-derived set skips exactly the big rooms.
      for (const memberId of added) nudgeThreads(container.userChannel, memberId)
      reply.status(200).send(page)
    },
  )

  route(
    app,
    "removeGroupMember",
    { preHandler: csrfProtect, config: { rateLimit: GROUP_MODERATION_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const params = parse(GroupMemberParamsSchema, request.params)
      parse(RemoveGroupMemberRequestSchema, params)
      await svc().removeMember(actorId, params.id, params.userId)
      reply.status(200).send({ ok: true })
    },
  )

  route(
    app,
    "setGroupMemberRole",
    { preHandler: csrfProtect, config: { rateLimit: GROUP_MODERATION_RATE_LIMIT } },
    async (request, reply) => {
      const actorId = requireAuth(request)
      const params = parse(GroupMemberParamsSchema, request.params)
      const body = parse(SetGroupMemberRoleRequestSchema, {
        ...(request.body as object),
        ...params,
      })
      reply.status(200).send(await svc().setMemberRole(actorId, body.id, body.userId, body.role))
    },
  )

  route(app, "groupMessages", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(GroupIdParamsSchema, request.params)
    const q = parse(GroupHistoryRequestSchema, { ...(request.query as object), id })
    await svc().requireReadable(userId, id)
    const limit = clampChatHistoryLimit(q.limit)
    const payload: ChatHistoryResponse = await chatHistoryPayload(
      {
        history: (before, pageLimit, around) =>
          getChatRepo().groupHistory(id, before, pageLimit, userId, around),
        listPins: () => getChatRepo().listGroupPins(id, userId),
      },
      q,
      limit,
    )
    reply.status(200).send(payload)
  })

  const resolveChatPowers = wireChatPowers(app, container)

  route(
    app,
    "deleteGroupMessage",
    { preHandler: csrfProtect, config: { rateLimit: GROUP_MODERATION_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id, messageId } = parse(GroupMessageParamsSchema, request.params)
      // A public group's non-member (role null) still reaches the powers ladder, where the owner/admin
      // delete-others power decides.
      const role = await svc().requireReadable(userId, id)
      const chatRepo = getChatRepo()
      const tombstone = await deleteMessageWithPowers({
        roomKind: "group",
        roomId: id,
        messageId,
        userId,
        senderPath: role !== null,
        softDelete: (opts) => chatRepo.softDeleteGroup(id, messageId, userId, opts),
        findMessageMeta: (mid) => chatRepo.findMessageMeta(mid),
        resolveChatPowers,
        chat: container.chatService,
        // Group rooms never emitted the legacy {type:"message"} frame, and one here would re-insert the
        // deleted bubble on clients that upsert by id.
        legacyBroadcast: false,
      })
      reply.status(200).send(tombstone)
    },
  )
}
