/**
 * P3 Task 3.3: the chat-room POWERS resolver — the single source of truth for "who may pin" and
 * "who may delete other people's messages" in a chat room (consumed by the pin routes in Task 3.4
 * and the delete-others path in Task 3.5; later phases reuse it rather than re-deriving roles).
 * Factory-with-deps like chat-bells.ts: pure gate logic here, lookups injected, so the full matrix
 * is unit-testable offline and the pg wiring stays a 4-line adapter.
 *
 * THE MATRIX (spec §3.4):
 *
 *   room     | who                     | canPin | canDeleteOthers
 *   ---------+-------------------------+--------+----------------
 *   dm       | thread participant      |  yes   |  NO — always (your peer's words are theirs)
 *   cleanup  | organizer               |  yes   |  yes
 *   cleanup  | member                  |  no    |  no
 *   report   | owner                   |  yes   |  NO — a report room is a PUBLIC civic space;
 *            |                         |        |  the reporter curates pins but never erases
 *            |                         |        |  other residents' speech
 *   report   | member                  |  no    |  no
 *   report   | global operator         |  yes   |  yes — platform moderation applies in the
 *            |                         |        |  public rooms, membership row or not
 *   cleanup  | global operator         |  ——— NOTHING beyond their cleanup_members role ———
 *            |                         |  (§3.4 grants operators powers in REPORT rooms only;
 *            |                         |   a private cleanup crew moderates itself)
 *   any      | non-member / unknown    |  no    |  no
 *
 * `isModerator` semantics (documented choice): TRUE iff the user holds ELEVATED STANDING in a
 * GROUP room — cleanup organizer, report owner, or operator-in-report — i.e. canPin||canDeleteOthers
 * for group rooms. A dm participant's canPin is a symmetric PEER power, not moderation, so dm rooms
 * never set isModerator. UI can badge/moderator-style on this bit without re-deriving roles.
 *
 * Lane isolation is deliberate: each kind consults ONLY its own lookup(s) — dm never loads roles,
 * cleanup never loads the global role (operators must get nothing extra there, so we don't even
 * look), report loads both in parallel. The unit suite pins this with throwing stubs.
 */

import type { RoomKind } from "@civfix/shared"
import type { ROLE_VALUES, CLEANUP_MEMBER_ROLE_VALUES, REPORT_CHAT_ROLE_VALUES } from "../db/schema/types.js"

type GlobalRole = (typeof ROLE_VALUES)[number]
type CleanupRole = (typeof CLEANUP_MEMBER_ROLE_VALUES)[number]
type ReportChatRole = (typeof REPORT_CHAT_ROLE_VALUES)[number]

/** What the resolved user may do in the room. */
export interface ChatPowers {
  canPin: boolean
  canDeleteOthers: boolean
  /** Elevated standing in a GROUP room (organizer / owner / operator-in-report). Never true for dm. */
  isModerator: boolean
}

export interface ChatRoomRoleDeps {
  /** dm lane: is `userId` one of the thread's two participants? */
  isDmParticipant(threadId: string, userId: string): Promise<boolean>
  /** cleanup lane: the user's cleanup_members.role, or null when not a member. */
  cleanupRoleOf(cleanupId: string, userId: string): Promise<CleanupRole | null>
  /** report lane: the user's report_chat_members.role, or null when not a member. */
  reportChatRoleOf(reportId: string, userId: string): Promise<ReportChatRole | null>
  /** report lane: users.role, or null when the user row is missing. */
  globalRoleOf(userId: string): Promise<GlobalRole | null>
}

export interface ResolveChatPowersInput {
  roomKind: RoomKind
  roomId: string
  userId: string
}

export type ResolveChatPowers = (input: ResolveChatPowersInput) => Promise<ChatPowers>

const NO_POWERS: ChatPowers = Object.freeze({
  canPin: false,
  canDeleteOthers: false,
  isModerator: false,
})

/** Build the resolver over the injected lookups. */
export function makeChatPowersResolver(deps: ChatRoomRoleDeps): ResolveChatPowers {
  return async ({ roomKind, roomId, userId }) => {
    switch (roomKind) {
      case "dm": {
        const participant = await deps.isDmParticipant(roomId, userId)
        // Peer power, not moderation: pinning is symmetric, delete-others never exists in a dm.
        return { canPin: participant, canDeleteOthers: false, isModerator: false }
      }
      case "cleanup": {
        // ONLY the cleanup role decides — no global-role lookup on purpose (see banner).
        const organizer = (await deps.cleanupRoleOf(roomId, userId)) === "organizer"
        return { canPin: organizer, canDeleteOthers: organizer, isModerator: organizer }
      }
      case "report": {
        const [role, globalRole] = await Promise.all([
          deps.reportChatRoleOf(roomId, userId),
          deps.globalRoleOf(userId),
        ])
        const operator = globalRole === "operator"
        const canPin = role === "owner" || operator
        const canDeleteOthers = operator // owners never delete others in the public room
        return { canPin, canDeleteOthers, isModerator: canPin || canDeleteOthers }
      }
      default:
        // RoomKind is exhaustive above; this guards any-typed / forged kinds at runtime.
        return NO_POWERS
    }
  }
}
