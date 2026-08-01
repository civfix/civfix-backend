import { Transform, type Readable } from "node:stream"
import { AppError, MAX_VIDEO_BYTES } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance, FastifyRequest, RequestPayload } from "fastify"
import {
  isSafeObjectKey,
  LOCAL_STORAGE_ROUTE_PREFIX,
  nowSec,
  SIGNATURE_PATTERN,
  type ByteRange,
  type LocalDiskStorage,
  type SignatureVerdict,
} from "../adapters/storage.local.js"
import { parse } from "./_validate.js"

declare module "fastify" {
  interface FastifyRequest {
    localPutGrant?: ResolvedPutGrant
  }
}

const OBJECT_ROUTE = `${LOCAL_STORAGE_ROUTE_PREFIX}/:namespace/*`

const LOCAL_STORAGE_RATE_LIMIT = { max: 600, timeWindow: "1 minute" } as const

const CROSS_ORIGIN_RESOURCE_POLICY_FOR_EMBEDDABLE_MEDIA = "cross-origin"

const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

const PutQuerySchema = z
  .object({
    exp: z.coerce.number().int(),
    ct: z.string().regex(MEDIA_TYPE_PATTERN),
    sz: z.coerce.number().int().positive().max(MAX_VIDEO_BYTES),
    sig: z.string().regex(SIGNATURE_PATTERN),
  })
  .strict()

const GetQuerySchema = z
  .object({
    exp: z.coerce.number().int(),
    sig: z.string().regex(SIGNATURE_PATTERN),
  })
  .strict()

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/

interface ResolvedPutGrant {
  storage: LocalDiskStorage
  key: string
  contentType: string
  byteSize: number
}

interface ResolvedGetGrant {
  storage: LocalDiskStorage
  key: string
}

export async function registerLocalStorageRoutes(
  app: FastifyInstance,
  stores: readonly LocalDiskStorage[],
): Promise<void> {
  const byNamespace = new Map(stores.map((store) => [store.namespace as string, store]))

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MAX_VIDEO_BYTES },
      (_request, body, done) => {
        done(null, body)
      },
    )
    scope.decorateRequest("localPutGrant")

    scope.put(
      OBJECT_ROUTE,
      {
        bodyLimit: MAX_VIDEO_BYTES,
        config: { rateLimit: LOCAL_STORAGE_RATE_LIMIT },
        onRequest: async (request) => {
          const grant = resolvePutGrant(request, byNamespace)
          assertDeclaredUploadMatchesGrant(request, grant)
          request.localPutGrant = grant
        },
        preParsing: async (request, _reply, payload) => {
          const grant = request.localPutGrant
          return grant === undefined ? payload : enforceUploadSize(payload, grant.byteSize)
        },
      },
      async (request, reply) => {
        const grant = grantOf(request)
        const body = request.body
        if (!Buffer.isBuffer(body)) {
          throw AppError.mediaRejected("Upload body is missing")
        }
        if (body.byteLength !== grant.byteSize) {
          throw AppError.mediaRejected("Upload size does not match the presigned Content-Length")
        }
        await grant.storage.put(grant.key, body, { contentType: grant.contentType })
        reply.status(200).send({ ok: true })
      },
    )

    scope.get(
      OBJECT_ROUTE,
      { config: { rateLimit: LOCAL_STORAGE_RATE_LIMIT } },
      async (request, reply) => {
        const { storage, key } = resolveGetGrant(request, byNamespace)
        const head = await storage.head(key)
        if (head === null) {
          throw AppError.notFound("Object not found")
        }

        reply.header("accept-ranges", "bytes")
        reply.header("cache-control", "private, max-age=60")
        reply.header(
          "cross-origin-resource-policy",
          CROSS_ORIGIN_RESOURCE_POLICY_FOR_EMBEDDABLE_MEDIA,
        )

        const range = parseRange(request.headers.range, head.size)
        if (range === "unsatisfiable") {
          reply.header("content-range", `bytes */${head.size}`)
          return reply.status(416).send()
        }

        reply.header("content-type", head.contentType)
        if (head.contentDisposition !== undefined) {
          reply.header("content-disposition", head.contentDisposition)
        }
        if (range === undefined) {
          reply.header("content-length", String(head.size))
          return reply.status(200).send(storage.openObjectStream(key))
        }
        reply.header("content-range", `bytes ${range.start}-${range.end}/${head.size}`)
        reply.header("content-length", String(range.end - range.start + 1))
        return reply.status(206).send(storage.openObjectStream(key, range))
      },
    )
  })
}

