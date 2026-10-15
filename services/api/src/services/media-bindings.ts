import type { Queryable } from "../db/client.js"
import { MEDIA_CLAIM_WINDOW_SEC } from "./host/event-media.js"

export const MEDIA_BINDING_RELATIONS = [
  "users.avatar_media_id",
  "chat_groups.avatar_media_id",
  "organizations.logo_media_id",
  "cleanups.cover_media_id",
  "cleanups.gallery_media_ids",
  "cleanup_page_media.media_id",
] as const

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

// Only report-purpose rows can be attached by uploadId, and the purpose check alone is not enough:
// avatars keep purpose 'report' while users.avatar_media_id and chat_groups.avatar_media_id bind them.
export function claimableAsReportMedia(tag: Queryable, uploaders: readonly string[]) {
  return tag`purpose = 'report' AND NOT (${mediaBoundElsewhere(tag, null)}) AND (${uploadedByClaimant(tag, uploaders)})`
}

// createUpload stores every upload with the default purpose 'report' and only a binding re-purposes it,
// so an author's fresh post or chat upload sits in exactly the pool a report may claim. An UPDATE's
// WHERE reads the row before its SET, so the post path's purpose = 'post' cannot satisfy this check.
export function claimableAsAttachment(tag: Queryable, uploaders: readonly string[]) {
  return claimableAsReportMedia(tag, uploaders)
}

// The uploadId is readable from every served URL, so it proves nothing: only the account or anon session
// that created the upload may bind it. A NULL uploader predates attribution; the window every claim
// shares with the event and logo claims is what ages those rows out.
export function uploadedByClaimant(tag: Queryable, uploaders: readonly string[]) {
  return tag`media_assets.created_at > now() - make_interval(secs => ${MEDIA_CLAIM_WINDOW_SEC})
    AND (media_assets.uploader IN ${tag([...uploaders])} OR media_assets.uploader IS NULL)`
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
