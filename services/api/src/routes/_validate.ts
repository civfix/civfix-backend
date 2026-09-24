import { AppError } from "@civfix/shared"
import type { FastifyRequest } from "fastify"
import { z, type ZodTypeAny } from "zod"

// Field key for an issue on the value itself (a non-object body, a refine on the whole schema).
const ROOT_FIELD_KEY = "_"

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data)
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ZodError" &&
      Array.isArray((err as unknown as { issues?: unknown }).issues)
    ) {
      const issues = (
        err as unknown as { issues: { path: (string | number)[]; message: string }[] }
      ).issues
      const fields: Record<string, string> = {}
      for (const issue of issues) {
        const key = issue.path.length > 0 ? issue.path.join(".") : ROOT_FIELD_KEY
        fields[key] = issue.message
      }
      throw AppError.validation(fields)
    }
    throw err
  }
}

function trimTextValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : entry))
  }
  return value
}

export function trimTextFields<S extends ZodTypeAny>(
  schema: S,
  ...fields: readonly string[]
): z.ZodEffects<S, z.infer<S>, unknown> {
  return z.preprocess((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw
    const source = raw as Record<string, unknown>
    const trimmed: Record<string, unknown> = { ...source }
    for (const field of fields) {
      if (field in source) trimmed[field] = trimTextValue(source[field])
    }
    return trimmed
  }, schema)
}

// Path params spread last: the URL path is authoritative, so a body or query field can never address a
// different row than the path names.
export function paramsOverBody(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const body = (request.body ?? {}) as Record<string, unknown>
  return { ...body, ...params }
}

export function paramsOverQuery(request: FastifyRequest): Record<string, unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>
  const query = (request.query ?? {}) as Record<string, unknown>
  return { ...query, ...params }
}
