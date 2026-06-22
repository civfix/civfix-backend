import type {
  DiscussionAuthorDTO,
  DiscussionMessageDTO,
  MediaDTO,
  ReactionSummaryDTO,
} from "@civfix/shared"
import { publicAuthorIdentity } from "./public-author.js"
import { jurisdictionHandle } from "./discussion-mentions.js"
import {
  DISCUSSION_DEFAULT_LIMIT,
  type DiscussionAuthorView,
  type DiscussionMediaView,
  type DiscussionMessageRecord,
  type DiscussionReactionView,
} from "./discussion-types.js"

type PresignMedia = (
  r2Key: string,
  thumbKey: string | null,
) => Promise<{ url: string; thumbUrl?: string }>

// Resolve a jurisdiction's effective handle: the stored column, else derived from the name (may be null).
export function effectiveJurisdictionHandle(j: { handle: string | null; name: string }): string | null {
  return j.handle ?? jurisdictionHandle(j.name)
}

// The handle a client renders for a @city mention: the effective handle, falling back to the geoid when
// neither a stored nor a derivable handle exists (so the token always shows something).
function displayCityHandle(mention: { handle: string | null; name: string; geoid: string }): string {
  return effectiveJurisdictionHandle(mention) ?? mention.geoid
}

// Only `ready` media reaches here (held/rejected/validating are hidden), matching the report read.
export async function toMediaDTO(view: DiscussionMediaView, presign: PresignMedia): Promise<MediaDTO> {
  const { url, thumbUrl } = await presign(view.r2Key, view.thumbKey)
  return {
    id: view.id,
    kind: view.kind,
    codec: view.codec,
    url,
    ...(thumbUrl !== undefined ? { thumbUrl } : {}),
    width: view.width,
    height: view.height,
    status: view.status,
  }
}

// Project a resolved author into the wire DTO. A tombstoned ACCOUNT renders DELETED_USER_LABEL with no
// handle + deleted:true (clients drop the profile link); the avatar monogram seed stays on the stable id.
// Distinct from a deleted MESSAGE (toMessageDTO nulls the author entirely for a removed comment).
export function toAuthorDTO(view: DiscussionAuthorView): DiscussionAuthorDTO {
  const author = publicAuthorIdentity({
    id: view.id,
    displayName: view.displayName,
    handle: view.handle,
    avatarUrl: view.avatarUrl,
    deletedAt: view.deletedAt,
  })
  return {
    id: view.id,
    displayName: author.name,
    handle: author.handle,
    avatar: author.avatar,
    // publicAuthorIdentity drops the photo for a deleted author; carry it through for a live one.
    ...(author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
    ...(author.deleted ? { deleted: true } : {}),
  }
}

export function toReactionDTO(view: DiscussionReactionView): ReactionSummaryDTO {
  return { emoji: view.emoji, count: view.count, mine: view.mine }
}

// Assemble a full DiscussionMessageDTO, presigning the (bounded) ready attachments. A soft-deleted
// (tombstoned) record renders a null author + blanked body + no attachments so a moderated message cannot
// leak its original content, while its reply subtree + reaction counts survive. `presignAttachments`
// bounds the per-message presign fan-out (passed in by the service so the concurrency cap is one place).
export async function toMessageDTO(
  record: DiscussionMessageRecord,
  viewerUserId: string | null,
  presignAttachments: (views: DiscussionMediaView[]) => Promise<MediaDTO[]>,
): Promise<DiscussionMessageDTO> {
  const tombstoned = record.deletedAt !== null
  const readyMedia = tombstoned ? [] : record.attachments.filter((m) => m.status === "ready")
  const attachments = await presignAttachments(readyMedia)
  const mine = viewerUserId !== null && record.authorUserId === viewerUserId
  const cityMention =
    record.mention !== null
      ? {
          handle: displayCityHandle(record.mention),
          geoid: record.mention.geoid,
          name: record.mention.name,
          forwarded: record.mention.forwarded,
        }
      : null
  return {
    id: record.id,
    reportId: record.reportId,
    parentId: record.parentId,
    author: tombstoned || record.author === null ? null : toAuthorDTO(record.author),
    body: tombstoned ? "" : record.body,
    attachments,
    reactions: record.reactions.map(toReactionDTO),
    mentions: tombstoned ? [] : record.userMentions,
    replyCount: record.replyCount,
    cityMention,
    forwardedToCity: record.forwardedToCity,
    createdAt: record.createdAt.toISOString(),
    ...(record.editedAt !== null ? { editedAt: record.editedAt.toISOString() } : {}),
    ...(record.deletedAt !== null ? { deletedAt: record.deletedAt.toISOString() } : {}),
    mine,
  }
}

// Clamp a requested page limit into [1, 50], defaulting to DISCUSSION_DEFAULT_LIMIT when undefined/<=0.
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DISCUSSION_DEFAULT_LIMIT
  return Math.min(Math.floor(limit), 50)
}
