import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createReadStream, type Dirent } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import type { Readable } from "node:stream"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { AppError, ErrorCode } from "@civfix/shared"
import type { StorageHeadWithEtag } from "../services/media-etag.js"
import type {
  PresignPutOptions,
  PresignPutResult,
  Storage,
  StorageListOptions,
  StorageListResult,
  StoragePutMeta,
} from "@civfix/shared/interfaces"

export const LOCAL_STORAGE_ROUTE_PREFIX = "/_local-storage"
const LOCAL_STORAGE_PUT_TTL_SEC = 15 * 60
const LOCAL_STORAGE_DEFAULT_GET_TTL_SEC = 15 * 60
export const LOCAL_STORAGE_DEV_SIGNING_KEY =
  "dev-insecure-local-storage-signing-key-do-not-use-in-prod"

export type LocalStorageNamespace = "media" | "inbound"

const OBJECT_KEY_MAX_LENGTH = 512
const OBJECT_KEY_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9._-]*"
const OBJECT_KEY_PATTERN = new RegExp(`^${OBJECT_KEY_SEGMENT}(?:/${OBJECT_KEY_SEGMENT})*$`)
export const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_CONTENT_TYPE = "application/octet-stream"
const DEFAULT_LIST_LIMIT = 1000
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const TRAILING_SLASHES_RE = /\/+$/
const STAGED_FILE_RANDOM_BYTES = 16
const MS_PER_SECOND = 1000

export type SignatureVerdict = "valid" | "expired" | "invalid"

export interface SignedObjectRequest {
  method: "GET" | "PUT"
  key: string
  expiresAtSec: number
  contentType: string
  byteSize: number
  signature: string
}

export interface LocalDiskStorageConfig {
  rootDirectory: string
  namespace: LocalStorageNamespace
  publicApiUrl: string
  signingKey: string
  nodeEnv: string
}

interface ObjectMetadata {
  contentType: string
  contentDisposition?: string
  etag?: string
}

export interface ByteRange {
  start: number
  end: number
}

export function isSafeObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > OBJECT_KEY_MAX_LENGTH) return false
  return OBJECT_KEY_PATTERN.test(key)
}

export class LocalDiskStorage implements Storage {
  readonly namespace: LocalStorageNamespace
  private readonly objectsRoot: string
  private readonly metaRoot: string
  private readonly tempRoot: string
  private readonly baseUrl: string
  private readonly signingKey: string

  constructor(config: LocalDiskStorageConfig) {
    const rootDirectory = assertUsableRoot(config)
    this.baseUrl = normalizeBaseUrl(config.publicApiUrl)
    if (config.signingKey === LOCAL_STORAGE_DEV_SIGNING_KEY && !isLoopbackUrl(this.baseUrl)) {
      throw new Error(
        `LOCAL_STORAGE_SIGNING_KEY must be set explicitly when PUBLIC_API_URL (${this.baseUrl}) is ` +
          "reachable off this machine: the built-in default is a published constant, so anyone on the " +
          "network could mint URLs that read and overwrite stored objects.",
      )
    }
    const namespaceRoot = join(resolve(rootDirectory), config.namespace)
    this.namespace = config.namespace
    this.objectsRoot = join(namespaceRoot, "objects")
    this.metaRoot = join(namespaceRoot, "meta")
    this.tempRoot = join(namespaceRoot, "tmp")
    this.signingKey = config.signingKey
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignPutResult> {
    assertSafeKey(key)
    const expiresAtSec = nowSec() + LOCAL_STORAGE_PUT_TTL_SEC
    const signature = this.sign({
      method: "PUT",
      key,
      expiresAtSec,
      contentType: opts.contentType,
      byteSize: opts.byteSize,
    })
    const query = new URLSearchParams({
      exp: String(expiresAtSec),
      ct: opts.contentType,
      sz: String(opts.byteSize),
      sig: signature,
    })
    return {
      url: `${this.objectUrl(key)}?${query.toString()}`,
      headers: {
        "content-type": opts.contentType,
        "content-length": String(opts.byteSize),
      },
    }
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    assertSafeKey(key)
    const ttl = ttlSec > 0 ? ttlSec : LOCAL_STORAGE_DEFAULT_GET_TTL_SEC
    const expiresAtSec = nowSec() + ttl
    const signature = this.sign({
      method: "GET",
      key,
      expiresAtSec,
      contentType: "",
      byteSize: 0,
    })
    const query = new URLSearchParams({ exp: String(expiresAtSec), sig: signature })
    return `${this.objectUrl(key)}?${query.toString()}`
  }

  async head(key: string): Promise<StorageHeadWithEtag | null> {
    assertSafeKey(key)
    let size: number
    try {
      const stats = await stat(this.objectPath(key))
      if (!stats.isFile()) return null
      size = stats.size
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "local storage head failed", { cause: err })
    }
    const meta = await this.readMetadata(key)
    const etag = meta?.etag ?? (await this.hashObject(key))
    return {
      size,
      contentType: meta?.contentType ?? DEFAULT_CONTENT_TYPE,
      ...(meta?.contentDisposition !== undefined
        ? { contentDisposition: meta.contentDisposition }
        : {}),
      ...(etag !== null ? { etag } : {}),
    }
  }

