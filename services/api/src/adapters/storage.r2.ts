/**
 * REAL Storage adapter backed by Cloudflare R2 (S3-compatible) via the AWS SDK.
 *
 * Seam rule: @aws-sdk/* may ONLY be imported in THIS file (never by application/domain code). The
 * client + command modules are imported LAZILY inside getClient()/the methods (dynamic import), so
 * merely constructing the adapter during DI wiring never loads the SDK or opens a socket. The DI
 * container swaps in FakeStorage when USE_FAKE_STORAGE is set, so this class is only constructed when
 * real R2 credentials are configured.
 *
 * R2 specifics:
 *   - endpoint  https://<accountId>.r2.cloudflarestorage.com   (account-scoped S3 endpoint)
 *   - region    "auto"                                         (R2 ignores region; "auto" is the
 *                                                               documented value the SDK still requires)
 *   - bucket    config.bucket
 *   - forcePathStyle: true. Without it the v3 SDK defaults to VIRTUAL-HOST addressing and folds the
 *     bucket into the host as a subdomain (https://<bucket>.<account>.r2.cloudflarestorage.com/<key>).
 *     We pin PATH style so the bucket is a path segment under the account endpoint
 *     (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>), which is the form R2's docs use and
 *     avoids bucket-name-as-subdomain DNS/TLS edge cases (dots in bucket names, wildcard certs).
 *
 * Presigned PUT contract (see presignPut): the returned `headers` are the EXACT headers the client
 * MUST echo on its PUT, because they are part of the signed request. We sign both Content-Type and
 * Content-Length, so the upload is pinned to the declared type and exact byte size: R2 rejects a PUT
 * whose Content-Type/Content-Length differ from the signature. This is a cheap, API-side guard that
 * the later media-worker (which inspects the actual bytes) builds on.
 */

import { AppError, ErrorCode } from "@civfix/shared"
import type {
  Storage,
  PresignPutOptions,
  PresignPutResult,
  StorageHead,
  StoragePutMeta,
  StorageListOptions,
  StorageListResult,
} from "@civfix/shared/interfaces"
import type { S3Client } from "@aws-sdk/client-s3"

export interface R2StorageConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** When set, presignGet returns `<publicBase>/<key>` (a public CDN/custom-domain URL) instead of a
   *  time-limited signed GET. Use only for a bucket fronted by a public domain. */
  publicBase?: string
}

/** Default lifetime for a presigned GET URL when the caller does not pin a TTL (15 minutes). */
export const R2_DEFAULT_GET_TTL_SEC = 15 * 60
/** Lifetime for a presigned PUT URL: the client must start the upload within this window (15 min). */
export const R2_PUT_TTL_SEC = 15 * 60

export class R2Storage implements Storage {
  private readonly config: R2StorageConfig
  private client: S3Client | undefined

  constructor(config: R2StorageConfig) {
    // Normalize publicBase to an ABSOLUTE origin. A scheme-less value (e.g. "cdn.civfix.org") would be
    // joined into a RELATIVE url ("cdn.civfix.org/<key>") that the browser resolves against the current
    // page (https://civfix.org/pin/cdn.civfix.org/<key> -> 404) instead of the CDN host. Default the
    // scheme to https:// when absent so the media URL is always absolute.
    this.config = config.publicBase
      ? { ...config, publicBase: ensureScheme(config.publicBase) }
      : config
  }

  /**
   * Presign a PUT for `key`. The client uploads the bytes directly to R2 with this URL, echoing the
   * returned headers. Content-Type and Content-Length are signed (see file header), so the headers
   * map carries both and the client must send them verbatim or R2 rejects the request.
   */
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

  /**
   * Return a URL to GET `key`. With `publicBase` configured, this is the public CDN URL (no signing,
   * no expiry). Otherwise it is a presigned, time-limited GET valid for `ttlSec` seconds.
   *
   * SECURITY (H9): pass `{ forceSigned: true }` for any asset that is not world-readable — chat/DM
   * attachments, an owner's own held/unlisted report media, not-yet-committed uploads. A CDN URL has
   * no expiry and no revocation path, so serving private media through one makes it permanently
   * readable by anyone who ever saw the link, regardless of later unlist/delete/block decisions.
   * `publicBase` is then ignored and a short-lived signed GET is issued instead.
   */
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

  /** HEAD `key`: returns {size, contentType} or null when the object does not exist. */
  async head(key: string): Promise<StorageHead | null> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      const res = await client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      return {
        size: typeof res.ContentLength === "number" ? res.ContentLength : 0,
        contentType: res.ContentType ?? "application/octet-stream",
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "R2 head failed", { cause: err })
    }
  }

  /** DELETE `key`. Idempotent: deleting a missing key is not an error on S3/R2. */
  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 delete failed", { cause: err })
    }
  }

  /** PUT `body` at `key` from the server side (used by the worker for thumbnails / transcodes). */
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
        }),
      )
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "R2 put failed", { cause: err })
    }
  }

  /**
   * LIST keys under `prefix`, paginated. `opts.cursor` is the S3 ContinuationToken; the returned
   * `cursor` is the NextContinuationToken (absent when the listing is exhausted). Used by the
   * inbound-mail sweep to reconcile R2-buffered messages.
   */
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

  /** GET `key`: returns the raw bytes, or null when the object does not exist. */
  async getObject(key: string): Promise<Uint8Array | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3")
    const client = await this.getClient()
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      if (!res.Body) return null
      // v3 SdkStream helper: collect the streaming body into a single byte array.
      const bytes = await res.Body.transformToByteArray()
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "R2 getObject failed", { cause: err })
    }
  }

  /** Lazily build (and memoize) the S3 client pointed at the account R2 endpoint. */
  private async getClient(): Promise<S3Client> {
    if (!this.client) {
      const { S3Client: S3ClientCtor } = await import("@aws-sdk/client-s3")
      this.client = new S3ClientCtor({
        region: "auto",
        endpoint: `https://${this.config.accountId}.r2.cloudflarestorage.com`,
        // Pin path-style so the bucket is a path segment, not a host subdomain (see file header).
        forcePathStyle: true,
        // The v3 SDK defaults to "WHEN_SUPPORTED", which bakes an x-amz-checksum-crc32 (computed over an
        // EMPTY body at signing time) into PRESIGNED PUT URLs. A non-AWS client (mobile/web) doing a raw
        // HTTP PUT of the real bytes then fails R2's checksum check. "WHEN_REQUIRED" disables that
        // auto-checksum for PutObject so the presigned URL works for any plain HTTP client. R2 still
        // verifies our signed Content-Length/Content-Type, and the worker re-hashes the real bytes.
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

/** Join a base URL and an object key into a single URL with exactly one slash between them. */
function joinUrl(base: string, key: string): string {
  const trimmedBase = base.replace(/\/+$/, "")
  const trimmedKey = key.replace(/^\/+/, "")
  return `${trimmedBase}/${trimmedKey}`
}

/**
 * Ensure a base URL has an explicit scheme so it joins into an ABSOLUTE url, not a page-relative one.
 * A value already starting with http(s):// is returned unchanged; otherwise https:// is prepended (any
 * leading slashes, e.g. a protocol-relative "//cdn..." , are stripped first). This guards the common
 * R2_PUBLIC_BASE misconfig "cdn.civfix.org" (no scheme), which the browser would otherwise resolve
 * against the current page path.
 */
function ensureScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base.replace(/^\/+/, "")}`
}

/**
 * True when an S3/R2 error means "object not found". The SDK surfaces this as a NotFound/NoSuchKey
 * name or a 404 status on the HTTP metadata; we check both so head() returns null rather than throwing.
 */
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
