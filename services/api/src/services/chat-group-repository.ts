import type { MediaDTO, PersonDTO } from "@civfix/shared"
import type { ChatGroupKind, ChatGroupVisibility } from "../db/schema/chat_groups.js"
import type { GROUP_MEMBER_ROLE_VALUES } from "../db/schema/types.js"

export type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

export interface GroupRoomAccess {
  kind: ChatGroupKind
  visibility: ChatGroupVisibility
  role: GroupMemberRole | null
}

export interface ChatGroupView {
  id: string
  kind: ChatGroupKind
  name: string
  description: string | null
  visibility: ChatGroupVisibility
  ownerId: string
  createdAt: Date
  avatar: MediaDTO | null
  memberCount: number
}

export interface GroupMemberView {
  user: PersonDTO
  role: GroupMemberRole
  joinedAt: Date
}

export interface CreateChatGroupInput {
  kind: ChatGroupKind
  name: string
  description: string | null
  avatarUploadId: string | null
  ownerId: string
  visibility: ChatGroupVisibility
}

export interface UpdateChatGroupPatch {
  name?: string
  description?: string | null
  avatarUploadId?: string
  visibility?: ChatGroupVisibility
}

export interface ChatGroupRepository {
  create(input: CreateChatGroupInput, memberIds: string[]): Promise<string>
  findById(id: string): Promise<ChatGroupView | null>
  update(id: string, patch: UpdateChatGroupPatch, actorId: string): Promise<void>
  roleOf(groupId: string, userId: string): Promise<GroupMemberRole | null>
  accessOf(groupId: string, userId: string): Promise<GroupRoomAccess | null>
  addMembers(groupId: string, userIds: string[]): Promise<void>
  joinUnlessBanned(groupId: string, userId: string): Promise<boolean>
  removeMember(groupId: string, userId: string): Promise<boolean>
  banMember(groupId: string, userId: string, bannedBy: string): Promise<void>
  setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<boolean>
  findMember(
    groupId: string,
    userId: string,
    viewerId: string | null,
  ): Promise<GroupMemberView | null>
  listMembers(
    groupId: string,
    viewerId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<{ members: GroupMemberView[]; nextCursor: string | null }>
  invitableIdsOf(actorId: string, candidateIds: string[]): Promise<string[]>
  blockedPairsAmong(userIds: string[]): Promise<Set<string>>
  listMemberIds(groupId: string, limit?: number): Promise<string[]>
  advanceReadWatermark(groupId: string, userId: string, upToMessageId: string): Promise<void>
  markRead(groupId: string, userId: string, at: Date): Promise<void>
}
