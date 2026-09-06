import type { Queryable } from "../db/client.js"

export const MEDIA_BINDING_RELATIONS = [
  "users.avatar_media_id",
  "chat_groups.avatar_media_id",
  "organizations.logo_media_id",
  "cleanups.cover_media_id",
  "cleanups.gallery_media_ids",
  "cleanup_page_media.media_id",
] as const

export const MEDIA_BINDING_COLUMNS = ["report_id", "chat_message_id", "post_id"] as const

export function mediaBoundElsewhere(tag: Queryable, exceptCleanupId: string | null) {
  return tag`
    EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = media_assets.id)
    OR EXISTS (SELECT 1 FROM chat_groups cg WHERE cg.avatar_media_id = media_assets.id)
    OR EXISTS (SELECT 1 FROM organizations og WHERE og.logo_media_id = media_assets.id)
    OR EXISTS (
      SELECT 1 FROM cleanups oc
       WHERE (
               oc.cover_media_id = media_assets.id
               OR oc.gallery_media_ids @> ARRAY[media_assets.id]
             )
         AND (${exceptCleanupId}::uuid IS NULL OR oc.id <> ${exceptCleanupId}::uuid)
    )
    OR EXISTS (
      SELECT 1 FROM cleanup_page_media pm
       WHERE pm.media_id = media_assets.id
         AND (${exceptCleanupId}::uuid IS NULL OR pm.cleanup_id <> ${exceptCleanupId}::uuid)
    )
  `
}

export function eventsBindingMedia(tag: Queryable, mediaId: string) {
  return tag`
    SELECT c.id, c.visibility, c.organization_id
      FROM cleanups c
     WHERE c.cover_media_id = ${mediaId}::uuid
        OR c.gallery_media_ids @> ARRAY[${mediaId}::uuid]
        OR EXISTS (
             SELECT 1 FROM cleanup_page_media pm
              WHERE pm.cleanup_id = c.id AND pm.media_id = ${mediaId}::uuid
           )
  `
}

export function mediaBoundToCleanup(tag: Queryable, cleanupId: string) {
  return tag`
    EXISTS (
      SELECT 1 FROM cleanups cur
       WHERE cur.id = ${cleanupId}::uuid
         AND (
               cur.cover_media_id = media_assets.id
               OR cur.gallery_media_ids @> ARRAY[media_assets.id]
             )
    )
    OR EXISTS (
      SELECT 1 FROM cleanup_page_media pm
       WHERE pm.cleanup_id = ${cleanupId}::uuid AND pm.media_id = media_assets.id
    )
  `
}
