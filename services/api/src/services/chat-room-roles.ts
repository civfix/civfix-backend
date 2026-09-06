
import type { CleanupMemberRole, RoomKind } from "@civfix/shared"
import { can } from "@civfix/shared/host"
import type {
  ROLE_VALUES,
  REPORT_CHAT_ROLE_VALUES,
  GROUP_MEMBER_ROLE_VALUES,
} from "../db/schema/types.js"

type GlobalRole = (typeof ROLE_VALUES)[number]
type CleanupRole = CleanupMemberRole
type ReportChatRole = (typeof REPORT_CHAT_ROLE_VALUES)[number]
type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

export interface ChatPowers {
  canPin: boolean
  canDeleteOthers: boolean
  isModerator: boolean
}

export interface ChatRoomRoleDeps {
  isDmParticipant(threadId: string, userId: string): Promise<boolean>
  isDmBlocked?(threadId: string, userId: string): Promise<boolean>
  cleanupRoleOf(cleanupId: string, userId: string): Promise<CleanupRole | null>
  reportChatRoleOf(reportId: string, userId: string): Promise<ReportChatRole | null>
  globalRoleOf(userId: string): Promise<GlobalRole | null>
  groupRoleOf(groupId: string, userId: string): Promise<GroupMemberRole | null>
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

export function makeChatPowersResolver(deps: ChatRoomRoleDeps): ResolveChatPowers {
  return async ({ roomKind, roomId, userId }) => {
    switch (roomKind) {
      case "dm": {
        const participant = await deps.isDmParticipant(roomId, userId)
        if (!participant) return NO_POWERS
        if (deps.isDmBlocked && (await deps.isDmBlocked(roomId, userId))) return NO_POWERS
        return { canPin: true, canDeleteOthers: false, isModerator: false }
      }
      case "cleanup": {
        const role = await deps.cleanupRoleOf(roomId, userId)
        const host = role !== null && can({ eventRole: role, orgRole: null }, "moderate_chat")
        return { canPin: host, canDeleteOthers: host, isModerator: host }
      }
      case "report": {
        const [role, globalRole] = await Promise.all([
          deps.reportChatRoleOf(roomId, userId),
          deps.globalRoleOf(userId),
        ])
        const operator = globalRole === "operator"
        const canPin = role === "owner" || operator
        const canDeleteOthers = operator
        return { canPin, canDeleteOthers, isModerator: canPin || canDeleteOthers }
      }
      case "group": {
        const role = await deps.groupRoleOf(roomId, userId)
        const moderator = role === "owner" || role === "admin"
        return { canPin: moderator, canDeleteOthers: moderator, isModerator: moderator }
      }
      default:
        return NO_POWERS
    }
  }
}
