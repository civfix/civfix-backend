export interface DmMessageRef {
  threadId: string
  deletedAt: Date | null
}

export interface DmMessageThread {
  threadId: string
}

export interface ChatMessageScope {
  cleanupId: string | null
  reportId: string | null
  groupId: string | null
  deletedAt: Date | null
}

export interface ChatMessageRoom {
  cleanupId: string | null
  reportId: string | null
  groupId: string | null
}

export interface RoomAccess {
  visibility: string
  isMember: boolean
}

export interface PostAccess {
  authorId: string
  visibility: string
  deletedAt: Date | null
}

export interface ReportAccess {
  reporterUserId: string | null
  status: string
  visibility: string
  deletedAt: Date | null
}

// The media view authorizer and the content-report subject gate share these lookups on purpose: both ask
// whether a viewer may see the same thing, so tightening one lane must tighten the other.
export interface MediaAuthorizationRepository {
  findDmMessage(messageId: string): Promise<DmMessageRef | null>
  findDmMessageThread(messageId: string): Promise<DmMessageThread | null>
  isDmParticipant(threadId: string, userId: string): Promise<boolean>
  findChatMessageScope(messageId: string): Promise<ChatMessageScope | null>
  findChatMessageRoom(messageId: string): Promise<ChatMessageRoom | null>
  isCleanupMember(cleanupId: string, userId: string): Promise<boolean>
  findGroupAccess(groupId: string, userId: string): Promise<RoomAccess | null>
  findEventAccess(mediaId: string, viewerId: string | null): Promise<RoomAccess | null>
  isLiveOrgLogo(mediaId: string): Promise<boolean>
  findPostAccess(postId: string): Promise<PostAccess | null>
  findReportAccess(reportId: string): Promise<ReportAccess | null>
  isAvatarMedia(mediaId: string): Promise<boolean>
  activeUserExists(userId: string): Promise<boolean>
}
