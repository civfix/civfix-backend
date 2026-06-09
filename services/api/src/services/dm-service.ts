/**
 * DM service: open (or fetch) the 1:1 thread with a target user and project it as a MessageThreadDTO.
 *
 * LOCKED PRODUCT DECISIONS (implemented exactly):
 *   - 404 when the target is missing or soft-deleted.
 *   - 403 when the target is the viewer (no self-DM).
 *   - 403 when either party has blocked the other.
 *   - 403 when the target has allow_direct_messages = false AND no thread exists yet (existing threads
 *     keep working). Block and DM-disabled are deliberately INDISTINGUISHABLE: all of these 403s use a
 *     single generic message so neither state leaks.
 *   - Otherwise openOrCreateThread (idempotent) and build a MessageThreadDTO (kind:"dm", peer, refId =
 *     threadId, title = @handle else displayName, members:2, unread:0, last/ago/lastFromMe from the last
 *     message when one exists).
 *
 * All DB access sits behind small seams (DmRepository, BlocksRepository, a user-lookup function) so the
 * service is unit-testable with no database.
 */

import { AppError, relativeAgo, avatarGradient } from "@civfix/shared"
import type { MessageThreadDTO, PersonDTO } from "@civfix/shared"
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
  /** Injectable clock (defaults to now) so `ago` is deterministic in tests. */
  now?: () => Date
}

export interface DmService {
  /** Open (or fetch) the DM thread between the viewer and target. See the file header for the rules. */
  openDm(viewerId: string, targetUserId: string): Promise<MessageThreadDTO>
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

      // 404 when the target is missing or soft-deleted (this is the ONLY non-generic outcome — a missing
      // user is not a privacy leak the way "blocked vs DM-off" is).
      const target = await deps.loadUser(targetUserId)
      if (target === null) throw AppError.notFound("User not found")

      // Blocked either way -> generic 403.
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

      // Project the last message (if any) for the inbox preview.
      const page = await deps.dm.history(thread.id, undefined, 1)
      const last = page.items[0] ?? null

      const peer = peerOf(target)
      const title = target.handle !== null ? `@${target.handle}` : target.displayName

      return {
        id: thread.id,
        kind: "dm",
        refId: thread.id,
        title,
        peer,
        last: last !== null ? (last.body ?? "") : null,
        ago: last !== null ? relativeAgo(new Date(last.createdAt), now()) : null,
        lastFromMe: last !== null && last.from.id === viewerId,
        unread: 0,
        members: 2,
      }
    },
  }
}
