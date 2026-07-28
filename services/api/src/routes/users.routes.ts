/**
 * Users / privacy route plugin (DM-adjacent surfaces).
 *
 *   GET    /users/search      [auth][rate-limit]  @handle PREFIX search to start a DM -> SearchUsersResponse.
 *                             Strips a leading `@`; excludes self/no-handle/DM-off/soft-deleted/blocked.
 *   POST   /users/:id/block   [auth][csrf]  block a user -> { blocked:true }.
 *   DELETE /users/:id/block   [auth][csrf]  unblock a user -> { blocked:false }.
 *   GET    /me/blocks         [auth]  the viewer's blocked accounts -> ListBlocksResponse.
 *   PUT    /me/settings       [auth][csrf]  update privacy settings (DM toggle) -> { user }.
 *
 * Search runs over the DB (searchByHandlePrefix). Blocks run through the container's memoized blocks repo
 * (the SAME instance the gateway + threads UNION use). Settings ride the auth bundle's UserStore. The DB
 * handle + seams are reached lazily inside handlers so merely mounting the plugin opens no connection.
 */

import {
  SearchUsersRequestSchema,
  MentionSearchRequestSchema,
  UpdateSettingsRequestSchema,
  DeleteAccountRequestSchema,
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
import { clearCsrfCookie } from "../auth/csrf.js"
import { clearSessionCookie } from "../auth/transport.js"
import { searchByHandlePrefix, searchMentionable } from "../services/social-repository.drizzle.js"
import { toUserDTO } from "../auth/auth-services.js"
import { writeAudit } from "../services/admin/audit.js"
import {
  makeDataExportService,
  type DataExportService,
} from "../services/data-export-service.js"
import { makeDrizzleNotificationRepository } from "../services/notification-repository.drizzle.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"
import { route } from "../versioning/route.js"
import { parse } from "./_validate.js"
import { SUPPORTED_LOCALES } from "../i18n/locales.js"

/** Optional injected data-export service (tests) so the POST /me/data-export flow runs offline. */
export interface DataExportOverride {
  service: DataExportService
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected data-export service override (tests). See DataExportOverride. */
    dataExportOverride?: DataExportOverride
  }
}

/**
 * Tighter per-IP rate limit for the data-export request (each assembles + emails a full export; a real
 * client needs at most a handful). Mirrors the verification apply limit shape.
 */
const DATA_EXPORT_RATE_LIMIT = { max: 5, timeWindow: "1 hour" } as const

/** Path param schema for the routes that take a user UUID in the URL. */
const UserIdParamsSchema = z.object({ id: IdSchema }).strict()

/**
 * Optional `locale` on PUT /me/settings. Parsed separately from the shared UpdateSettingsRequestSchema
 * (which may strip an unknown key) and validated against the backend LocaleEnum {en,es,de,ko} — an
 * unsupported value is REJECTED (422 with field `locale`), not clamped, so the persisted source-of-truth
 * is always a known-good code. `.passthrough()` ignores the other settings fields parsed elsewhere.
 */
const SettingsLocaleSchema = z
  .object({
    locale: z.enum([...SUPPORTED_LOCALES] as [string, ...string[]]).optional(),
  })
  .passthrough()

/** Default + cap for user search (the shared request caps `limit` at 20). */
const USER_SEARCH_DEFAULT_LIMIT = 10

/** Tighter per-IP rate limit for the @handle search surface. 30/min is ample for typeahead. */
const USER_SEARCH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const
/**
 * Modest per-IP cap on block/unblock churn — idempotent, but bound abuse below the global ceiling.
 * Exported so the route test can assert the dedicated bucket actually engages (the HOME_TURF_* pattern:
 * a limit no test references is a limit nothing notices losing).
 */
export const BLOCK_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

