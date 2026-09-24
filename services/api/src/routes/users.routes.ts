import {
  SearchUsersRequestSchema,
  MentionSearchRequestSchema,
  UpdateSettingsRequestSchema,
  DeleteAccountRequestSchema,
  PaginationQuerySchema,
  IdSchema,
  AppError,
  ErrorCode,
  type SearchUsersResponse,
  type BlockUserResponse,
  type ListBlocksResponse,
  type UpdateSettingsResponse,
  type DeleteAccountResponse,
  type RequestDataExportResponse,
} from "@civfix/shared"
import { z } from "zod"
import type { FastifyBaseLogger, FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { isOfficialAccount } from "../auth/official-account.js"
import { clearCsrfCookie } from "../auth/csrf.js"
import { clearSessionCookie } from "../auth/transport.js"
import { searchByHandlePrefix, searchMentionable } from "../services/social-repository.drizzle.js"
import { toUserDTO, type AuthServices } from "../auth/auth-services.js"
import { exposeMessage } from "../errors/exposed-message.js"
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

// The contract's locale enum can gain a value before the server ships a catalog for it, so the
// stored locale is narrowed to what this server can render.
const SettingsLocaleSchema = z
  .object({
    locale: z.enum([...SUPPORTED_LOCALES] as [string, ...string[]]).optional(),
  })
  .passthrough()

const USER_SEARCH_DEFAULT_LIMIT = 10

const USER_SEARCH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const
export const BLOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

const UNBLOCKABLE_MESSAGE = "User not found"

const AUTH_REQUIRED_MESSAGE = "Authentication required."

const ACCOUNT_DELETION_UNAVAILABLE_MESSAGE =
  "We couldn't delete your account right now. Nothing was changed. Please try again in a few minutes."

const ACCOUNT_DELETED_AUDIT_ACTION = "account.deleted"

type PostDeletionCleanup = readonly [step: string, run: () => Promise<unknown>]

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
      const term = withoutMentionPrefix(q.q)
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
      const term = withoutMentionPrefix(q.q)
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
    const store = usersStoreOf(app)
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
    if (!updated) throw AppError.unauthorized(AUTH_REQUIRED_MESSAGE)
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
        throw AppError.unauthorized(AUTH_REQUIRED_MESSAGE)
      }

      const { emailOtp } = parse(DeleteAccountRequestSchema, request.body)
      const me = await store.findById(userId)
      const email = me?.email ?? null
      if (email) {
        const verifiedUserId = await otp.verifyOtpForExistingAccount(
          email,
          emailOtp,
          request.ip || null,
        )
        if (verifiedUserId !== userId) {
          throw AppError.unauthorized("That code could not be verified for this account.")
        }
      }

      await eraseAccount({ users: store, sessions }, userId, request.log)

      clearSessionCookie(reply)
      clearCsrfCookie(reply)
      await runPostDeletionCleanups(
        [
          ["sessions.ban", () => sessions.banUser(userId)],
          ["oauth.unlink", () => oauth.unlinkAllForUser(userId)],
          [
            "audit.account-deleted",
            () =>
              writeAudit(container.getDb().sql, {
                actorId: userId,
                action: ACCOUNT_DELETED_AUDIT_ACTION,
                target: `user:${userId}`,
              }),
          ],
        ],
        userId,
        request.log,
      )
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
      const store = usersStoreOf(app)
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
  const u = await usersStoreOf(app).findById(userId)
  if (!u || u.deletedAt !== null) throw AppError.notFound(UNBLOCKABLE_MESSAGE)
  const { blockedByViewer, blockedByTarget } = await blocks.blockState(viewerId, userId)
  if (blockedByTarget && !blockedByViewer) throw AppError.notFound(UNBLOCKABLE_MESSAGE)
}

function usersStoreOf(app: FastifyInstance): AuthServices["users"] {
  const store = app.authServices?.users
  if (!store) throw AppError.unauthorized(AUTH_REQUIRED_MESSAGE)
  return store
}

function withoutMentionPrefix(q: string): string {
  return q.startsWith("@") ? q.slice(1) : q
}

// A cached session projection is checked against the ban marker and the epoch, never the sessions
// table, so deleting the rows alone would leave every cached bearer working, and sliding forward, up
// to the absolute session cap. The marker goes up before anything is erased: if it cannot be written
// the deletion is refused, and if the erasure then fails the marker comes down again so the account
// keeps working.
async function eraseAccount(
  services: Pick<AuthServices, "users" | "sessions">,
  userId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const { users, sessions } = services
  try {
    await sessions.markBanned(userId)
  } catch (err) {
    throw exposeMessage(
      new AppError(ErrorCode.INTERNAL, ACCOUNT_DELETION_UNAVAILABLE_MESSAGE, {
        httpStatus: 503,
        cause: err,
      }),
    )
  }
  try {
    await users.softDeleteAndAnonymize(userId)
  } catch (err) {
    await sessions.clearBan(userId).catch((clearErr: unknown) => {
      log.error(
        { err: clearErr, userId },
        "account deletion: erasure failed and the pre-set ban marker could not be cleared; the live account stays locked out until the marker expires or an operator restores its status",
      )
    })
    throw err
  }
}

async function runPostDeletionCleanups(
  cleanups: readonly PostDeletionCleanup[],
  userId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const outcomes = await Promise.allSettled(cleanups.map(async ([, run]) => run()))
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      log.error(
        { err: outcome.reason, userId, step: cleanups[i]![0] },
        "account deletion: post-commit cleanup step failed (the account IS deleted, its session rows went with the erasure and the ban marker set before it still rejects cached sessions)",
      )
    }
  })
}
