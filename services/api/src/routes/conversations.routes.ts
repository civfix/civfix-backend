/**
 * Task D-E1: per-conversation mute route.
 *
 *   PUT /conversations/mute   [auth][csrf]   toggle mute for one room   -> ToggleMuteResponse
 *
 * The shared `RoomKind` (ws-frame room kind) carries three values: 'cleanup' | 'dm' | 'report', all of
 * which the conversation_mutes table models. (The former 'report_discussion' room kind was removed with
 * the discussion system.) `isMutableRoomKind` still gates defensively so any future non-mutable room kind
 * is rejected as a validation error rather than reaching the repo.
 *
 * The repo is reached lazily via the container (production: the Drizzle repo) or an injected override
 * (tests: a fake so the route runs with no database), mirroring notifications.routes.ts's repo() seam.
 */

import { ToggleMuteRequestSchema, AppError, type ToggleMuteResponse } from "@civfix/shared"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { requireAuth } from "../auth/context.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../services/cleanup-repository.drizzle.js"
import {
  makeReportChatRepository,
  type ReportChatRepository,
} from "../services/report-chat-repository.drizzle.js"
import {
  makeChatGroupRepository,
  type ChatGroupRepository,
} from "../services/chat-group-repository.drizzle.js"
import { makeDrizzleDiscussionRepository } from "../services/discussion-repository.drizzle.js"
import type { DiscussionRepository } from "../services/discussion-types.js"
import { isReportVisibleTo } from "../services/report-visibility.js"

// Optional injected mutes-repository (tests): routes use this instead of the container, so the whole
// toggle-mute HTTP flow runs offline. Unset in production, where the routes build the Drizzle repo
// lazily from the container's DB handle.
export interface ConversationMutesOverrides {
  repo: ConversationMutesRepository
  /**
   * L9: injected participation gate (tests). Absent in an offline harness means the gate is SKIPPED —
   * the same "honor the seams the overrides carry" convention chatOverrides uses — because the real
   * gate reads four different DB-backed repos. Production always builds the real one below.
   */
  participates?: (
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userId: string,
  ) => Promise<boolean>
}

/**
 * SECURITY (L9): a mute row is only meaningful for a conversation the caller is actually in.
 *
 * Before this gate, `PUT /conversations/mute` wrote whatever `roomId` the body carried — no existence
 * check, no membership check, no rate limit — so any authenticated client could insert unbounded junk
 * rows into `conversation_mutes` (a schema-valid random UUID per request), and the row set doubled as a
 * free write amplifier against the table.
 *
 * "Participates" is deliberately the same visibility notion each room kind uses elsewhere, NOT strict
 * membership, so muting stays available exactly where the UI offers it:
 *   - dm      : a participant of the thread
 *   - cleanup : a cleanup_members row
 *   - report  : a report-chat member, OR anyone who can SEE the report (report rooms are public to open
 *               and joinable, and the client offers mute from the room view)
 *   - group   : a member, or any user for a PUBLIC group (the pre-join readable contract)
 */
const RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const

declare module "fastify" {
  interface FastifyInstance {
    conversationMutesOverrides?: ConversationMutesOverrides
  }
}

/** conversation_mutes only models these four mute targets (P4 added 'group'; see module header). */
const MUTABLE_ROOM_KINDS = new Set<ConversationMuteRoomKind>(["cleanup", "dm", "report", "group"])

function isMutableRoomKind(roomKind: string): roomKind is ConversationMuteRoomKind {
  return MUTABLE_ROOM_KINDS.has(roomKind as ConversationMuteRoomKind)
}

export async function registerConversationRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const csrfProtect = container.csrf.protect

  const overrides = app.conversationMutesOverrides
  let repo: ConversationMutesRepository | undefined
  const getRepo = (): ConversationMutesRepository =>
    overrides?.repo ?? (repo ??= makeConversationMutesRepository(container.getDb().sql))

  // Lazily-built (never at mount time — the offline route-coverage boot must not open a connection).
  let cleanups: ReturnType<typeof makeDrizzleCleanupRepository> | undefined
  let reportChat: ReportChatRepository | undefined
  let groups: ChatGroupRepository | undefined
  let reports: DiscussionRepository | undefined
  let dmParticipant: ReturnType<Container["getDmRepo"]> | undefined

  const participatesReal = async (
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userId: string,
  ): Promise<boolean> => {
    const sql = container.getDb().sql
    if (roomKind === "dm") {
      return (dmParticipant ??= container.getDmRepo()).isParticipant(roomId, userId)
    }
    if (roomKind === "cleanup") {
      return (cleanups ??= makeDrizzleCleanupRepository(sql)).isMember(roomId, userId)
    }
    if (roomKind === "report") {
      if (await (reportChat ??= makeReportChatRepository(sql)).isMember(roomId, userId)) return true
      const report = await (reports ??= makeDrizzleDiscussionRepository(sql)).findReportForDiscussion(roomId)
      return isReportVisibleTo(report, userId)
    }
    const access = await (groups ??= makeChatGroupRepository(sql)).accessOf(roomId, userId)
    return access !== null && (access.role !== null || access.visibility === "public")
  }

  const participates = overrides ? overrides.participates : participatesReal

  route(
    app,
    "toggleConversationMute",
    { preHandler: csrfProtect, config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const userId = requireAuth(request)
      const body = parse(ToggleMuteRequestSchema, request.body)
      if (!isMutableRoomKind(body.roomKind)) {
        throw AppError.validation({ roomKind: "This conversation kind cannot be muted." })
      }
      // L9: no membership, no row. A uniform 403 (never a 404) so this never becomes an existence
      // oracle for private threads/groups, matching the WS lane's stance.
      if (participates && !(await participates(body.roomKind, body.roomId, userId))) {
        throw AppError.forbidden("You can't change notifications for this conversation.")
      }
      await getRepo().setMuted(userId, body.roomKind, body.roomId, body.muted)
      const payload: ToggleMuteResponse = { muted: body.muted }
      reply.status(200).send(payload)
    },
  )
}
