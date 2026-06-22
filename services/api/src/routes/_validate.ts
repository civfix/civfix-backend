import { AppError } from "@civfix/shared"
import { ZodError, type ZodTypeAny, type z } from "zod"
import type { FastifyRequest } from "fastify"

// The canonical route-level Zod validator. Field-key format is `issue.path.join(".")` (fallback "_") so
// every route produces an identical AppError.validation envelope. This is the defense-in-depth partner to
// the http-mapper ZodError branch (the real backstop for an un-wrapped/service-level/.transform throw).
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

export const validateBody = <S extends ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> =>
  parse(schema, request.body)
export const validateQuery = <S extends ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> =>
  parse(schema, request.query)
export const validateParams = <S extends ZodTypeAny>(schema: S, request: FastifyRequest): z.infer<S> =>
  parse(schema, request.params)