function resolvePutGrant(
  request: FastifyRequest,
  byNamespace: ReadonlyMap<string, LocalDiskStorage>,
): ResolvedPutGrant {
  const storage = storageOf(request, byNamespace)
  const key = objectKeyOf(request)
  const query = parse(PutQuerySchema, request.query)
  assertGrant(
    storage.verifySignedRequest(
      {
        method: "PUT",
        key,
        expiresAtSec: query.exp,
        contentType: query.ct,
        byteSize: query.sz,
        signature: query.sig,
      },
      nowSec(),
    ),
  )
  return { storage, key, contentType: query.ct, byteSize: query.sz }
}

function grantOf(request: FastifyRequest): ResolvedPutGrant {
  const grant = request.localPutGrant
  if (grant === undefined) {
    throw AppError.mediaRejected("Upload grant was not resolved")
  }
  return grant
}

function enforceUploadSize(payload: RequestPayload, maxBytes: number): Readable {
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > maxBytes) {
        callback(AppError.mediaRejected("Upload exceeds the presigned Content-Length"))
        return
      }
      callback(null, chunk)
    },
  })
  payload.on("error", (err) => limiter.destroy(err))
  return payload.pipe(limiter)
}

function resolveGetGrant(
  request: FastifyRequest,
  byNamespace: ReadonlyMap<string, LocalDiskStorage>,
): ResolvedGetGrant {
  const storage = storageOf(request, byNamespace)
  const key = objectKeyOf(request)
  const query = parse(GetQuerySchema, request.query)
  assertGrant(
    storage.verifySignedRequest(
      {
        method: "GET",
        key,
        expiresAtSec: query.exp,
        contentType: "",
        byteSize: 0,
        signature: query.sig,
      },
      nowSec(),
    ),
  )
  return { storage, key }
}

function assertDeclaredUploadMatchesGrant(
  request: FastifyRequest,
  grant: ResolvedPutGrant,
): void {
  if (contentTypeOf(request) !== grant.contentType.trim().toLowerCase()) {
    throw AppError.mediaRejected("Content-Type does not match the presigned upload")
  }
  const declaredLength = request.headers["content-length"]
  if (declaredLength !== undefined && Number(declaredLength) !== grant.byteSize) {
    throw AppError.mediaRejected("Upload size does not match the presigned Content-Length")
  }
}

function storageOf(
  request: FastifyRequest,
  byNamespace: ReadonlyMap<string, LocalDiskStorage>,
): LocalDiskStorage {
  const namespace = (request.params as Record<string, unknown>).namespace
  const storage = typeof namespace === "string" ? byNamespace.get(namespace) : undefined
  if (storage === undefined) {
    throw AppError.notFound("Object not found")
  }
  return storage
}

function objectKeyOf(request: FastifyRequest): string {
  const wildcard = (request.params as Record<string, unknown>)["*"]
  const key = typeof wildcard === "string" ? wildcard : ""
  if (!isSafeObjectKey(key)) {
    throw AppError.notFound("Object not found")
  }
  return key
}

function contentTypeOf(request: FastifyRequest): string {
  const header = request.headers["content-type"]
  if (typeof header !== "string") return ""
  const semicolon = header.indexOf(";")
  return (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase()
}

function assertGrant(verdict: SignatureVerdict): void {
  if (verdict === "expired") {
    throw AppError.forbidden("Presigned URL has expired")
  }
  if (verdict !== "valid") {
    throw AppError.forbidden("Presigned URL signature is invalid")
  }
}

function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined
  const match = RANGE_PATTERN.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart = "", rawEnd = ""] = match
  if (rawStart === "" && rawEnd === "") return undefined
  if (size === 0) return "unsatisfiable"

  if (rawStart === "") {
    const suffixLength = Number(rawEnd)
    if (suffixLength <= 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return "unsatisfiable"
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return "unsatisfiable"
  return { start, end }
}
