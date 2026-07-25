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
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"

const PostIdParamsSchema = z.object({ id: IdSchema }).strict()

/**
 * createPost was the only create in the app with NO route-level limit, so it sat at the global 300/min
 * while createReport (reports.routes.ts) and createCleanup (cleanups.routes.ts) both carry 20/min.
 *
 * PER-IP, ACROSS ALL USERS BEHIND IT — not per user. The route inherits the global `rateLimitKey`
 * (`ip:<ip>`), which plugins/rate-limit.ts documents must never be swapped for the caller's identity (that
 * would hand one host N x every budget for N accounts; identity is an ADDITIONAL dimension, counted by the
 * sensitive bucket, not a substitute). /v1/posts is not a sensitive prefix, so this IS the whole limit.
 *
 * Hence 120 and not the 20-30 the other creates use: this endpoint now also carries every THREAD REPLY, so
 * the realistic worst case is a whole cleanup crew replying in one event thread from a single venue Wi-Fi
 * or carrier CGNAT exit. At 30 the 31st reply in a minute 429s a user who has posted once, and in the
 * report flow the same shared bucket surfaces as "the feed post did not go out - rate limited" for someone
 * who filed exactly one report. 120/min is still 2.5x tighter than the global bucket it replaces, and far
 * above any single-author burst.
 */
const CREATE_POST_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const

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
