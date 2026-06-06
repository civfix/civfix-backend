/**
 * Shared admin-route helpers (Phase 2). Extracted from the ~10 admin route files that each carried a
 * byte-identical copy of `parse` + `idParam`, plus a `geoidParam` (N1: dedupe to reduce drift risk).
 *
 * M5: `idParam` now validates the `:id` segment as a UUID (the columns it feeds are `uuid`), so a
 * malformed id returns a typed AppError.validation (HTTP 400) instead of letting Postgres throw
 * `invalid input syntax for type uuid` -> a hidden 500 + a GlitchTip capture. `geoidParam` validates
 * presence only (a GEOID is free text, not a uuid).
 */

import { AppError, IdSchema } from "@civfix/shared"
import { ZodError, type ZodTypeAny, type z } from "zod"
import type { FastifyRequest } from "fastify"

/**
 * Read + validate the `:id` path param as a UUID. Throws AppError.validation (400) for a missing or
 * malformed id, so a client-correctable bad id never reaches the SQL layer (where a non-uuid would 500).
 */
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
 * Read + validate the `:geoid` path param. A GEOID is free-form text (not a uuid), so this checks
 * presence only.
 */
export function geoidParam(request: FastifyRequest): string {
  const params = request.params as { geoid?: unknown }
  const geoid = typeof params.geoid === "string" ? params.geoid : ""
  if (geoid === "") throw AppError.validation({ geoid: "required" })
  return geoid
}

/** Validate `data` against a Zod schema, throwing AppError.validation on a ZodError (Phase 1 parse()). */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : "_"
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}
