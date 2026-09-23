import { AppError, IdSchema, type AdminOkResponse, type RoomKind } from "@civfix/shared"
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { ZodTypeAny, z } from "zod"
import { parse } from "../_validate.js"
import type { Container } from "../../di.js"
import { broadcastMessageUpdate } from "../../ws/gateway.js"
import { makeDrizzleChatRepository } from "../../services/chat-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../services/dm-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../../services/media-presign.js"
import { findMessageRoom } from "../../services/admin/admin-report-chat-repository.drizzle.js"
import {
  makeMessageUpdateAnnouncer,
  type MessageUpdateAnnouncer,
} from "../../services/admin/admin-report-chat-service.js"

export { parse }

// A one-message page around the target is the smallest read that still returns a tombstoned message.
const TARGET_ONLY = 1

// The columns these feed are `uuid`: a malformed id must be a 422 here rather than reach SQL, where
// `invalid input syntax for type uuid` becomes a hidden 500 and a GlitchTip capture.
function idSegment(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value : ""
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) {
    throw AppError.validation({ [field]: raw === "" ? "required" : "must be a valid id" })
  }
  return parsed.data
}

export function idParam(request: FastifyRequest): { id: string } {
  return { id: idSegment((request.params as { id?: unknown }).id, "id") }
}

// Path params carry only the segments the URL declares, so no unknown-key rejection is needed.
export function twoIdParams<K extends string>(
  request: FastifyRequest,
  secondKey: K,
): { id: string } & { [P in K]: string } {
  const params = request.params as Record<string, unknown>
  // The computed key widens to an index signature, so the shape is restated for the caller.
  return {
    id: idSegment(params.id, "id"),
    [secondKey]: idSegment(params[secondKey], secondKey),
  } as { id: string } & { [P in K]: string }
}

/**
 * The typed client also fills the id into the body, but the URL path is authoritative: the path id
 * overwrites whatever the body claimed, so a body id can never address a different row than the path names.
 */
export function parseBodyWithId<S extends ZodTypeAny>(
  schema: S,
  request: FastifyRequest,
): { id: string; body: z.infer<S> } {
  const { id } = idParam(request)
  return { id, body: parse(schema, { ...(request.body as object), id }) }
}

export function sendOk(reply: FastifyReply): void {
  const payload: AdminOkResponse = { ok: true }
  reply.status(200).send(payload)
}

/**
 * The override slot is re-read on every call rather than captured, so a test that installs it after
 * buildServer still wins (it is reached through the encapsulated admin scope's prototype chain).
 */
export function overridableService<K extends keyof FastifyInstance, S>(
  app: FastifyInstance,
  key: K,
  fromOverrides: (overrides: NonNullable<FastifyInstance[K]>) => S,
  fromContainer: () => S,
): () => S {
  return () => {
    const overrides = app[key]
    return overrides === undefined
      ? fromContainer()
      : fromOverrides(overrides as NonNullable<FastifyInstance[K]>)
  }
}

/**
 * The message is re-read through the room's around-history window, the one read path that returns a
 * tombstoned target, so the frame carries exactly what a member's own delete would broadcast.
 */
export function makeContainerMessageUpdateAnnouncer(
  container: Container,
  logger: FastifyBaseLogger,
): MessageUpdateAnnouncer {
  const sql = container.getDb().sql
  const presign = makePrivateMediaPresigner(container.storage)
  const chatRepo = makeDrizzleChatRepository(sql, presign)
  const dmRepo = makeDrizzleDmRepository(sql, presign)
  const historyAround = (kind: RoomKind, roomId: string, messageId: string) => {
    switch (kind) {
      case "dm":
        return dmRepo.history(roomId, undefined, TARGET_ONLY, null, messageId)
      case "report":
        return chatRepo.reportHistory(roomId, undefined, TARGET_ONLY, null, messageId)
      case "group":
        return chatRepo.groupHistory(roomId, undefined, TARGET_ONLY, null, messageId)
      default:
        return chatRepo.history(roomId, undefined, TARGET_ONLY, null, messageId)
    }
  }
  return makeMessageUpdateAnnouncer({
    findRoom: (messageId) => findMessageRoom(sql, messageId),
    loadMessage: async (kind, roomId, messageId) => {
      const page = await historyAround(kind, roomId, messageId)
      return page.items.find((m) => m.id === messageId) ?? null
    },
    broadcast: (kind, roomId, message) =>
      broadcastMessageUpdate(container.chatService, kind, roomId, message),
    logger,
  })
}

// Absent means "the service keeps its own default clock", which is not the same as `now: undefined`.
export function spreadNow(overrides: { now?: () => Date }): { now?: () => Date } {
  return overrides.now !== undefined ? { now: overrides.now } : {}
}

/**
 * Server-side scheme allowlist for a stored, re-served URL (`formUrl` on jurisdictions and discovery
 * contacts).
 *
 * The wire schemas use Zod's `.url()`, which only asserts that `new URL()` parses the string, and
 * `javascript:alert(1)`, `data:text/html,...` and `vbscript:...` all parse. These values are rendered as an
 * href in the admin console and the public jurisdiction directory, so a stored `javascript:` URI is a
 * stored XSS in two UIs (in the console a full authz bypass, since the CSRF cookie is JS-readable).
 *
 * The wire schemas live in @civfix/shared, so the constraint is enforced at the persist boundary until
 * `PatchJurisdictionRequestSchema` / `SaveContactsRequestSchema` / `SaveDraftRequestSchema` carry a
 * scheme-checked URL themselves.
 *
 * Null or blank passes through as null: clearing the field is legitimate.
 */
export function httpUrlField(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value.trim() === "") return null
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw AppError.validation({ [field]: "must be a valid http(s) URL" })
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw AppError.validation({ [field]: "must use http or https" })
  }
  return trimmed
}

// A GEOID is free-form text (not a uuid), so this checks presence only. That is safe only because every
// consumer binds it as a SQL parameter: a GEOID must never reach sql.unsafe()/sql.raw().
export function geoidParam(request: FastifyRequest): string {
  const params = request.params as { geoid?: unknown }
  const geoid = typeof params.geoid === "string" ? params.geoid : ""
  if (geoid === "") throw AppError.validation({ geoid: "required" })
  return geoid
}
