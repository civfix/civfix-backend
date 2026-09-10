import { randomUUID } from "node:crypto"
import type { Queryable } from "../../src/db/client.js"

const SERVED_PREFIX = "processed/"

export type SeedMediaKind = "image" | "video"
export type SeedMediaStatus = "validating" | "ready" | "rejected" | "held"

export function servedKeyFor(r2Key: string): string {
  return `${SERVED_PREFIX}${r2Key}`
}

export interface SeedMediaOptions {
  id?: string
  uploadId?: string
  r2Key?: string
  thumbKey?: string | null
  servedKey?: string | null
  kind?: SeedMediaKind
  status?: SeedMediaStatus
  purpose?: string
  byteSize?: number | null
  width?: number | null
  height?: number | null
  reportId?: string | null
  postId?: string | null
  chatMessageId?: string | null
  finalizedAt?: Date | null
  createdAt?: Date
}

export interface SeededMedia {
  id: string
  uploadId: string
  r2Key: string
  servedKey: string | null
  thumbKey: string | null
}

export async function seedMediaAsset(
  sql: Queryable,
  over: SeedMediaOptions = {},
): Promise<SeededMedia> {
  const uploadId = over.uploadId ?? randomUUID()
  const r2Key = over.r2Key ?? `uploads/2026/01/${uploadId}`
  const status: SeedMediaStatus = over.status ?? "ready"
  const thumbKey = over.thumbKey ?? null
  const servedKey =
    over.servedKey !== undefined ? over.servedKey : status === "ready" ? servedKeyFor(r2Key) : null

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO media_assets (
      id, upload_id, kind, r2_key, served_key, thumb_key, status, purpose,
      byte_size, width, height, report_id, post_id, chat_message_id, finalized_at, created_at
    )
    VALUES (
      ${over.id ?? randomUUID()}, ${uploadId}, ${over.kind ?? "image"}, ${r2Key}, ${servedKey},
      ${thumbKey}, ${status}, ${over.purpose ?? "report"},
      ${over.byteSize ?? null}, ${over.width ?? null}, ${over.height ?? null},
      ${over.reportId ?? null}, ${over.postId ?? null}, ${over.chatMessageId ?? null},
      ${over.finalizedAt ?? null}, ${over.createdAt ?? new Date()}
    )
    RETURNING id
  `
  return { id: row!.id, uploadId, r2Key, servedKey, thumbKey }
}

export async function publishMediaAsReady(sql: Queryable, mediaId: string): Promise<string> {
  const [row] = await sql<{ served_key: string }[]>`
    UPDATE media_assets
    SET status = 'ready', served_key = ${SERVED_PREFIX}::text || r2_key
    WHERE id = ${mediaId}
    RETURNING served_key
  `
  if (!row) throw new Error(`publishMediaAsReady: no media_assets row ${mediaId}`)
  return row.served_key
}
