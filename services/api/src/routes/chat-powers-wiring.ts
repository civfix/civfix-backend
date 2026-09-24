/**
 * P3: route-level wiring for the chat-powers resolver (src/services/chat-room-roles.ts) — the single
 * source of truth for "who may pin" and "who may delete others' messages". Shared by the pin route
 * (messages.routes.ts) and the delete routes (chat.routes.ts / report-chat.routes.ts).
 *
 * Three tiers, mirroring the repo-wiring convention of those route files:
 *   1. An injected `chatOverrides.chatPowers` resolver wins outright (integration tests wire the real
 *      resolver over the pg-backed lookups this way).
 *   2. Otherwise, when chatOverrides is present (the offline no-DB harnesses), build the resolver over
 *      the seams the overrides DO carry — dmRepo participant + reportChat roleOf — and FAIL CLOSED
 *      (null / false) for the DB-backed lanes that have no seam (cleanup role, global role). Nothing
 *      here may touch container.getDb(): the offline harness has no database.
 *   3. Production: lazily-built Drizzle lookups over the container's sql tag (lazy so mounting the
 *      routes never opens a connection — same pattern as the repos in messages.routes.ts).
 *
 * NOTE (report rooms): operator powers apply WITHOUT a membership row, so callers must consult this
 * resolver rather than pre-gating on membership.
 *
 * ONE resolver per Fastify instance: four route files (chat, chat-groups, report-chat, messages) each
 * called this at mount and each got its own resolver over its own duplicate cleanup/report/group repo
 * handles. They are all registered on the same instance (routes/index.ts), so the memo below hands them
 * the same resolver — and, more to the point, makes "who may pin / delete others" exactly one live object
 * instead of four that could be wired differently.
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import type { Env } from "../env.js"
import { isAdminEmail } from "../auth/admin-allowlist.js"
import { makeChatPowersResolver, type ResolveChatPowers } from "../services/chat-room-roles.js"
import type { ROLE_VALUES } from "../db/schema/types.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import type { DmRepository } from "../services/dm-repository.drizzle.js"
import { makeDmPeerOf } from "../services/dm-peer.js"
import type { BlocksRepository } from "../services/blocks-repository.drizzle.js"

type GlobalRole = (typeof ROLE_VALUES)[number]

/**
 * L10: the dm lane's block gate — "is the caller blocked either way with this thread's other
 * participant?". Resolves the peer off the thread row, then asks the blocks repo; a thread the caller
 * is not in resolves to no peer, which the resolver already handles via isDmParticipant (answering
 * false here keeps this helper's contract to blocks alone).
 */
export function makeIsDmBlocked(
  dm: DmRepository,
  blocks: BlocksRepository,
): (threadId: string, userId: string) => Promise<boolean> {
  const peerOf = makeDmPeerOf(dm)
  return async (threadId, userId) => {
    const peer = await peerOf(threadId, userId)
    if (peer === null) return false
    return blocks.isBlockedEitherWay(userId, peer)
  }
}

/**
 * The global role that counts for chat powers. users.role is never demoted when an operator is
 * off-boarded, so the operator role only carries authority while the row's current email passes the same
 * ADMIN_EMAILS check the admin guard applies; otherwise the user has no global authority (null).
 */
export async function chatAuthorityRoleOf(
  sql: ReturnType<Container["getDb"]>["sql"],
  env: Pick<Env, "ADMIN_EMAILS">,
  userId: string,
): Promise<GlobalRole | null> {
  const rows = await sql<{ role: GlobalRole; email: string | null }[]>`
    SELECT role, email FROM users WHERE id = ${userId} LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  if (row.role === "operator" && (row.email === null || !isAdminEmail(env, row.email))) return null
  return row.role
}

/** Per-instance memo (see the module banner). Keyed on the app so two harnesses never share a resolver. */
const resolvers = new WeakMap<FastifyInstance, ResolveChatPowers>()

export function wireChatPowers(app: FastifyInstance, container: Container): ResolveChatPowers {
  const cached = resolvers.get(app)
  if (cached) return cached
  const resolver = buildChatPowers(app, container)
  resolvers.set(app, resolver)
  return resolver
}

function buildChatPowers(app: FastifyInstance, container: Container): ResolveChatPowers {
  const overrides = app.chatOverrides
  if (overrides?.chatPowers) return overrides.chatPowers

  if (overrides) {
    // Offline override harness without an injected resolver: honor the seams that exist, fail closed
    // for the rest. Never touches the container's DB handle.
    const offlineDm = overrides.dmRepo
    const offlineBlocks = overrides.blocksRepo
    return makeChatPowersResolver({
      isDmParticipant: (threadId, userId) =>
        offlineDm ? offlineDm.isParticipant(threadId, userId) : Promise.resolve(false),
      // L10: only wired when the harness carries BOTH seams; otherwise the lane keeps its pre-L10
      // behavior (no block data offline => never blocked), like the other fail-closed-to-null lookups.
      ...(offlineDm && offlineBlocks
        ? { isDmBlocked: makeIsDmBlocked(offlineDm, offlineBlocks) }
        : {}),
      cleanupRoleOf: () => Promise.resolve(null),
      reportChatRoleOf: (reportId, userId) =>
        overrides.reportChat
          ? overrides.reportChat.roleOf(reportId, userId)
          : Promise.resolve(null),
      globalRoleOf: () => Promise.resolve(null),
      groupRoleOf: (groupId, userId) =>
        overrides.groups ? overrides.groups.roleOf(groupId, userId) : Promise.resolve(null),
    })
  }

  let cleanups: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let reportChat: ReportChatRepository | undefined
  let groups: ChatGroupRepository | undefined
  let isDmBlocked: ReturnType<typeof makeIsDmBlocked> | undefined
  return makeChatPowersResolver({
    isDmParticipant: (threadId, userId) => container.getDmRepo().isParticipant(threadId, userId),
    // L10: DM pin power respects blocks, like every other DM surface. Built on first use (the lazy
    // convention of this file) so mounting never resolves the container's repos.
    isDmBlocked: (threadId, userId) =>
      (isDmBlocked ??= makeIsDmBlocked(container.getDmRepo(), container.getBlocksRepo()))(
        threadId,
        userId,
      ),
    cleanupRoleOf: (cleanupId, userId) =>
      (cleanups ??= makeDrizzleCleanupRepository(container.getDb().sql)).roleOf(cleanupId, userId),
    reportChatRoleOf: (reportId, userId) =>
      (reportChat ??= makeReportChatRepository(container.getDb().sql)).roleOf(reportId, userId),
    globalRoleOf: (userId) => chatAuthorityRoleOf(container.getDb().sql, container.env, userId),
    groupRoleOf: (groupId, userId) =>
      (groups ??= makeChatGroupRepository(container.getDb().sql)).roleOf(groupId, userId),
  })
}
