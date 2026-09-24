import { MEDIA_GET_URL_TTL_SEC, MEDIA_PRIVATE_GET_URL_TTL_SEC } from "./media-intake-service.js"

export type PresignMedia = (
  r2Key: string,
  thumbKey: string | null,
) => Promise<{ url: string; thumbUrl?: string }>

// A structural slice of the storage seam: importing Container or the Storage interface here would
// create an import cycle through di.ts.
//
// `opts.forceSigned` is optional on purpose: an adapter that has no public-CDN mode (FakeStorage) simply
// declares two parameters and stays assignable here, while R2Storage honors it (adapters/storage.r2.ts).
interface PresignStorage {
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string>
}

export function makeMediaPresigner(storage: PresignStorage): PresignMedia {
  return async (r2Key, thumbKey) => {
    const url = await storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

/**
 * Presigner for PRIVATE media (chat/DM attachments, an owner's own held/unlisted report media,
 * not-yet-committed uploads). Two differences from the public presigner, both load-bearing:
 *
 *   - `forceSigned: true`: never emit a public CDN URL. A CDN URL is unsigned and permanent, so a DM
 *     attachment served through one stays world-readable to anyone who ever saw the link, and no later
 *     unlist / delete / block can revoke it.
 *   - a much shorter TTL, so a leaked URL expires in minutes rather than an hour.
 */
export function makePrivateMediaPresigner(storage: PresignStorage): PresignMedia {
  return async (r2Key, thumbKey) => {
    const url = await storage.presignGet(r2Key, MEDIA_PRIVATE_GET_URL_TTL_SEC, {
      forceSigned: true,
    })
    if (thumbKey === null) return { url }
    const thumbUrl = await storage.presignGet(thumbKey, MEDIA_PRIVATE_GET_URL_TTL_SEC, {
      forceSigned: true,
    })
    return { url, thumbUrl }
  }
}

export const PACKET_MEDIA_URL_TTL_SEC = 7 * 24 * 60 * 60

export type PresignPacketMedia = (r2Key: string, publiclyVisible: boolean) => Promise<string>

export function makePacketMediaPresigner(storage: PresignStorage): PresignPacketMedia {
  return (r2Key, publiclyVisible) =>
    storage.presignGet(r2Key, PACKET_MEDIA_URL_TTL_SEC, { forceSigned: !publiclyVisible })
}

// Bounds concurrent SigV4 signings / R2 ops per page.
export const PRESIGN_CONCURRENCY = 8

// Order-preserving, used instead of `Promise.all(arr.map(fn))` on presign/sub-query fan-outs so a large
// page can't fire hundreds of concurrent R2/DB ops.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  const cap = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const workers = Array.from({ length: cap }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T, i)
    }
  })
  await Promise.all(workers)
  return results
}