  private async hashObject(key: string): Promise<string | null> {
    try {
      return contentEtag(await readFile(this.objectPath(key)))
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "local storage head failed", { cause: err })
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    try {
      await rm(this.objectPath(key), { force: true })
      await rm(this.metaPath(key), { force: true })
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "local storage delete failed", { cause: err })
    }
  }

  async put(key: string, body: Uint8Array | Buffer, meta?: StoragePutMeta): Promise<void> {
    assertSafeKey(key)
    const metadata: ObjectMetadata = {
      contentType: meta?.contentType ?? DEFAULT_CONTENT_TYPE,
      ...(meta?.contentDisposition !== undefined
        ? { contentDisposition: meta.contentDisposition }
        : {}),
      etag: contentEtag(body),
    }
    try {
      await this.writeAtomic(this.objectPath(key), Buffer.from(body))
      await this.writeAtomic(this.metaPath(key), Buffer.from(JSON.stringify(metadata), "utf8"))
    } catch (err) {
      throw new AppError(ErrorCode.INTERNAL, "local storage put failed", { cause: err })
    }
  }

  async list(prefix: string, opts?: StorageListOptions): Promise<StorageListResult> {
    const searchRoot = this.listSearchRoot(prefix)
    if (searchRoot === null) return { keys: [] }
    let entries: Dirent<string>[]
    try {
      entries = await readdir(searchRoot.absolutePath, { recursive: true, withFileTypes: true })
    } catch (err) {
      if (isNotFound(err)) return { keys: [] }
      throw new AppError(ErrorCode.INTERNAL, "local storage list failed", { cause: err })
    }
    const cursor = opts?.cursor
    const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_LIST_LIMIT
    const matching = entries
      .filter((entry) => entry.isFile())
      .map((entry) => toObjectKey(this.objectsRoot, join(entry.parentPath, entry.name)))
      .filter((key) => isSafeObjectKey(key) && key.startsWith(prefix))
      .filter((key) => cursor === undefined || key > cursor)
      .sort()
    const keys = matching.slice(0, limit)
    const last = keys[keys.length - 1]
    return matching.length > keys.length && last !== undefined ? { keys, cursor: last } : { keys }
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    assertSafeKey(key)
    try {
      return new Uint8Array(await readFile(this.objectPath(key)))
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "local storage getObject failed", { cause: err })
    }
  }

  openObjectStream(key: string, range?: ByteRange): Readable {
    assertSafeKey(key)
    return createReadStream(
      this.objectPath(key),
      range === undefined ? undefined : { start: range.start, end: range.end },
    )
  }

  verifySignedRequest(request: SignedObjectRequest, atSec: number): SignatureVerdict {
    if (!isSafeObjectKey(request.key)) return "invalid"
    if (!Number.isSafeInteger(request.expiresAtSec)) return "invalid"
    if (!SIGNATURE_PATTERN.test(request.signature)) return "invalid"
    const expected = Buffer.from(this.sign(request), "hex")
    const provided = Buffer.from(request.signature, "hex")
    if (!timingSafeEqual(expected, provided)) return "invalid"
    return request.expiresAtSec <= atSec ? "expired" : "valid"
  }

  private sign(grant: Omit<SignedObjectRequest, "signature">): string {
    const payload = [
      this.namespace,
      grant.method,
      grant.key,
      String(grant.expiresAtSec),
      grant.contentType,
      String(grant.byteSize),
    ].join("\n")
    return createHmac("sha256", this.signingKey).update(payload, "utf8").digest("hex")
  }

  private objectUrl(key: string): string {
    const path = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    return `${this.baseUrl}${LOCAL_STORAGE_ROUTE_PREFIX}/${this.namespace}/${path}`
  }

  private objectPath(key: string): string {
    return resolveWithin(this.objectsRoot, key)
  }

  private metaPath(key: string): string {
    return `${resolveWithin(this.metaRoot, key)}.json`
  }

  private listSearchRoot(prefix: string): { absolutePath: string } | null {
    const lastSlash = prefix.lastIndexOf("/")
    if (lastSlash <= 0) return { absolutePath: this.objectsRoot }
    const directoryPrefix = prefix.slice(0, lastSlash)
    if (!isSafeObjectKey(directoryPrefix)) return null
    return { absolutePath: resolveWithin(this.objectsRoot, directoryPrefix) }
  }

  private async readMetadata(key: string): Promise<ObjectMetadata | null> {
    let raw: string
    try {
      raw = await readFile(this.metaPath(key), "utf8")
    } catch (err) {
      if (isNotFound(err)) return null
      throw new AppError(ErrorCode.INTERNAL, "local storage metadata read failed", { cause: err })
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const { contentType, contentDisposition, etag } = parsed as Record<string, unknown>
    return {
      contentType: typeof contentType === "string" ? contentType : DEFAULT_CONTENT_TYPE,
      ...(typeof contentDisposition === "string" ? { contentDisposition } : {}),
      ...(typeof etag === "string" && etag.length > 0 ? { etag } : {}),
    }
  }

  private async writeAtomic(target: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    await mkdir(this.tempRoot, { recursive: true })
    const staged = join(
      this.tempRoot,
      `${randomBytes(STAGED_FILE_RANDOM_BYTES).toString("hex")}.part`,
    )
    try {
      await writeFile(staged, bytes)
      await rename(staged, target)
    } catch (err) {
      await rm(staged, { force: true }).catch(() => {})
      throw err
    }
  }
}

