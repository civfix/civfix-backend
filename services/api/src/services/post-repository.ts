import type { PostDTO } from "@civfix/shared"
import type { POST_KIND_VALUES, REPORT_VISIBILITY_VALUES } from "../db/schema/types.js"

export type PostKind = (typeof POST_KIND_VALUES)[number]

export type PostVisibility = (typeof REPORT_VISIBILITY_VALUES)[number]

export interface CreatePostArgs {
  authorId: string
  guestAnonSessionId?: string | undefined
  kind: PostKind
  body: string | null
  replyToId: string | null
  repostOfId: string | null
  eventId: string | null
  reportId: string | null
  mediaUploadIds: string[]
  mentionedUserIds: string[]
  organizationId: string | null
}

export interface PostBrief {
  id: string
  authorId: string
  kind: PostKind
  replyToId: string | null
  repostOfId: string | null
  deletedAt: Date | null
  visibility: PostVisibility
}

export interface FeedPage {
  items: PostDTO[]
  nextCursor: string | null
}

export interface PostListArgs {
  viewerId: string
  cursor: string | null
  limit: number
}

export interface ReplyListArgs extends PostListArgs {
  focalAuthorId: string
}

export interface RepliesPage extends FeedPage {
  authorReplies: PostDTO[]
}

export interface HomeFeedArgs extends PostListArgs {
  filter: "all" | "events" | "fixes"
}

export type FeedFilter = "all" | "events" | "fixes"

export interface FeedCandidateArgs {
  viewerId: string
  filter: FeedFilter
  fallbackLat: number | null
  fallbackLng: number | null
  windowDays: number
  radiusKm: number
  candidateCap: number
}

export interface FeedCandidateRow {
  id: string
  author_id: string
  created_at: Date
  like_count: number
  reply_count: number
  repost_count: number
  has_report: boolean
  has_live_event: boolean
  has_media: boolean
  author_followed: boolean
  author_is_viewer: boolean
  viewer_mentioned: boolean
  author_org_verified: boolean
  distance_km: number | null
}

export interface FeedCountsRow {
  id: string
  like_count: number
  repost_count: number
  reply_count: number
  save_count: number
}

export interface PublicFeedArgs {
  filter: "all" | "events" | "fixes"
  cursor: string | null
  limit: number
}

export interface PostRepository {
  getPostBrief(id: string): Promise<PostBrief | null>
  actorNameOf(userId: string): Promise<string>
  canPostAsOrganization(organizationId: string, userId: string): Promise<boolean>
  isEventMember(eventId: string, userId: string): Promise<boolean>
  isReportAttachable(reportId: string): Promise<boolean>

  createPost(args: CreatePostArgs): Promise<string>
  softDeletePost(postId: string): Promise<void>

  like(postId: string, userId: string): Promise<boolean>
  unlike(postId: string, userId: string): Promise<boolean>
  save(postId: string, userId: string): Promise<boolean>
  unsave(postId: string, userId: string): Promise<boolean>
  repost(postId: string, userId: string): Promise<{ targetId: string; created: boolean }>
  unrepost(postId: string, userId: string): Promise<{ targetId: string; removed: boolean }>

  getPostDTO(id: string, viewerId: string): Promise<PostDTO | null>
  homeFeedChronological(args: HomeFeedArgs): Promise<FeedPage>
  publicFeed(args: PublicFeedArgs): Promise<FeedPage>
  feedCandidates(args: FeedCandidateArgs): Promise<FeedCandidateRow[]>
  hydrateByIds(ids: readonly string[], viewerId: string): Promise<PostDTO[]>
  followerIdsOf(authorId: string, limit: number): Promise<string[]>
  readableCounts(postIds: readonly string[], viewerId: string): Promise<FeedCountsRow[]>
  listReplies(postId: string, args: ReplyListArgs): Promise<RepliesPage>
  listUserPosts(authorId: string, args: PostListArgs): Promise<FeedPage>
  listSaves(args: PostListArgs): Promise<FeedPage>
}
