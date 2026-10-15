import { MEDIA_GET_URL_TTL_SEC, MEDIA_PRIVATE_GET_URL_TTL_SEC } from "../media-intake-service.js"

export const MEDIA_CLAIM_WINDOW_SEC = 6 * 60 * 60

export interface EventMediaStorage {
  presignGet(key: string, ttlSec: number, opts?: { forceSigned?: boolean }): Promise<string>
}

export type EventMediaPresigner = (key: string, opts: { forceSigned: boolean }) => Promise<string>

export function makeEventMediaPresigner(storage: EventMediaStorage): EventMediaPresigner {
  return (key, opts) =>
    opts.forceSigned
      ? storage.presignGet(key, MEDIA_PRIVATE_GET_URL_TTL_SEC, { forceSigned: true })
      : storage.presignGet(key, MEDIA_GET_URL_TTL_SEC)
}
