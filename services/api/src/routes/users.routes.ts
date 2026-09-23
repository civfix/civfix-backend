import {
  SearchUsersRequestSchema,
  MentionSearchRequestSchema,
  UpdateSettingsRequestSchema,
  DeleteAccountRequestSchema,
  PaginationQuerySchema,
  IdSchema,
  AppError,
  type SearchUsersResponse,
  type BlockUserResponse,
  type ListBlocksResponse,
  type UpdateSettingsResponse,
  type DeleteAccountResponse,
  type RequestDataExportResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { isOfficialAccount } from "../auth/official-account.js"
import { clearCsrfCookie } from "../auth/csrf.js"
import { clearSessionCookie } from "../auth/transport.js"
import { searchByHandlePrefix, searchMentionable } from "../services/social-repository.drizzle.js"
import { toUserDTO } from "../auth/auth-services.js"
import { writeAudit } from "../services/admin/audit.js"
import { DATA_EXPORT_JOB, dataExportSupportEmail } from "../services/data-export-jobs.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { dropContainerSuggestions } from "../services/social-suggestions-wiring.js"
import { route } from "../versioning/route.js"
import { perIdentity } from "../plugins/rate-limit.js"
import { parse, trimTextFields } from "./_validate.js"
import { SUPPORTED_LOCALES } from "../i18n/locales.js"

export const DATA_EXPORT_RATE_LIMIT = perIdentity({ max: 5, timeWindow: "1 hour" })

export const LIST_BLOCKS_RATE_LIMIT = perIdentity({ max: 60, timeWindow: "1 minute" })

const UserIdParamsSchema = z.object({ id: IdSchema }).strict()

export const MentionSearchQuerySchema = trimTextFields(MentionSearchRequestSchema, "q")

const SettingsLocaleSchema = z
  .object({
    locale: z.enum([...SUPPORTED_LOCALES] as [string, ...string[]]).optional(),
  })
  .passthrough()

const USER_SEARCH_DEFAULT_LIMIT = 10

const USER_SEARCH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const
export const BLOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export const UNBLOCKABLE_MESSAGE = "User not found"

export async function registerUsersRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  const csrfProtect = container.csrf.protect

  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  route(
    app,
    "searchUsers",
    { config: { rateLimit: USER_SEARCH_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(SearchUsersRequestSchema, request.query)
      const term = q.q.startsWith("@") ? q.q.slice(1) : q.q
      const limit = q.limit ?? USER_SEARCH_DEFAULT_LIMIT
      const results =
        term.length === 0
          ? []
          : await searchByHandlePrefix(container.getDb().sql, term, userId, limit)
      const payload: SearchUsersResponse = { results }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "mentionSearch",
    { config: { rateLimit: USER_SEARCH_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(MentionSearchQuerySchema, request.query)
      const term = q.q.startsWith("@") ? q.q.slice(1) : q.q
      const results =
        term.length === 0
          ? []
          : await searchMentionable(container.getDb().sql, term, userId, USER_SEARCH_DEFAULT_LIMIT)
      const payload: SearchUsersResponse = { results }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "blockUser",
    { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(UserIdParamsSchema, request.params)
      if (id === userId) throw AppError.validation({ id: "You cannot block yourself." })
      if (isOfficialAccount(id)) {
        throw AppError.forbidden("The official CivFix account can't be blocked.")
      }
      const blocks = blocksRepo()
      await assertUserBlockable(app, blocks, userId, id)
      await blocks.block(userId, id)
      await dropContainerSuggestions(container, [userId, id], request.log)
      const payload: BlockUserResponse = { blocked: true }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "unblockUser",
    { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const { id } = parse(UserIdParamsSchema, request.params)
      await blocksRepo().unblock(userId, id)
      await dropContainerSuggestions(container, [userId, id], request.log)
      const payload: BlockUserResponse = { blocked: false }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "listBlocks",
    { config: { rateLimit: LIST_BLOCKS_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const pagination = parse(PaginationQuerySchema, request.query)
      const page = await blocksRepo().listBlocked(userId, {
        cursor: pagination.cursor ?? null,
        ...(pagination.limit !== undefined ? { limit: pagination.limit } : {}),
      })
      const payload: ListBlocksResponse = {
        blocked: page.blocked,
        ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      }
      reply.status(200).send(payload)
    },
  )

  route(app, "updateSettings", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateSettingsRequestSchema, request.body)
    const locale = parse(SettingsLocaleSchema, request.body).locale
    const store = app.authServices?.users
    if (!store) throw AppError.unauthorized("Authentication required.")
    const patch = {
      ...(body.allowDirectMessages !== undefined
        ? { allowDirectMessages: body.allowDirectMessages }
        : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(body.showVolunteerHours !== undefined
        ? { showVolunteerHours: body.showVolunteerHours }
        : {}),
      ...(body.primaryOrganizationId !== undefined
        ? { primaryOrganizationId: body.primaryOrganizationId }
        : {}),
    }
    const updated =
      Object.keys(patch).length === 0
        ? await store.findById(userId)
        : await store.updateSettings(userId, patch)
    if (!updated) throw AppError.unauthorized("Authentication required.")
    const payload: UpdateSettingsResponse = { user: toUserDTO(updated) }
    reply.status(200).send(payload)
  })

  route(
    app,
    "deleteAccount",
    { preHandler: csrfProtect, config: { allowSuspended: true } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const store = app.authServices?.users
      const sessions = app.authServices?.sessions
      const otp = app.authServices?.otp
      const oauth = app.authServices?.oauth
      if (!store || !sessions || !otp || !oauth) {
        throw AppError.unauthorized("Authentication required.")
      }

      const { emailOtp } = parse(DeleteAccountRequestSchema, request.body)
      const me = await store.findById(userId)
      const email = me?.email ?? null
      if (email) {
        const verifiedUserId = await otp.verifyOtp(email, emailOtp, request.ip || null)
        if (verifiedUserId !== userId) {
          throw AppError.unauthorized("That code could not be verified for this account.")
        }
      }

      // The erasure transaction also deletes the durable sessions, push tokens and notifications. The
      // steps below run after it commits: the ban marker and epoch bump retire cached session projections,
      // and a failure is logged rather than failing a deletion that already happened.
      await store.softDeleteAndAnonymize(userId)

      clearSessionCookie(reply)
      clearCsrfCookie(reply)
      const cleanups: ReadonlyArray<readonly [step: string, run: () => Promise<unknown>]> = [
        ["sessions.ban", () => sessions.banUser(userId)],
        ["oauth.unlink", () => oauth.unlinkAllForUser(userId)],
        [
          "audit.account-deleted",
          () =>
            writeAudit(container.getDb().sql, {
              actorId: userId,
              action: "account.deleted",
              target: `user:${userId}`,
            }),
        ],
      ]
      const outcomes = await Promise.allSettled(cleanups.map(async ([, run]) => run()))
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "rejected") {
          request.log.error(
            { err: outcome.reason, userId, step: cleanups[i]![0] },
            "account deletion: post-revocation cleanup step failed (the account IS deleted and every session revoked)",
          )
        }
      })
      const payload: DeleteAccountResponse = { ok: true }
      reply.status(200).send(payload)
    },
  )

  route(
    app,
    "requestDataExport",
    { preHandler: csrfProtect, config: { rateLimit: DATA_EXPORT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const store = app.authServices?.users
      if (!store) throw AppError.unauthorized("Authentication required.")
      const me = await store.findById(userId)
      const email = me?.email ?? null
      if (email === null) {
        const support = dataExportSupportEmail(container.env)
        throw AppError.validation(
          { email: "Your account has no email address on file to deliver the export to." },
          "We can't email your data export because your account has no email address on file. " +
            `To request a copy of your data another way, contact ${support}.`,
        )
      }

      await container.jobs.enqueue(DATA_EXPORT_JOB, { userId }, { singletonKey: userId })

      const payload: RequestDataExportResponse = { ok: true, email }
      reply.status(200).send(payload)
    },
  )
}

async function assertUserBlockable(
  app: FastifyInstance,
  blocks: BlocksRepository,
  viewerId: string,
  userId: string,
): Promise<void> {
  const store = app.authServices?.users
  if (!store) throw AppError.unauthorized("Authentication required.")
  const u = await store.findById(userId)
  if (!u || u.deletedAt !== null) throw AppError.notFound(UNBLOCKABLE_MESSAGE)
  const { blockedByViewer, blockedByTarget } = await blocks.blockState(viewerId, userId)
  if (blockedByTarget && !blockedByViewer) throw AppError.notFound(UNBLOCKABLE_MESSAGE)
}
