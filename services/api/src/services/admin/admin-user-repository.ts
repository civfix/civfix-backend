import type {
  AdminReportStatus,
  AdminUserCounts,
  CleanupMemberRole,
  OrganizationMemberRole,
  ReportCategory,
  Risk,
  Role,
  UserStatus,
} from "@civfix/shared"

export interface AdminUserRecord {
  id: string
  name: string
  handle: string | null
  emailVerified?: boolean
  hasOauth?: boolean
  city: string
  role: Role
  joinedAt: Date | null
  lastActiveAt: Date | null
  accountStatus: UserStatus
  reports: number
  cleanups: number
  messages: number
  removals: number
  strikes: number
  risk: Risk
  flagged: boolean
  flagReason: string | null
  reportVerified: boolean
  avatarUrl: string | null
  deletedAt: Date | null
}

export interface AdminUserOrganizationRecord {
  id: string
  slug: string
  name: string
  role: OrganizationMemberRole
}

export interface UserReportRecord {
  id: string
  category: ReportCategory
  title: string
  place: string
  status: AdminReportStatus
  createdAt: Date
}

export interface UserEventRecord {
  id: string
  title: string
  place: string
  role: CleanupMemberRole
  attendees: number
  whenAt: Date
}

export interface UserMessageRecord {
  id: string
  text: string
  thread: string
  createdAt: Date
  deletedAt: Date | null
  source: "chat" | "group" | "dm" | "report"
  sourceId: string | null
}

export interface ListUsersArgs {
  q: string | null
  status: UserStatus | null
  flaggedOnly: boolean
  deletedOnly: boolean
  cursor: string | null
  limit: number
}

export interface AdminUserRepository {
  listUsers(args: ListUsersArgs): Promise<{ records: AdminUserRecord[]; nextCursor: string | null }>
  countByFacet(args: { q: string | null }): Promise<AdminUserCounts>
  userExists(id: string): Promise<boolean>
  getUser(id: string): Promise<AdminUserRecord | null>
  listUserReports(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserReportRecord[]; nextCursor: string | null }>
  listUserEvents(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserEventRecord[]; nextCursor: string | null }>
  listUserMessages(
    id: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: UserMessageRecord[]; nextCursor: string | null }>
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  setStatus(
    id: string,
    input: { status: UserStatus; reason: string | null; actorId: string | null },
  ): Promise<boolean>
  applyRole(id: string, input: { role: Role; actorId: string | null }): Promise<boolean>
  listUserOrganizations(id: string): Promise<AdminUserOrganizationRecord[]>
  setReportVerified(id: string, input: { value: boolean; actorId: string | null }): Promise<boolean>
  removeUserMessage(
    userId: string,
    messageId: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean>
}
