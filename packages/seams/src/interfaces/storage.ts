/**
 * Object storage behind a vendor-neutral interface (R2 / S3 / local in prod or tests).
 */

export interface PresignPutOptions {
  contentType: string
  byteSize: number
}

export interface PresignPutResult {
  url: string
  headers: Record<string, string>
}

export interface StorageHead {
  size: number
  contentType: string
  /** RFC 6266 Content-Disposition as stored; absent when the object carries none. */
  contentDisposition?: string
}

export interface StoragePutMeta {
  contentType?: string
  /** RFC 6266 Content-Disposition stored on the object; every presigned GET replays it. */
  contentDisposition?: string
}

export interface StorageListOptions {
  /** Opaque continuation token from a prior page's `cursor`; omit for the first page. */
  cursor?: string
  /** Max keys per page (provider may return fewer). Defaults to the provider default (~1000). */
  limit?: number
}

export interface StorageListResult {
  /** Full object keys (including the queried prefix). */
  keys: string[]
  /** Continuation token for the next page; absent when the listing is exhausted. */
  cursor?: string
}

export interface Storage {
  presignPut(key: string, opts: PresignPutOptions): Promise<PresignPutResult>
  presignGet(key: string, ttlSec: number): Promise<string>
  head(key: string): Promise<StorageHead | null>
  delete(key: string): Promise<void>
  put(key: string, body: Uint8Array | Buffer, meta?: StoragePutMeta): Promise<void>
  /**
   * List object keys under a prefix, paginated. Used by the inbound-mail boot/cron sweep to reconcile
   * R2-buffered messages the backend may have missed while offline.
   */
  list(prefix: string, opts?: StorageListOptions): Promise<StorageListResult>
  /** Fetch an object's raw bytes, or null when the key does not exist. */
  getObject(key: string): Promise<Uint8Array | null>
}
