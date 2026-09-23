/**
 * Mirrors what the shared typed client's buildQuery serializes: an array becomes repeated params
 * (`categories=trash&categories=hazard`), an object a single JSON.stringify'd param (`bbox=...`), a scalar a
 * single param. Fastify's `qs` hands a repeated key over as `string | string[]` and a JSON param as its
 * string, so these decode each form back into what the shared request schemas expect; malformed input is a
 * 422, never a 500.
 */

import { z } from "zod"
import { BBoxSchema, LatLngSchema, ReportCategorySchema, ReportTypeSchema } from "@civfix/shared"

// Checked BEFORE parsing: a bbox/near object is tiny, and the cap stops an unauthenticated GET from forcing a
// megabytes-of-valid-JSON parse on the event loop before validation runs.
const MAX_JSON_PARAM_LEN = 4096

/** Bad input becomes a Zod issue (422 at the route's parse()), never a thrown SyntaxError. */
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

/** An unknown token is a 422, not a silent drop; omit the key entirely for "no filter". */
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
 * The shared BBoxSchema checks each bound independently but not their ordering. An inverted bbox would
 * build an empty ST_MakeEnvelope and SILENTLY return no rows, so a transposed bbox from a client bug is a
 * loud 422 here instead. The strict `<` also rejects a zero-area bbox, which can never contain a point.
 */
export const BBoxQueryParam = jsonParam(BBoxSchema).refine(
  (b) => b.west < b.east && b.south < b.north,
  { message: "bbox must satisfy west < east and south < north" },
)

/**
 * Square degrees. Defense in depth behind each read's own row cap: a world-spanning bbox still makes the DB
 * scan up to that cap, and jittered bounds defeat caching. The globe is 64,800 deg^2; this admits a
 * continental view (a real, if rare, client state) and rejects only the pathological world scan.
 */
export const MAX_MAP_BBOX_AREA_DEG2 = 40_000

/**
 * Every anonymous, bbox-driven map read must use this shape; it lives next to the ordering refine so the
 * protection cannot be applied to one viewport read and forgotten on the next.
 */
export const CappedBBoxQueryParam = BBoxQueryParam.refine(
  (b) => (b.east - b.west) * (b.north - b.south) <= MAX_MAP_BBOX_AREA_DEG2,
  { message: "bbox is too large; zoom in and request a smaller viewport" },
)

export const LatLngQueryParam = jsonParam(LatLngSchema)

export const CategoriesQueryParam = csvOrRepeated(ReportCategorySchema)

export const TypesQueryParam = csvOrRepeated(ReportTypeSchema)
