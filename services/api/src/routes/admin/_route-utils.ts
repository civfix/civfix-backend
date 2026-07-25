import { AppError, IdSchema } from "@civfix/shared"
import type { FastifyRequest } from "fastify"

export { parse } from "../_validate.js"

// idParam validates the `:id` segment as a UUID (the columns it feeds are `uuid`) so a malformed id
// returns AppError.validation (HTTP 422) instead of reaching the SQL layer, where a non-uuid would throw
// `invalid input syntax for type uuid` -> a hidden 500 + a GlitchTip capture.
export function idParam(request: FastifyRequest): { id: string } {
  const params = request.params as { id?: unknown }
  const raw = typeof params.id === "string" ? params.id : ""
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) {
    throw AppError.validation({ id: raw === "" ? "required" : "must be a valid id" })
  }
  return { id: parsed.data }
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
