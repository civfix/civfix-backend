/**
 * makeMediaPresigner - the shared media URL signer used to project a stored media_assets row into a
 * client-facing MediaDTO (a short-lived presigned GET url for the object + its thumbnail).
 *
 * This is the same `(r2Key, thumbKey) -> { url, thumbUrl? }` shape the report + discussion read paths
 * build inline (see discussion.routes.ts `defaultPresign`); extracted here so the chat/DM attachment
 * projection (chat-attachments.drizzle.ts, wired through the chat + dm repos) reuses one definition rather
 * than a fourth copy. `thumbKey === null` ⇒ no thumbnail (images: only `url`).
 *
 * Typed structurally against the storage seam's `presignGet` so it pulls in neither the Container nor the
 * Storage interface (avoids an import cycle through di.ts).
 */
import { MEDIA_GET_URL_TTL_SEC } from "./media-intake-service.js"

/** Presign a media object + optional thumbnail into short-lived GET urls. */
export type PresignMedia = (
  r2Key: string,
  thumbKey: string | null,
) => Promise<{ url: string; thumbUrl?: string }>

/** The slice of the storage seam the presigner needs (a presigned-GET issuer). */
interface PresignStorage {
  presignGet(key: string, ttlSec: number): Promise<string>
}

/** Build the default media presigner over a storage seam (mirrors the report/discussion read paths). */
export function makeMediaPresigner(storage: PresignStorage): PresignMedia {
  return async (r2Key, thumbKey) => {
    const url = await storage.presignGet(r2Key, MEDIA_GET_URL_TTL_SEC)
    if (thumbKey === null) return { url }
    const thumbUrl = await storage.presignGet(thumbKey, MEDIA_GET_URL_TTL_SEC)
    return { url, thumbUrl }
  }
}
