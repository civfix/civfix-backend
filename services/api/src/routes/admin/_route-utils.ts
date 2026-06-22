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

// A GEOID is free-form text (not a uuid), so this checks presence only. It is safe ONLY because every
// consumer binds it as a bound SQL parameter — a GEOID must NEVER reach sql.unsafe()/sql.raw().
export function geoidParam(request: FastifyRequest): string {
  const params = request.params as { geoid?: unknown }
  const geoid = typeof params.geoid === "string" ? params.geoid : ""
  if (geoid === "") throw AppError.validation({ geoid: "required" })
  return geoid
}
