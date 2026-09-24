/**
 * The offline harnesses (chatOverrides without a chatPowers resolver) have no database: lanes with no
 * override seam fail closed (null / false) and nothing here may touch container.getDb(). Production
 * lookups are built lazily so mounting the routes never opens a connection.
 *
 * Report rooms: operator powers apply WITHOUT a membership row, so callers must consult this resolver
 * rather than pre-gating on membership.
 *
 * One resolver per Fastify instance, so "who may pin / delete others" is one live object rather than
 * one per route file that could be wired differently.
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
 * A thread the caller is not in resolves to no peer and answers false: isDmParticipant already gates
 * that case, and this helper's contract stays about blocks alone.
 */
function makeIsDmBlocked(
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

/** Keyed on the app so two harnesses never share a resolver. */
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
    const offlineDm = overrides.dmRepo
    const offlineBlocks = overrides.blocksRepo
    return makeChatPowersResolver({
      isDmParticipant: (threadId, userId) =>
        offlineDm ? offlineDm.isParticipant(threadId, userId) : Promise.resolve(false),
      // Only wired when the harness carries both seams; without block data offline the lane reads as
      // never blocked.
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
    // DM pin power respects blocks, like every other DM surface. Built on first use so mounting never
    // resolves the container's repos.
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
