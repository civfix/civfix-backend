
import { HomeFeedQuerySchema, IdSchema, PaginationQuerySchema, PostComposeInputSchema } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perIdentity } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { NIL_VIEWER_ID } from "../services/post-repository.drizzle.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

const PostIdParamsSchema = z.object({ id: IdSchema }).strict()

export const CREATE_POST_RATE_LIMIT = perIdentity({ max: 120, timeWindow: "1 minute" })

export const POST_INTERACTION_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

export async function registerPostRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  const service = () => container.getPostService()

  route(
    app,
    "createPost",
    { preHandler: csrfProtect, config: { rateLimit: CREATE_POST_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const input = parse(PostComposeInputSchema, request.body)
      reply.status(201).send(await service().createPost(input, userId))
    },
  )

  route(app, "getPost", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().getPost(id, userId))
  })

  route(app, "deletePost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().deletePost(id, userId))
  })

  route(app, "listReplies", async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    const pagination = parse(PaginationQuerySchema, request.query)
    reply.status(200).send(await service().listReplies(id, userId, pagination))
  })

  route(app, "repostPost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().repostPost(id, userId))
  })

  route(app, "unrepostPost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unrepostPost(id, userId))
  })

  route(app, "likePost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().likePost(id, userId))
  })

  route(app, "unlikePost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unlikePost(id, userId))
  })

  route(app, "savePost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().savePost(id, userId))
  })

  route(app, "unsavePost", { preHandler: csrfProtect, config: { rateLimit: POST_INTERACTION_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unsavePost(id, userId))
  })

  route(app, "homeFeed", async (request, reply) => {
    const userId = request.auth.userId
    const query = parse(HomeFeedQuerySchema, request.query)
    reply
      .status(200)
      .send(userId ? await service().homeFeed(userId, query) : await service().publicFeed(query))
  })

  route(app, "listUserPosts", async (request, reply) => {
    const userId = request.auth.userId ?? NIL_VIEWER_ID
    const { id } = parse(PostIdParamsSchema, request.params)
    const pagination = parse(PaginationQuerySchema, request.query)
    reply.status(200).send(await service().listUserPosts(id, userId, pagination))
  })

  route(app, "listSaves", async (request, reply) => {
    const userId = requireAuth(request)
    const pagination = parse(PaginationQuerySchema, request.query)
    reply.status(200).send(await service().listSaves(userId, pagination))
  })
}
