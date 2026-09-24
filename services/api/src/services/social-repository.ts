import type { SocialLinks } from "@civfix/shared"
import type { CleanupRecord } from "./cleanup-repository.js"

export interface PersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  avatarR2Key: string | null
  avatarUrl: string | null
  socialLinks: SocialLinks | null
  donationUrl: string | null
  showVolunteerHours: boolean | null
}

export interface ProfileStats {
  reports: number
  fixed: number
  cleanups: number
}

export interface ProfileEventsPageArgs {
  cursor: string | null
  limit: number
}

export interface ProfileEventsPage {
  items: CleanupRecord[]
  nextCursor: string | null
}

export interface UpcomingEventsArgs {
  includeAttending: boolean
  limit: number
}

export interface PeoplePage {
  items: Array<PersonView & { isFollowing: boolean }>
  nextCursor: string | null
}

export interface ConnectionsArgs {
  id: string
  viewerId: string | null
  cursor: string | null
  limit: number
}

export interface SocialRepository {
  listPeople(args: {
    viewerId: string | null
    q: string | null
    cursor: string | null
    limit: number
  }): Promise<PeoplePage>

  listFollowers(args: ConnectionsArgs): Promise<PeoplePage>

  listFollowing(args: ConnectionsArgs): Promise<PeoplePage>

  suggestFollows(args: {
    viewerId: string
    limit: number
  }): Promise<Array<PersonView & { isFollowing: boolean }>>

  findPersonById(id: string): Promise<PersonView | null>

  findPersonByHandle(handle: string): Promise<PersonView | null>

  isFollowing(followerId: string, followeeId: string): Promise<boolean>

  addFollow(followerId: string, followeeId: string): Promise<{ exists: boolean; created: boolean }>

  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }>

  followerCount(userId: string): Promise<number>

  pastEventsPageFor(userId: string, args: ProfileEventsPageArgs): Promise<ProfileEventsPage>

  upcomingEventsFor(userId: string, args: UpcomingEventsArgs): Promise<CleanupRecord[]>

  statsFor(userId: string): Promise<ProfileStats>
}
