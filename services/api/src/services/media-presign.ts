import { MEDIA_GET_URL_TTL_SEC } from "./media-intake-service.js"

export type PresignMedia = (
  r2Key: string,
  thumbKey: string | null,
) => Promise<{ url: string; thumbUrl?: string }>

// Structural slice of the storage seam (presigned-GET issuer) so this module pulls in neither Container
// nor the Storage interface — avoids an import cycle through di.ts.
interface PresignStorage {
  presignGet(key: string, ttlSec: number): Promise<string>
}

export function makeMediaPresigner(storage: PresignStorage): PresignMedia {
  return async (r2Key, thumbKey) => {
    const url = await storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url } // images: only url, no thumbnail
    const thumbUrl = await storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}

// Concurrency cap for presign fan-outs (bounds concurrent SigV4 signings / R2 ops per page).
export const PRESIGN_CONCURRENCY = 8

// Bounded-concurrency map preserving input order. Replaces unbounded `Promise.all(arr.map(fn))` on
// presign/sub-query fan-outs so a large page can't fire hundreds of concurrent R2/DB ops.
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
