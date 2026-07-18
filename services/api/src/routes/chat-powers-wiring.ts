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
 */

import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import {
  makeChatPowersResolver,
  type ResolveChatPowers,
} from "../services/chat-room-roles.js"
import type { ROLE_VALUES } from "../db/schema/types.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"

type GlobalRole = (typeof ROLE_VALUES)[number]

/** The user's global users.role, or null when the row is missing. */
export async function globalRoleOf(
  sql: ReturnType<Container["getDb"]>["sql"],
  userId: string,
): Promise<GlobalRole | null> {
  const rows = await sql<{ role: GlobalRole }[]>`
    SELECT role FROM users WHERE id = ${userId} LIMIT 1
  `
  return rows[0]?.role ?? null
}

export function wireChatPowers(app: FastifyInstance, container: Container): ResolveChatPowers {
  const overrides = app.chatOverrides
  if (overrides?.chatPowers) return overrides.chatPowers

  if (overrides) {
    // Offline override harness without an injected resolver: honor the seams that exist, fail closed
    // for the rest. Never touches the container's DB handle.
    return makeChatPowersResolver({
      isDmParticipant: (threadId, userId) =>
        overrides.dmRepo ? overrides.dmRepo.isParticipant(threadId, userId) : Promise.resolve(false),
      cleanupRoleOf: () => Promise.resolve(null),
      reportChatRoleOf: (reportId, userId) =>
        overrides.reportChat ? overrides.reportChat.roleOf(reportId, userId) : Promise.resolve(null),
      globalRoleOf: () => Promise.resolve(null),
    })
  }

  let cleanups: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let reportChat: ReportChatRepository | undefined
  return makeChatPowersResolver({
    isDmParticipant: (threadId, userId) => container.getDmRepo().isParticipant(threadId, userId),
    cleanupRoleOf: (cleanupId, userId) =>
      (cleanups ??= makeDrizzleCleanupRepository(container.getDb().sql)).roleOf(cleanupId, userId),
    reportChatRoleOf: (reportId, userId) =>
      (reportChat ??= makeReportChatRepository(container.getDb().sql)).roleOf(reportId, userId),
    globalRoleOf: (userId) => globalRoleOf(container.getDb().sql, userId),
  })
}
