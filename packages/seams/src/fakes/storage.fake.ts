import type {
  Storage,
  PresignPutOptions,
  PresignPutResult,
  StorageHead,
  StoragePutMeta,
  StorageListOptions,
  StorageListResult,
} from "../interfaces/storage.js"

interface StoredObject {
  bytes: Uint8Array
  contentType: string
  contentDisposition?: string
}

/**
 * In-memory Storage. presignPut returns a `memory://<key>` URL; the body itself is not transferred
 * via the presigned URL in this fake, but put/head/delete operate on the same Map so tests can
 * round-trip by calling put() directly.
 */
export class FakeStorage implements Storage {
  readonly objects = new Map<string, StoredObject>()

  presignPut(key: string, opts: PresignPutOptions): Promise<PresignPutResult> {
    return Promise.resolve({
      url: `memory://${key}`,
      headers: {
        "content-type": opts.contentType,
        "content-length": String(opts.byteSize),
      },
    })
  }

  presignGet(key: string, _ttlSec: number): Promise<string> {
    return Promise.resolve(`memory://${key}`)
  }

  head(key: string): Promise<StorageHead | null> {
    const obj = this.objects.get(key)
    if (!obj) return Promise.resolve(null)
    return Promise.resolve({
      size: obj.bytes.byteLength,
      contentType: obj.contentType,
      // Mirrors R2Storage.head(), which maps R2's ContentDisposition response header, so a route
      // test asserting the stored disposition behaves the same against the fake and against prod.
      ...(obj.contentDisposition !== undefined
        ? { contentDisposition: obj.contentDisposition }
        : {}),
    })
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key)
    return Promise.resolve()
  }

  put(key: string, body: Uint8Array, meta?: StoragePutMeta): Promise<void> {
    this.objects.set(key, {
      bytes: body,
      contentType: meta?.contentType ?? "application/octet-stream",
      ...(meta?.contentDisposition !== undefined
        ? { contentDisposition: meta.contentDisposition }
        : {}),
    })
    return Promise.resolve()
  }

  /**
   * Deterministic prefix listing. Keys are sorted and paginated lexically; the page's last key is the
   * opaque cursor (the next page starts strictly after it), so the fake mirrors R2's keyset pagination.
   */
  list(prefix: string, opts?: StorageListOptions): Promise<StorageListResult> {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const start = opts?.cursor ? all.findIndex((k) => k > opts.cursor!) : 0
    const from = start < 0 ? all.length : start
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 1000
    const page = all.slice(from, from + limit)
    const hasMore = from + limit < all.length && page.length > 0
    const next = hasMore ? page[page.length - 1] : undefined
    return Promise.resolve(next !== undefined ? { keys: page, cursor: next } : { keys: page })
  }

  getObject(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key)?.bytes ?? null)
  }

  /** Test helper: read raw bytes back out of the store. */
  get(key: string): Uint8Array | null {
    return this.objects.get(key)?.bytes ?? null
  }

  /** Test helper: clear everything. */
  reset(): void {
    this.objects.clear()
  }
}
