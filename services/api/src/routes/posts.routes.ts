/**
 * Social-feed post routes. Registers the 13 post endpoints from the shared registry (createPost,
 * getPost, deletePost, listReplies, repostPost, unrepostPost, likePost, unlikePost, savePost,
 * unsavePost, homeFeed, listUserPosts, listSaves). All require auth (all users can post — no role gate,
 * like createReport / followPerson); mutations carry csrfProtect. The `:id` path param is validated
 * separately from the shared request schema (which is `PaginationQuerySchema` / `null`), matching how
 * report-chat / social routes wire `:id` from params + pagination from query.
 *
 * Modeled on social.routes.ts / reports.routes.ts.
 */

import { HomeFeedQuerySchema, IdSchema, PaginationQuerySchema, PostComposeInputSchema } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { csrfProtect } from "../auth/csrf.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

const PostIdParamsSchema = z.object({ id: IdSchema }).strict()

export async function registerPostRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const service = () => container.getPostService()

  route(app, "createPost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const input = parse(PostComposeInputSchema, request.body)
    reply.status(201).send(await service().createPost(input, userId))
  })

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

  route(app, "repostPost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().repostPost(id, userId))
  })

  route(app, "unrepostPost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unrepostPost(id, userId))
  })

  route(app, "likePost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().likePost(id, userId))
  })

  route(app, "unlikePost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unlikePost(id, userId))
  })

  route(app, "savePost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().savePost(id, userId))
  })

  route(app, "unsavePost", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(PostIdParamsSchema, request.params)
    reply.status(200).send(await service().unsavePost(id, userId))
  })

  // OPTIONAL auth: a signed-in reader gets their followed+self timeline; a signed-out reader gets the
  // public/global feed (you shouldn't have to sign in to read a feed). Writes still require auth below.
  route(app, "homeFeed", async (request, reply) => {
    const userId = request.auth.userId
    const query = parse(HomeFeedQuerySchema, request.query)
    reply
      .status(200)
      .send(userId ? await service().homeFeed(userId, query) : await service().publicFeed(query))
  })

  route(app, "listUserPosts", async (request, reply) => {
    const userId = requireAuth(request)
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