function assertUsableRoot(config: LocalDiskStorageConfig): string {
  if (config.nodeEnv === "production") {
    throw new Error(
      "LOCAL_STORAGE_DIR selects the local-disk storage driver, which serves objects from the API " +
        "process and mounts development-only PUT/GET routes. It is refused in production; " +
        "configure R2 (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET) instead.",
    )
  }
  const rootDirectory = config.rootDirectory.trim()
  if (rootDirectory.length === 0) {
    throw new Error("LOCAL_STORAGE_DIR must name a directory for the local-disk storage driver")
  }
  if (!isAbsolute(rootDirectory)) {
    throw new Error(
      `LOCAL_STORAGE_DIR must be an ABSOLUTE path, got "${rootDirectory}". The API service ` +
        "(services/api) and the media-worker service (services/media-worker) run from different " +
        "working directories, so a relative path resolves against each process's own cwd and gives " +
        "them two divergent storage trees, so the worker would write thumbnails the API then serves as " +
        "404s. Set the SAME absolute path in LOCAL_STORAGE_DIR for both services.",
    )
  }
  if (config.signingKey.length === 0) {
    throw new Error("LOCAL_STORAGE_SIGNING_KEY must not be empty")
  }
  return rootDirectory
}

function contentEtag(body: Uint8Array | Buffer): string {
  return createHash("sha256").update(body).digest("hex")
}

function assertSafeKey(key: string): void {
  if (!isSafeObjectKey(key)) {
    throw new AppError(ErrorCode.INTERNAL, "local storage key is not a safe object key")
  }
}

function resolveWithin(root: string, key: string): string {
  const full = resolve(root, key)
  if (!full.startsWith(root + sep)) {
    throw new AppError(ErrorCode.INTERNAL, "local storage key escapes the storage root")
  }
  return full
}

function toObjectKey(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/")
}

function normalizeBaseUrl(publicApiUrl: string): string {
  const trimmed = publicApiUrl.trim()
  if (trimmed.length === 0) {
    throw new Error(
      "PUBLIC_API_URL is required by the local-disk storage driver: presigned URLs must be absolute " +
        "and reachable from the browser and the media worker (e.g. http://localhost:8080)",
    )
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`PUBLIC_API_URL is not an absolute URL: ${trimmed}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_API_URL must be http(s): ${trimmed}`)
  }
  return trimmed.replace(TRAILING_SLASHES_RE, "")
}

function isLoopbackUrl(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || LOOPBACK_IPV4_PATTERN.test(host)
}

export function nowSec(): number {
  return Math.floor(Date.now() / MS_PER_SECOND)
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT"
}
