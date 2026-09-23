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
import { posts } from "./posts.js"
import { reports } from "./reports.js"
import type { MEDIA_KIND_VALUES, MEDIA_STATUS_VALUES } from "./types.js"
import type { MEDIA_PURPOSE_VALUES } from "./types-host.js"

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
    chatMessageId: uuid("chat_message_id"),
    chatMessageCreatedAt: timestamp("chat_message_created_at", { withTimezone: true }),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
    uploadId: uuid("upload_id").notNull(),
    kind: text("kind").$type<MediaKind>().notNull(),
    codec: text("codec"),
    r2Key: text("r2_key").notNull(),
    servedKey: text("served_key"),
    thumbKey: text("thumb_key"),
    status: text("status").$type<MediaStatus>().notNull(),
    purpose: text("purpose").$type<MediaPurpose>().notNull().default("report"),
    width: integer("width"),
    height: integer("height"),
    byteSize: bigint("byte_size", { mode: "number" }),
    phash: text("phash"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    uploadEtag: text("upload_etag"),
    stuckCheckedAt: timestamp("stuck_checked_at", { withTimezone: true }),
    stuckCheckCount: integer("stuck_check_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("media_assets_upload_id_key").on(t.uploadId),
    index("media_assets_report_idx").on(t.reportId),
    index("media_assets_chat_message_idx")
      .on(t.chatMessageId)
      .where(sql`${t.chatMessageId} is not null`),
    index("media_assets_post_idx")
      .on(t.postId)
      .where(sql`${t.postId} is not null`),
    index("media_assets_status_idx").on(t.status),
    index("media_assets_stuck_sweep_idx")
      .on(sql`${t.stuckCheckedAt} asc nulls first`, t.finalizedAt)
      .where(sql`${t.status} = 'validating' and ${t.finalizedAt} is not null`),
    index("media_assets_phash_idx").on(t.phash),
    index("media_assets_r2_key_idx").on(t.r2Key),
  ],
)

export type MediaAssetRow = typeof mediaAssets.$inferSelect
export type NewMediaAssetRow = typeof mediaAssets.$inferInsert
