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

// Upper bound on a JSON-encoded query param BEFORE we parse it. A bbox/near object is tiny (well under
// this); the cap stops an unauthenticated GET from forcing a megabytes-of-valid-JSON parse on the event
// loop (DoS) before validation ever runs. Over-cap is a 422, identical to malformed JSON.
const MAX_JSON_PARAM_LEN = 4096

/**
 * A query param that is a JSON-encoded object, validated against `inner` after parsing. The client
 * sends `?bbox=<JSON.stringify(bbox)>`; here we JSON.parse the string then pipe through the shared
 * object schema. An over-length value, bad JSON, or a value that does not match `inner` yields a Zod
 * issue (-> 422 at the route's parse()), never a thrown SyntaxError.
 */
function jsonParam<S extends z.ZodTypeAny>(inner: S) {
  return z
    .string()
    .transform((raw, ctx) => {
      if (raw.length > MAX_JSON_PARAM_LEN) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON param too large" })
        return z.NEVER
      }
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
 * A query param sent as repeated keys (string[]) OR a single CSV string, each token validated against
 * `element`. An unknown token is a 422 (not a silent drop); the result is a non-empty array. Omit the key
 * entirely for "no filter". (Used for `categories` and `types`.)
 */
function csvOrRepeated<S extends z.ZodTypeAny>(element: S) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) => {
      const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",")
      return tokens.map((t) => t.trim()).filter((t) => t.length > 0)
    })
    .pipe(z.array(element).min(1))
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

/**
 * M14: hard ceiling on the requested viewport AREA in square degrees.
 *
 * Defense-in-depth behind each read's own row cap: even fully clustered, a world-spanning bbox still makes
 * the DB scan up to that cap, and the response is uncacheable in practice because the attacker jitters the
 * bounds. The whole globe is 360x180 = 64,800 deg^2; this cap admits a hemispheric/continental view (which
 * is a real, if rare, client state) and rejects only the pathological world-scan.
 */
export const MAX_MAP_BBOX_AREA_DEG2 = 40_000

/**
 * bbox + the M14 area cap: the shape EVERY anon, bbox-driven map read must use (reports, cleanup pins,
 * cleanup list). Lives here, next to the ordering refine, so the protection cannot be applied to one
 * viewport read and forgotten on the next one — a 422 with a clear message, not a silent degradation.
 */
export const CappedBBoxQueryParam = BBoxQueryParam.refine(
  (b) => (b.east - b.west) * (b.north - b.south) <= MAX_MAP_BBOX_AREA_DEG2,
  { message: "bbox is too large; zoom in and request a smaller viewport" },
)

/** near as the client sends it: a single JSON-encoded LatLng object param. */
export const LatLngQueryParam = jsonParam(LatLngSchema)

/** categories: repeated params or a single CSV, each token a ReportCategory. `categories: CategoriesQueryParam.optional()`. */
export const CategoriesQueryParam = csvOrRepeated(ReportCategorySchema)

/** types (0021): the fine-grained-type analogue of categories, each token a ReportType. */
export const TypesQueryParam = csvOrRepeated(ReportTypeSchema)