export async function registerUsersRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  /** The blocks repo: container singleton unless a test injected one via chatOverrides. */
  function blocksRepo(): BlocksRepository {
    return app.chatOverrides?.blocksRepo ?? container.getBlocksRepo()
  }

  // GET /users/search  [auth] — @handle PREFIX search to start a DM. Strip a single leading '@' so
  // "@jane" and "jane" search identically; a bare "@" reduces to "" → empty (never match everyone).
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

  // GET /users/mention-search  [auth] — broader than /users/search: surfaces ANYONE taggable by @handle
  // (no DM-off exclusion), still excluding self / handle-less / soft-deleted / blocked-either-way. The
  // page size is fixed at USER_SEARCH_DEFAULT_LIMIT: MentionSearchRequestSchema is `.strict()` and carries
  // no `limit`, so there is no client-supplied page size to honor.
  route(
    app,
    "mentionSearch",
    { config: { rateLimit: USER_SEARCH_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const q = parse(MentionSearchRequestSchema, request.query)
      const term = q.q.startsWith("@") ? q.q.slice(1) : q.q
      const results =
        term.length === 0
          ? []
          : await searchMentionable(container.getDb().sql, term, userId, USER_SEARCH_DEFAULT_LIMIT)
      const payload: SearchUsersResponse = { results }
      reply.status(200).send(payload)
    },
  )

  route(app, "blockUser", { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(UserIdParamsSchema, request.params)
    if (id === userId) throw AppError.validation({ id: "You cannot block yourself." })
    await assertUserExists(app, id)
    await blocksRepo().block(userId, id)
    const payload: BlockUserResponse = { blocked: true }
    reply.status(200).send(payload)
  })

  route(app, "unblockUser", { preHandler: csrfProtect, config: { rateLimit: BLOCK_RATE_LIMIT } }, async (request, reply) => {
    const userId = requireAuth(request)
    const { id } = parse(UserIdParamsSchema, request.params)
    await blocksRepo().unblock(userId, id)
    const payload: BlockUserResponse = { blocked: false }
    reply.status(200).send(payload)
  })

  route(app, "listBlocks", async (request, reply) => {
    const userId = requireAuth(request)
    const blocked = await blocksRepo().listBlocked(userId)
    const payload: ListBlocksResponse = { blocked }
    reply.status(200).send(payload)
  })

  route(app, "updateSettings", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(UpdateSettingsRequestSchema, request.body)
    // The Profile language switcher's `setLocale` PATCHes `locale` here when authed. The installed
    // @civfix/shared `UpdateSettingsRequestSchema` may strip an unknown `locale` key, so it is parsed
    // SEPARATELY against the backend LocaleEnum: a value outside {en,es,de,ko} is REJECTED (422) rather
    // than silently clamped, keeping the persisted source-of-truth a known-good code. Omitted => no change.
    const locale = parse(SettingsLocaleSchema, request.body).locale
    const store = app.authServices?.users
    if (!store) throw AppError.unauthorized("Authentication required.")
    const updated = await store.updateSettings(userId, {
      ...(body.allowDirectMessages !== undefined
        ? { allowDirectMessages: body.allowDirectMessages }
        : {}),
      ...(locale !== undefined ? { locale } : {}),
      // P6 hours privacy. Omitted => no change, so a client that predates the field never disturbs the
      // stored tri-state; a present value is always an explicit true/false (the "never chosen" null arm
      // is unreachable from here by design).
      ...(body.showVolunteerHours !== undefined
        ? { showVolunteerHours: body.showVolunteerHours }
        : {}),
    })
    const payload: UpdateSettingsResponse = { user: toUserDTO(updated) }
    reply.status(200).send(payload)
  })

  // DELETE /me  [auth][csrf] — SOFT delete: tombstone + DMs off (KEEP PII for admin truth), then REVOKE all
  // sessions (set deleted_at alone does NOT log a warm Redis session out) + set the banned marker, clear
  // the session + csrf cookies, unlink the OAuth identities (else a provider sign-in re-enters the
  // tombstone), drop device push tokens, and audit. The user's posts/reports/comments/events survive (the
  // FKs reference the kept row); public projections render "Deleted User".
  route(app, "deleteAccount", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const store = app.authServices?.users
    const sessions = app.authServices?.sessions
    const otp = app.authServices?.otp
    const oauth = app.authServices?.oauth
    if (!store || !sessions || !otp || !oauth) {
      throw AppError.unauthorized("Authentication required.")
    }

    // EMAIL-OTP GATE: deleting an account requires re-proving control of the account email. The client
    // first requests a one-time code (POST /auth/otp/request) and submits it here; we verify it BEFORE any
    // destructive work, so an idle/stolen session cannot tombstone the account without the email inbox.
    // A bad/expired code throws 401 from verifyOtp and nothing below runs. (We never issue the OTP's
    // session — verifyOtp only proves the email; the existing session is used for this very request, so no
    // session/CSRF rotation, unlike calling the sign-in /auth/otp/verify from the client.)
    //
    // Because it IS the sign-in issue endpoint, that request shares the sign-in 60s per-email cooldown
    // (`otp:rl:email:` in auth/otp.ts). That used to 429 the erasure path for a user who had just signed
    // in; verifyOtp now RELEASES the cooldown whenever a code is successfully consumed (the sign-in itself
    // consumed one), so the deletion code can be requested immediately. See the G17 note in issueOtp for
    // why the release is safe and why a per-purpose namespace is not available server-side.
    const { emailOtp } = parse(DeleteAccountRequestSchema, request.body)
    const me = await store.findById(userId)
    const email = me?.email ?? null
    if (!email) {
      throw AppError.validation(
        { emailOtp: "Add and verify an email address to your account first." },
        "We can't verify account deletion because your account has no email address.",
      )
    }
    // verifyOtp consumes the single-use code and resolves the email to its account (the caller's own).
    const verifiedUserId = await otp.verifyOtp(email, emailOtp, request.ip || null)
    if (verifiedUserId !== userId) {
      // Defensive: the code must belong to THIS account (it always does for the caller's own email).
      throw AppError.unauthorized("That code could not be verified for this account.")
    }

    await store.softDeleteAndAnonymize(userId)
    // banUser revokes ALL durable sessions + cache entries AND sets the veto marker (so any warm session
    // that slipped a revoke is rejected on its next request). A failure here MUST surface: the sessions
    // would still be live on a tombstoned account.
    await sessions.banUser(userId)

    // The tombstone + revocation ARE the deletion. Everything below is cleanup, so the caller's cookies are
    // cleared FIRST and no cleanup failure is allowed to turn a COMPLETED deletion into a 500 the client
    // reads as "deletion failed": a retry can only 401 (every session is revoked) or 422 (the email the OTP
    // gate needs was just nulled), so it is a dead end rather than a second chance. Failures are logged.
    clearSessionCookie(reply)
    clearCsrfCookie(reply)
    // Erasure, in THREE INDEPENDENT steps: (1) unlink the provider identities, so a Google/Apple sign-in
    // cannot walk back into the tombstone once the ban marker's TTL lapses — OAuthService also refuses a
    // soft-deleted account, this removes the dangling row; (2) hard-delete device push tokens (a leftover
    // device identifier) so no notification reaches a deleted account's devices; (3) write the
    // `account.deleted` audit row — the only append-only record that this erasure ran. Built on-demand like
    // the other notification touchpoints (see discussion.routes).
    //
    // PER-STEP ISOLATION (not one chained try): the steps are independent, and chaining them made the
    // FIRST one the gate — a transient unlink failure silently skipped both the push-token erasure (device
    // identifiers retained on a GDPR erasure path) and the audit row, while the client still got 200.
    // allSettled runs all three and logs each rejection with the step name, so a partial failure is
    // actionable from the logs instead of being attributed to whichever step happened to be first.
    // Same shape as SessionService.revokeAllForUser's cache-eviction fan-out.
    const cleanups: ReadonlyArray<readonly [step: string, run: () => Promise<unknown>]> = [
      ["oauth.unlink", () => oauth.unlinkAllForUser(userId)],
      [
        "push-tokens.delete",
        () =>
          makeDrizzleNotificationRepository(container.getDb().sql).deletePushTokensForUser(userId),
      ],
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
    // `async` wrapper deliberately: a step that throws SYNCHRONOUSLY (e.g. building the repo hits a
    // Redis/DB handle error) becomes a rejected promise here rather than escaping allSettled as a 500.
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
  })

  // POST /me/data-export  [auth][csrf] (tight per-IP limit) — email me a copy of my data.
  route(
    app,
    "requestDataExport",
    { preHandler: csrfProtect, config: { rateLimit: DATA_EXPORT_RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const store = app.authServices?.users
      if (!store) throw AppError.unauthorized("Authentication required.")
      const service: DataExportService =
        app.dataExportOverride?.service ??
        makeDataExportService({
          sql: container.getDb().sql,
          mailer: container.mailer,
          users: store,
          fromNoReply: container.env.MAIL_FROM_NOREPLY,
        })

      // ROBUSTNESS (privacy §7.2): the export used to be silently "ok:true" even when nothing was actually
      // delivered — either because the account has no email (Apple / OTP-less / anon-claimed) or because
      // the mailer threw mid-send. Both now surface a CLEAR, actionable error instead of a false success.
      let result: { ok: true; email: string | null }
      try {
        result = await service.exportData(userId)
      } catch (err) {
        // Assembly/delivery failed (e.g. the mailer is down). Do NOT report success — surface a clear,
        // retryable error. The 5/hr limit keeps a retrying client bounded. Log for diagnosis.
        request.log.error({ err, userId }, "data-export: assembly/delivery failed")
        throw AppError.internal(
          "We couldn't send your data export right now. Please try again in a few minutes.",
        )
      }

      // No email on file: the service skipped the send (email:null). Tell the user how to fix it rather
      // than returning a misleading ok:true that implies an email was sent.
      if (result.email === null) {
        throw AppError.validation(
          { email: "Add and verify an email address to your account first." },
          "We can't email your data export because your account has no email address. " +
            "Add and verify an email, then try again.",
        )
      }

      const payload: RequestDataExportResponse = { ok: true, email: result.email }
      reply.status(200).send(payload)
    },
  )
}

/** Reject a block toward a missing/soft-deleted user with a 404 (validate the target exists). */
async function assertUserExists(app: FastifyInstance, userId: string): Promise<void> {
  const store = app.authServices?.users
  if (!store) throw AppError.unauthorized("Authentication required.")
  const u = await store.findById(userId)
  if (!u || u.deletedAt !== null) throw AppError.notFound("User not found")
}
