/**
 * media_assets: image/video attachments for a report.
 *
 * `upload_id` is the client-issued UUID for the presigned-upload handshake and is UNIQUE so a finalize
 * is idempotent. `report_id` is nullable and ON DELETE SET NULL so deleting a report orphans (rather
 * than deletes) its media row for moderation/audit. `r2_key`/`thumb_key` are object-store keys.
 * `byte_size` is bigint (mode number: file sizes are well within the 2^53 safe-integer range).
 * `phash` is a perceptual hash for near-duplicate detection and is indexed.
 */

import { sql } from "drizzle-orm"
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { reportDiscussionMessages } from "./discussion.js"
import { reports } from "./reports.js"
import type { MEDIA_KIND_VALUES, MEDIA_PURPOSE_VALUES, MEDIA_STATUS_VALUES } from "./types.js"

type MediaKind = (typeof MEDIA_KIND_VALUES)[number]
type MediaStatus = (typeof MEDIA_STATUS_VALUES)[number]
type MediaPurpose = (typeof MEDIA_PURPOSE_VALUES)[number]

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
    // Discussion-message attachment (0017). Additive sibling of report_id; ON DELETE SET NULL orphans
    // (rather than deletes) the media row for moderation/audit. Do NOT overload report_id.
    discussionMessageId: uuid("discussion_message_id").references(
      () => reportDiscussionMessages.id,
      { onDelete: "set null" },
    ),
    uploadId: uuid("upload_id").notNull(),
    kind: text("kind").$type<MediaKind>().notNull(),
    codec: text("codec"),
    r2Key: text("r2_key").notNull(),
    thumbKey: text("thumb_key"),
    status: text("status").$type<MediaStatus>().notNull(),
    // What this asset is FOR. 'report' (default) is a public report attachment served by GET /media/:id;
    // 'verification' is a sensitive user-verification document that the public serve path refuses (it is
    // reachable only via the authenticated owner / admin signed-URL routes). Canonical DDL: 0016.
    purpose: text("purpose").$type<MediaPurpose>().notNull().default("report"),
    width: integer("width"),
    height: integer("height"),
    byteSize: bigint("byte_size", { mode: "number" }),
    phash: text("phash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("media_assets_upload_id_key").on(t.uploadId),
    index("media_assets_report_idx").on(t.reportId),
    index("media_assets_discussion_message_idx").on(t.discussionMessageId),
    index("media_assets_status_idx").on(t.status),
    index("media_assets_phash_idx").on(t.phash),
  ],
)

export type MediaAssetRow = typeof mediaAssets.$inferSelect
export type NewMediaAssetRow = typeof mediaAssets.$inferInsert
