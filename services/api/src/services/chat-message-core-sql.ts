// Room chat and DMs serialize one ChatMessageDTO contract, so the sender projection, the shared DTO
// fields and the page-level loaders live here once: a deleted author then redacts identically in both.

import type {
  ChatMessageDTO,
  ChatMessageKind,
  MediaDTO,
  ReactionSummaryDTO,
  ReplyToDTO,
  UserMentionDTO,
} from "@civfix/shared"
import type { Queryable } from "../db/client.js"
import { publicAuthorIdentity } from "./public-author.js"
import { officialPersonFlag } from "../auth/official-account.js"
import { loadChatReactionsFor } from "./chat-reactions-repository.drizzle.js"
import { loadChatMentionsFor } from "./chat-mentions-repository.drizzle.js"
import { loadChatAttachments } from "./chat-attachments-repository.drizzle.js"
import { replyMapForRows } from "./chat-reply-hydration.js"
import type { ReplyTable } from "./reply-targets-repository.drizzle.js"
import type { PresignMedia } from "./media-presign.js"
import { liveMessageIds } from "./chat-tombstone.js"

export interface MessageCoreRow {
  id: string
  body: string | null
  kind: ChatMessageKind
  created_at: Date
  edited_at: Date | null
  deleted_at: Date | null
  reply_to_id: string | null
  pinned_at: Date | null
  sender_display_name: string | null
  sender_handle: string | null
  sender_bio: string | null
  sender_avatar_url: string | null
  sender_deleted_at: Date | null
}

export interface MessageParts {
  attachments: MediaDTO[]
  reactions: ReactionSummaryDTO[]
  mentions: UserMentionDTO[]
  replyTo: ReplyToDTO | null | undefined
}

export function senderColumns(tag: Queryable) {
  return tag`
    u.display_name AS sender_display_name,
    u.handle AS sender_handle,
    u.bio AS sender_bio,
    u.avatar_url AS sender_avatar_url,
    u.deleted_at AS sender_deleted_at
  `
}

export function messageCoreFields(
  r: MessageCoreRow,
  senderId: string,
  { attachments, reactions, mentions, replyTo }: MessageParts,
): Pick<
  ChatMessageDTO,
  | "from"
  | "body"
  | "kind"
  | "attachments"
  | "reactions"
  | "mentions"
  | "createdAt"
  | "editedAt"
  | "deletedAt"
  | "replyToId"
  | "replyTo"
  | "pinnedAt"
> {
  const author = publicAuthorIdentity({
    id: senderId,
    displayName: r.sender_display_name,
    handle: r.sender_handle,
    avatarUrl: r.sender_avatar_url,
    deletedAt: r.sender_deleted_at,
  })
  return {
    from: {
      id: senderId,
      name: author.name,
      handle: author.handle,
      bio: author.deleted ? null : r.sender_bio,
      avatar: author.avatar,
      ...(author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
      followers: 0,
      following: 0,
      isFollowing: false,
      ...(author.deleted ? { deleted: true } : officialPersonFlag(senderId)),
    },
    ...(r.body !== null ? { body: r.body } : {}),
    kind: r.kind,
    attachments,
    reactions,
    mentions,
    createdAt: r.created_at.toISOString(),
    ...(r.edited_at !== null ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at.toISOString() } : {}),
    ...(r.reply_to_id !== null ? { replyToId: r.reply_to_id, replyTo: replyTo ?? null } : {}),
    ...(r.pinned_at != null ? { pinnedAt: r.pinned_at.toISOString() } : {}),
  }
}

export function replyFor(
  row: Pick<MessageCoreRow, "reply_to_id">,
  replyByTarget: Map<string, ReplyToDTO>,
): ReplyToDTO | null {
  return row.reply_to_id !== null ? (replyByTarget.get(row.reply_to_id) ?? null) : null
}

export async function loadMessageExtras<R extends MessageCoreRow>(
  sql: Queryable,
  table: ReplyTable,
  page: readonly R[],
  viewerUserId: string | null,
  presign: PresignMedia | undefined,
): Promise<(row: R) => MessageParts> {
  const ids = liveMessageIds(page)
  const [attachmentsByMessage, reactionsByMessage, mentionsByMessage, replyByTarget] =
    await Promise.all([
      presign
        ? loadChatAttachments(sql, ids, presign, viewerUserId)
        : Promise.resolve(new Map<string, MediaDTO[]>()),
      loadChatReactionsFor(sql, ids, viewerUserId),
      loadChatMentionsFor(sql, ids),
      replyMapForRows(sql, table, page),
    ])
  return (r) => ({
    attachments: attachmentsByMessage.get(r.id) ?? [],
    reactions: reactionsByMessage.get(r.id) ?? [],
    mentions: mentionsByMessage.get(r.id) ?? [],
    replyTo: replyFor(r, replyByTarget),
  })
}
