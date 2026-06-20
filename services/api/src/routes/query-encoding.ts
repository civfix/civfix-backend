/**
 * Query-string decoders that mirror EXACTLY what the shared typed client (@civfix/shared client.ts
 * buildQuery) serializes, so the backend parses what the web + mobile clients actually send.
 *
 * The shared client encodes a query record like this (see shared/src/client/client.ts):
 *   - an ARRAY value  -> repeated params:      categories=trash&categories=hazard
 *   - an OBJECT value -> a single JSON param:   bbox=%7B%22west%22%3A...%7D   (JSON.stringify'd)
 *   - a scalar value  -> a single param:        zoom=12 / when=upcoming / cursor=abc
 *
 * Fastify parses the query string with `qs`, so a repeated key arrives as `string | string[]` and a
 * JSON-object param arrives as the JSON string. These helpers decode each form back into the nested
 * shape the shared request schemas (ListReportsInBBoxRequest, ListCleanupsRequest, ...) expect, with
 * safe error handling: malformed JSON becomes an AppError.validation (422) rather than a 500.
 *
 * Keeping the wire contract authoritative: we do NOT modify shared. We decode here, then re-validate
 * the assembled object against the shared schema at the call site so the contract stays the single
 * source of truth.
 */

import { z } from "zod"
import { BBoxSchema, LatLngSchema, ReportCategorySchema, ReportTypeSchema } from "@civfix/shared"

/**
 * A query param that is a JSON-encoded object, validated against `inner` after parsing. The client
 * sends `?bbox=<JSON.stringify(bbox)>`; here we JSON.parse the string then pipe through the shared
 * object schema. Bad JSON or a value that does not match `inner` yields a Zod issue (-> 422 at the
 * route's parse()), never a thrown SyntaxError.
 */
function jsonParam<S extends z.ZodTypeAny>(inner: S) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON-encoded object" })
        return z.NEVER
      }
    })
    .pipe(inner)
}

/**
 * bbox as the client sends it: a single JSON-encoded BBox object param.
 *
 * ORDERING VALIDATION (P2): the shared BBoxSchema range-checks each bound independently but does NOT
 * require west < east or south < north (and it is the frozen contract, so we cannot add the refine there).
 * An inverted/degenerate bbox (west >= east or south >= north) would otherwise build an empty
 * ST_MakeEnvelope and SILENTLY return no rows. We reject it here with a clear 422 so a transposed bbox
 * from a client bug is a loud error, not a mysterious empty map. (A strict `<` also rejects a
 * zero-area bbox, which can never contain a point and is therefore never a legitimate viewport query.)
 */
export const BBoxQueryParam = jsonParam(BBoxSchema).refine(
  (b) => b.west < b.east && b.south < b.north,
  { message: "bbox must satisfy west < east and south < north" },
)

/** near as the client sends it: a single JSON-encoded LatLng object param. */
export const LatLngQueryParam = jsonParam(LatLngSchema)

/**
 * categories as the client sends it: repeated params (string[]). For resilience we ALSO accept a single
 * string, splitting it on commas (a CSV) so a hand-built `?categories=trash,hazard` still works. Each
 * token is validated against ReportCategory, so an unknown token is a 422 (not a silent drop). The
 * result is a non-empty ReportCategory[]; omit the key entirely for "no filter".
 *
 * Use inside a route schema like: `categories: CategoriesQueryParam.optional()`.
 */
export const CategoriesQueryParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => {
    // A repeated param is already an array; a single param may be a CSV. Normalize both to tokens.
    const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",")
    return tokens.map((t) => t.trim()).filter((t) => t.length > 0)
  })
  .pipe(z.array(ReportCategorySchema).min(1))

/**
 * types as the client sends it (0021): the fine-grained-type analogue of CategoriesQueryParam. Repeated
 * params (string[]) or a single CSV string, each token validated against ReportType (an unknown token is a
 * 422, not a silent drop). The result is a non-empty ReportType[]; omit the key for "no type filter".
 *
 * Use inside a route schema like: `types: TypesQueryParam.optional()`.
 */
export const TypesQueryParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => {
    const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",")
    return tokens.map((t) => t.trim()).filter((t) => t.length > 0)
  })
  .pipe(z.array(ReportTypeSchema).min(1))
