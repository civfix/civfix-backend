import { AppError, ErrorCode } from "@civfix/shared"
import type {
  Storage,
  PresignPutOptions,
  PresignPutResult,
  StoragePutMeta,
  StorageListOptions,
  StorageListResult,
} from "@civfix/shared/interfaces"
import { normalizeEtag, type StorageHeadWithEtag } from "../services/media-etag.js"
import { readProxySettings, shouldProxyHost } from "./proxy-egress.js"
import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3"

export interface R2StorageConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  publicBase?: string
}

export const R2_DEFAULT_GET_TTL_SEC = 15 * 60
export const R2_PUT_TTL_SEC = 15 * 60

export const R2_CONNECT_TIMEOUT_MS = 5_000
export const R2_SOCKET_IDLE_TIMEOUT_MS = 30_000
export const R2_RESPONSE_TIMEOUT_MS = 30_000
export const R2_MAX_ATTEMPTS = 3
// The handler's timers stop once response headers arrive, so only an abort signal bounds a body
// that stalls mid-stream. Metadata calls sit on request paths; transfers move objects up to tens of MB.
export const R2_METADATA_OPERATION_TIMEOUT_MS = 15_000
export const R2_TRANSFER_OPERATION_TIMEOUT_MS = 120_000

export class R2Storage implements Storage {
  private readonly config: R2StorageConfig
  private client: S3Client | undefined

  constructor(config: R2StorageConfig) {
    this.config = config.publicBase
      ? { ...config, publicBase: ensureScheme(config.publicBase) }
      : config
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignPutResult> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3")
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner")
    const client = await this.getClient()

    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.byteSize,
    })

    try {
      const url = await getSignedUrl(client, command, { expiresIn: R2_PUT_TTL_SEC })
      return {
        url,
        headers: {
          "content-type": opts.contentType,
          "content-length": String(opts.byteSize),
        },
      }
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 presignPut failed", { cause: err })
    }
  }

  async presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string> {
    if (this.config.publicBase && opts?.forceSigned !== true) {
      return joinUrl(this.config.publicBase, key)
    }

    const { GetObjectCommand } = await import("@aws-sdk/client-s3")
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner")
    const client = await this.getClient()

    const command = new GetObjectCommand({ Bucket: this.config.bucket, Key: key })
    const expiresIn = ttlSec > 0 ? ttlSec : R2_DEFAULT_GET_TTL_SEC
    try {
      return await getSignedUrl(client, command, { expiresIn })
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 presignGet failed", { cause: err })
    }
  }

  async head(key: string): Promise<StorageHeadWithEtag | null> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      const res = await client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
        metadataDeadline(),
      )
      const etag = normalizeEtag(res.ETag)
      return {
        size: typeof res.ContentLength === "number" ? res.ContentLength : 0,
        contentType: res.ContentType ?? "application/octet-stream",
        ...(typeof res.ContentDisposition === "string"
          ? { contentDisposition: res.ContentDisposition }
          : {}),
        ...(etag !== null ? { etag } : {}),
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "R2 head failed", { cause: err })
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
        metadataDeadline(),
      )
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 delete failed", { cause: err })
    }
  }

  async put(key: string, body: Uint8Array | Buffer, meta?: StoragePutMeta): Promise<void> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ...(meta?.contentType !== undefined ? { ContentType: meta.contentType } : {}),
          ...(meta?.contentDisposition !== undefined
            ? { ContentDisposition: meta.contentDisposition }
            : {}),
        }),
        transferDeadline(),
      )
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 put failed", { cause: err })
    }
  }

  async list(prefix: string, opts?: StorageListOptions): Promise<StorageListResult> {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ...(opts?.cursor ? { ContinuationToken: opts.cursor } : {}),
          ...(opts?.limit && opts.limit > 0 ? { MaxKeys: opts.limit } : {}),
        }),
        metadataDeadline(),
      )
      const keys = (res.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === "string")
      return res.IsTruncated && res.NextContinuationToken
        ? { keys, cursor: res.NextContinuationToken }
        : { keys }
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 list failed", { cause: err })
    }
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        transferDeadline(),
      )
      if (!res.Body) return null
      const bytes = await res.Body.transformToByteArray()
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "R2 getObject failed", { cause: err })
    }
  }

  private async getClient(): Promise<S3Client> {
    if (!this.client) {
      const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3")
      const endpointHost = `${this.config.accountId}.r2.cloudflarestorage.com`
      this.client = new S3ClientCtor({
        region: "auto",
        endpoint: `https://${endpointHost}`,
        requestHandler: await boundedRequestHandler(endpointHost),
        maxAttempts: R2_MAX_ATTEMPTS,
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      })
    }
    return this.client
  }
}

function metadataDeadline(): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(R2_METADATA_OPERATION_TIMEOUT_MS) }
}

// The handler's requestTimeout runs from before the body is written until the response arrives, so
// the default response wait would cap a large upload at R2_RESPONSE_TIMEOUT_MS per attempt.
function transferDeadline(): { abortSignal: AbortSignal; requestTimeout: number } {
  return {
    abortSignal: AbortSignal.timeout(R2_TRANSFER_OPERATION_TIMEOUT_MS),
    requestTimeout: R2_TRANSFER_OPERATION_TIMEOUT_MS,
  }
}

async function boundedRequestHandler(host: string): Promise<S3ClientConfig["requestHandler"]> {
  const { NodeHttpHandler } = await import("@smithy/node-http-handler")
  const settings = readProxySettings()
  const httpsAgent =
    settings !== null && shouldProxyHost(host, settings)
      ? new (await import("https-proxy-agent")).HttpsProxyAgent(settings.url)
      : undefined
  // Without throwOnRequestTimeout the SDK only logs a warning when requestTimeout elapses.
  return new NodeHttpHandler({
    connectionTimeout: R2_CONNECT_TIMEOUT_MS,
    socketTimeout: R2_SOCKET_IDLE_TIMEOUT_MS,
    requestTimeout: R2_RESPONSE_TIMEOUT_MS,
    throwOnRequestTimeout: true,
    ...(httpsAgent !== undefined ? { httpsAgent } : {}),
  })
}

function joinUrl(base: string, key: string): string {
  const trimmedBase = base.replace(/\/+$/, "")
  const trimmedKey = key.replace(/^\/+/, "")
  return `${trimmedBase}/${trimmedKey}`
}

function ensureScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base.replace(/^\/+/, "")}`
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as {
    name?: string
    Code?: string
    $metadata?: { httpStatusCode?: number }
  }
  if (e.name === "NotFound" || e.name === "NoSuchKey" || e.Code === "NoSuchKey") return true
  return e.$metadata?.httpStatusCode === 404
}
