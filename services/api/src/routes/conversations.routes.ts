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
import { csrfProtect } from "../auth/csrf.js"
import { parse } from "./_validate.js"
import { route } from "../versioning/route.js"
import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"
import {
  makeConversationMutesRepository,
  type ConversationMutesRepository,
} from "../services/conversation-mutes-repository.drizzle.js"

// Optional injected mutes-repository (tests): routes use this instead of the container, so the whole
// toggle-mute HTTP flow runs offline. Unset in production, where the routes build the Drizzle repo
// lazily from the container's DB handle.
export interface ConversationMutesOverrides {
  repo: ConversationMutesRepository
}

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
  let repo: ConversationMutesRepository | undefined
  const getRepo = (): ConversationMutesRepository =>
    app.conversationMutesOverrides?.repo ?? (repo ??= makeConversationMutesRepository(container.getDb().sql))

  route(app, "toggleConversationMute", { preHandler: csrfProtect }, async (request, reply) => {
    const userId = requireAuth(request)
    const body = parse(ToggleMuteRequestSchema, request.body)
    if (!isMutableRoomKind(body.roomKind)) {
      throw AppError.validation({ roomKind: "This conversation kind cannot be muted." })
    }
    await getRepo().setMuted(userId, body.roomKind, body.roomId, body.muted)
    const payload: ToggleMuteResponse = { muted: body.muted }
    reply.status(200).send(payload)
  })
}
