/**
 * DM service: open (or fetch) the 1:1 thread with a target user and project it as a MessageThreadDTO.
 *
 * LOCKED PRODUCT DECISIONS (implemented exactly):
 *   - 403 when the target is missing or soft-deleted.
 *   - 403 when the target is the viewer (no self-DM).
 *   - 403 when either party has blocked the other.
 *   - 403 when the target has allow_direct_messages = false AND no thread exists yet (existing threads
 *     keep working). Missing, blocked and DM-disabled are deliberately INDISTINGUISHABLE: all of these
 *     403s use a single generic message so none of those states leaks.
 *   - Otherwise openOrCreateThread (idempotent) and build a MessageThreadDTO (kind:"dm", peer, refId =
 *     threadId, title = displayName else @handle, members:2, last/ago/lastFromMe from the last message
 *     when one exists, `unread` from the repo's own inbox definition (countUnread) and `muted` from
 *     conversation_mutes when the mute seam is wired).
 *
 * All DB access sits behind small seams (DmRepository, BlocksRepository, a user-lookup function) so the
 * service is unit-testable with no database.
 */

import { AppError, relativeAgo, avatarGradient } from "@civfix/shared"
import type { ChatMessageDTO, MessageThreadDTO, PersonDTO } from "@civfix/shared"
import type { BlocksRepository } from "./blocks-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

/** A single generic 403 message: block and DM-disabled must be indistinguishable (no leak). */
export const DM_FORBIDDEN_MESSAGE = "You can't message this account."

/** The target-user fields the DM service needs (a non-deleted user view). */
export interface DmTargetUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  avatarUrl: string | null
  allowDirectMessages: boolean
}

/** Loads a non-deleted user by id (null when missing/soft-deleted). */
export type DmUserLookup = (userId: string) => Promise<DmTargetUser | null>

export interface DmServiceDeps {
  dm: DmRepository
  blocks: BlocksRepository
  /** Load the target user (and their DM toggle). */
  loadUser: DmUserLookup
  /**
   * conversation_mutes lookup for roomKind 'dm' (the chat-group-service isMutedFor pattern). Absent
   * (offline harnesses) => never muted. Without it, reopening a MUTED thread reported muted:false until the
   * inbox refreshed and threads-service stamped the real state.
   */
  isMutedFor?: (userId: string, threadId: string) => Promise<boolean>
  /** Injectable clock (defaults to now) so `ago` is deterministic in tests. */
  now?: () => Date
}

export interface DmService {
  /** Open (or fetch) the DM thread between the viewer and target. See the file header for the rules. */
  openDm(viewerId: string, targetUserId: string): Promise<MessageThreadDTO>
}

/**
 * Inbox preview text for the last DM message: the body when present, else a kind label derived from the
 * first attachment ("Photo"/"Video") so an attachment-only message doesn't render a blank preview.
 */
function lastPreview(last: ChatMessageDTO): string {
  const body = last.body
  if (typeof body === "string" && body.trim() !== "") return body
  const first = last.attachments?.[0]
  if (first) return first.kind === "video" ? "Video" : "Photo"
  return ""
}

/** Build the peer PersonDTO from a target user view. */
function peerOf(target: DmTargetUser): PersonDTO {
  return {
    id: target.id,
    name: target.displayName,
    handle: target.handle,
    bio: target.bio,
    // Deterministic server avatar seed (parity with the message-DTO sender) so the inbox peer monogram
    // matches the in-thread author color instead of forcing a client-side fallback.
    avatar: avatarGradient(target.id),
    ...(target.avatarUrl !== null ? { avatarUrl: target.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: false,
  }
}

export function makeDmService(deps: DmServiceDeps): DmService {
  const now = deps.now ?? (() => new Date())

  return {
    async openDm(viewerId: string, targetUserId: string): Promise<MessageThreadDTO> {
      // Self-DM is forbidden (generic 403 like every other refusal so nothing distinguishes the cases).
      if (targetUserId === viewerId) throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)

      const target = await deps.loadUser(targetUserId)
      if (target === null) throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)

      if (await deps.blocks.isBlockedEitherWay(viewerId, targetUserId)) {
        throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)
      }

      // DM-disabled blocks only a NEW thread; an EXISTING thread keeps working. We must NOT create a thread
      // before checking the toggle (that would silently bypass the rule), so probe for an existing thread
      // first. If the target has DMs off and there is no thread yet -> generic 403.
      const existing = await deps.dm.getThreadForPair(viewerId, targetUserId)
      if (!target.allowDirectMessages && existing === null) {
        throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)
      }

      const thread = existing ?? (await deps.dm.openOrCreateThread(viewerId, targetUserId))

      // Project the last message (if any) for the inbox preview, the viewer's real mute state, and their
      // real unread count — all in one round of concurrent reads. Both side lookups fail OPEN (un-muted /
      // zero unread): neither is worth failing an OPEN on, matching the inbox's stance.
      const [page, muted, unread] = await Promise.all([
        deps.dm.history(thread.id, undefined, 1),
        deps.isMutedFor
          ? deps.isMutedFor(viewerId, thread.id).catch(() => false)
          : Promise.resolve(false),
        deps.dm.countUnread(thread.id, viewerId).catch(() => 0),
      ])
      const last = page.items[0] ?? null

      const peer = peerOf(target)
      // The DM thread title is the peer's DISPLAY NAME (the @handle is only a fallback when the display name
      // is blank), so the inbox row + conversation header name the person, not their @handle (matches
      // threads-service). A freshly-opened thread therefore opens with the same title the inbox shows.
      const title =
        target.displayName.trim() !== ""
          ? target.displayName
          : target.handle !== null
            ? `@${target.handle}`
            : target.displayName

      return {
        id: thread.id,
        kind: "dm",
        refId: thread.id,
        title,
        peer,
        last: last !== null ? lastPreview(last) : null,
        ago: last !== null ? relativeAgo(new Date(last.createdAt), now()) : null,
        // DM messages always have an author (no sender-less SYSTEM messages on the dm path); optional-chain
        // to satisfy the nullable contract type without changing the "from me" result.
        lastFromMe: last !== null && last.from?.id === viewerId,
        // The viewer's REAL unread (repo.countUnread, the inbox's own definition). Opening a thread that
        // has unacked peer messages must not report 0 — the client renders the row's badge off this DTO,
        // and a hardcoded 0 made a thread opened from a profile look read until the inbox refetched.
        unread,
        members: 2,
        muted,
      }
    },
  }
}
