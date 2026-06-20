/**
 * Shared persistence helper for CHAT message USER @-mentions (the chat_message_mentions table, which serves
 * BOTH the cleanup group chat and 1:1 DMs — message ids are globally-unique uuids across both). Factored out
 * of chat-repository.drizzle.ts / dm-repository.drizzle.ts so the two repos hydrate the SAME table
 * identically when reading message history. Mirrors chat-reactions.drizzle.ts loadChatReactions.
 *
 * The WRITE path (persisting a new message's mentions) lives in the WS gateway seam (chat.routes), not here:
 * mentions are resolved from @handles + the send frame AFTER persist, so a mention failure never blocks the
 * message. This helper is only the READ side (history / single-message reads project the stored mentions).
 */

import type { Queryable } from "../db/client.js"
import type { UserMentionDTO } from "@civfix/shared"

/**
 * Load the resolved USER @-mentions on ONE chat/dm message (chat_message_mentions joined to users), as the
 * wire UserMentionDTO[]. Ordered by handle then id for a stable render. Empty when the message names no one.
 */
export async function loadChatMentions(
  tag: Queryable,
  messageId: string,
): Promise<UserMentionDTO[]> {
  const rows = await tag<{ id: string; handle: string | null; display_name: string }[]>`
    SELECT u.id, u.handle, u.display_name
    FROM chat_message_mentions cm
    JOIN users u ON u.id = cm.mentioned_user_id
    WHERE cm.message_id = ${messageId}
    ORDER BY u.handle ASC, u.id ASC
  `
  // UserMentionDTO.handle is non-null; a mentioned user always has a handle in practice (mentions resolve
  // from @handles), but coalesce defensively so a NULL-handle row never breaks the contract.
  return rows.map((r) => ({ id: r.id, handle: r.handle ?? "", displayName: r.display_name }))
}
