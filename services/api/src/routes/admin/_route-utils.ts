import { AppError, IdSchema, type AdminOkResponse } from "@civfix/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { ZodTypeAny, z } from "zod"
import { parse } from "../_validate.js"

export { parse }

// Validates one path segment as a UUID (the columns these feed are `uuid`) so a malformed id returns
// AppError.validation (HTTP 422) instead of reaching the SQL layer, where a non-uuid would throw
// `invalid input syntax for type uuid` -> a hidden 500 + a GlitchTip capture.
function idSegment(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value : ""
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) {
    throw AppError.validation({ [field]: raw === "" ? "required" : "must be a valid id" })
  }
  return parsed.data
}

/** Validate the `:id` path segment as a UUID. See idSegment for why this runs before the SQL layer. */
export function idParam(request: FastifyRequest): { id: string } {
  return { id: idSegment((request.params as { id?: unknown }).id, "id") }
}

/**
 * Validate a two-segment `:id`/`:<secondKey>` path (e.g. `/events/:id/reports/:reportId`,
 * `/users/:id/messages/:messageId`). Both segments get the same UUID check idParam applies, so a malformed
 * child id is a 422 rather than a SQL-layer 500. Path params carry only the segments the URL declares, so
 * no unknown-key rejection is needed here.
 */
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
 * Parse a mutation body against its shared schema with the PATH id merged in.
 *
 * The typed client fills the id into the body as well, but the URL path is authoritative: the merged id
 * (validated by idParam) overwrites whatever the body claimed, so a body id can never address a different
 * row than the one the path names. Returns both so a handler can pass the id positionally.
 */
export function parseBodyWithId<S extends ZodTypeAny>(
  schema: S,
  request: FastifyRequest,
): { id: string; body: z.infer<S> } {
  const { id } = idParam(request)
  return { id, body: parse(schema, { ...(request.body as object), id }) }
}

/** Send the shared `{ ok: true }` mutation response (AdminOkResponse), the reply of ~24 admin mutations. */
export function sendOk(reply: FastifyReply): void {
  const payload: AdminOkResponse = { ok: true }
  reply.status(200).send(payload)
}

/**
 * Build the "injected overrides, else the container" service factory every admin router needs.
 *
 * `key` names the FastifyInstance override slot each router declares (e.g. "homeOverrides"). The slot is
 * re-read on EVERY call rather than captured, so a test that installs it AFTER buildServer still wins (the
 * value is reached through the encapsulated admin scope's prototype chain). `fromOverrides` builds the
 * service from the injected in-memory deps; `fromContainer` builds it from the container's Drizzle repos.
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
 * Spread an override bundle's optional clock into a service's deps: `{ ...spreadNow(overrides) }`. Absent
 * means "the service keeps its own default clock", which is not the same as passing `now: undefined`.
 */
export function spreadNow(overrides: { now?: () => Date }): { now?: () => Date } {
  return overrides.now !== undefined ? { now: overrides.now } : {}
}

/**
 * L7: server-side scheme allowlist for a stored, re-served URL (`formUrl` on jurisdictions and on discovery
 * contacts).
 *
 * The wire schemas use Zod's `.url()`, which only asserts that `new URL()` PARSES the string — and
 * `javascript:alert(1)`, `data:text/html,...` and `vbscript:...` all parse. Those values are persisted and
 * later rendered as an href in both the admin console and the public jurisdiction directory, so a stored
 * `javascript:` URI is a stored XSS in two UIs (and in the console that is a full authz bypass, since the
 * CSRF cookie is JS-readable).
 *
 * The wire schema lives in @civfix/shared and cannot be edited from this repo, so the constraint is enforced
 * at the persist boundary instead. FOLLOW-UP: tighten `PatchJurisdictionRequestSchema` /
 * `SaveContactsRequestSchema` / `SaveDraftRequestSchema` in @civfix/shared to a scheme-checked URL so the
 * contract itself rejects it and other consumers inherit the fix.
 *
 * Returns the value unchanged (null/absent passes through — clearing the field is legitimate).
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

// A GEOID is free-form text (not a uuid), so this checks presence only. It is safe ONLY because every
// consumer binds it as a bound SQL parameter — a GEOID must NEVER reach sql.unsafe()/sql.raw().
export function geoidParam(request: FastifyRequest): string {
  const params = request.params as { geoid?: unknown }
  const geoid = typeof params.geoid === "string" ? params.geoid : ""
  if (geoid === "") throw AppError.validation({ geoid: "required" })
  return geoid
}
