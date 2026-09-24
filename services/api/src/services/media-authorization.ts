import type { Sql } from "../db/client.js"
import type { MediaAssetView, MediaOwner } from "./media-intake-service.js"
import { isPubliclyVisibleStatus } from "./report-visibility.js"
import {
  makeDrizzleMediaAuthorizationRepository,
  type MediaAuthorizationRepository,
} from "./media-authorization-repository.drizzle.js"

export interface MediaAccessDecision {
  allowed: boolean
  private: boolean
}

export interface MediaViewAuthorizer {
  authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision>
}

const DENY: MediaAccessDecision = { allowed: false, private: true }
const ALLOW_PUBLIC: MediaAccessDecision = { allowed: true, private: false }
const ALLOW_PRIVATE: MediaAccessDecision = { allowed: true, private: true }

export const UNBOUND_GRACE_MS = 6 * 60 * 60 * 1000

export function makeUnboundOnlyMediaViewAuthorizer(
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  return {
    authorize(asset: MediaAssetView): Promise<MediaAccessDecision> {
      if (asset.purpose === "verification" || isEntityBoundPurpose(asset.purpose)) {
        return Promise.resolve(DENY)
      }
      if (asset.reportId || asset.chatMessageId || asset.postId) return Promise.resolve(DENY)
      return Promise.resolve(withinGrace(asset.createdAt, now()) ? ALLOW_PRIVATE : DENY)
    },
  }
}

function isEntityBoundPurpose(purpose: MediaAssetView["purpose"]): boolean {
  return purpose === "event_cover" || purpose === "event_gallery" || purpose === "org_logo"
}

function withinGrace(createdAt: Date | null | undefined, now: Date): boolean {
  if (!createdAt) return false
  return now.getTime() - createdAt.getTime() <= UNBOUND_GRACE_MS
}

export function makeDrizzleMediaViewAuthorizer(
  sql: Sql,
  now: () => Date = () => new Date(),
): MediaViewAuthorizer {
  const repo = makeDrizzleMediaAuthorizationRepository(sql)
  return {
    async authorize(asset: MediaAssetView, viewer: MediaOwner): Promise<MediaAccessDecision> {
      if (asset.purpose === "verification") return DENY

      const viewerId = viewer.userId ?? null

      if (asset.chatMessageId !== null && asset.chatMessageId !== undefined) {
        return authorizeChatBound(repo, asset.chatMessageId, viewerId)
      }
      if (asset.postId !== null && asset.postId !== undefined) {
        return authorizePostBound(repo, asset.postId, viewerId)
      }
      if (asset.reportId !== null && asset.reportId !== undefined) {
        return authorizeReportBound(repo, asset.reportId, viewerId)
      }
      if (asset.purpose === "event_cover" || asset.purpose === "event_gallery") {
        return authorizeEventBound(repo, asset, viewerId, now())
      }
      if (asset.purpose === "org_logo") {
        return authorizeOrgLogoBound(repo, asset, now())
      }
      return authorizeUnbound(repo, asset, now())
    },
  }
}

export async function authorizeChatBound(
  repo: MediaAuthorizationRepository,
  messageId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  if (viewerId === null) return DENY

  const dm = await repo.findDmMessage(messageId)
  if (dm) {
    if (dm.deletedAt !== null) return DENY
    return authorizeDmThread(repo, dm.threadId, viewerId)
  }

  const msg = await repo.findChatMessageScope(messageId)
  if (!msg || msg.deletedAt !== null) return DENY
  if (msg.cleanupId !== null) return authorizeCleanupRoom(repo, msg.cleanupId, viewerId)
  if (msg.groupId !== null) return authorizeGroupRoom(repo, msg.groupId, viewerId)
  if (msg.reportId !== null) {
    const { allowed } = await authorizeReportBound(repo, msg.reportId, viewerId)
    return allowed ? ALLOW_PRIVATE : DENY
  }
  return DENY
}

async function authorizeDmThread(
  repo: MediaAuthorizationRepository,
  threadId: string,
  viewerId: string,
): Promise<MediaAccessDecision> {
  return (await repo.isDmParticipant(threadId, viewerId)) ? ALLOW_PRIVATE : DENY
}

async function authorizeCleanupRoom(
  repo: MediaAuthorizationRepository,
  cleanupId: string,
  viewerId: string,
): Promise<MediaAccessDecision> {
  return (await repo.isCleanupMember(cleanupId, viewerId)) ? ALLOW_PRIVATE : DENY
}

async function authorizeGroupRoom(
  repo: MediaAuthorizationRepository,
  groupId: string,
  viewerId: string,
): Promise<MediaAccessDecision> {
  const group = await repo.findGroupAccess(groupId, viewerId)
  if (!group) return DENY
  return group.isMember || group.visibility === "public" ? ALLOW_PRIVATE : DENY
}

export async function authorizeEventBound(
  repo: MediaAuthorizationRepository,
  asset: MediaAssetView,
  viewerId: string | null,
  now: Date,
): Promise<MediaAccessDecision> {
  const event = await repo.findEventAccess(asset.id, viewerId)
  if (!event) return authorizeUnbound(repo, asset, now)
  if (event.visibility === "public" || event.visibility === "unlisted") return ALLOW_PUBLIC
  return event.isMember ? ALLOW_PRIVATE : DENY
}

export async function authorizeOrgLogoBound(
  repo: MediaAuthorizationRepository,
  asset: MediaAssetView,
  now: Date,
): Promise<MediaAccessDecision> {
  return (await repo.isLiveOrgLogo(asset.id)) ? ALLOW_PUBLIC : authorizeUnbound(repo, asset, now)
}

export async function authorizePostBound(
  repo: MediaAuthorizationRepository,
  postId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  const post = await repo.findPostAccess(postId)
  if (!post || post.deletedAt !== null) return DENY
  if (post.visibility === "public") return ALLOW_PUBLIC
  return viewerId !== null && post.authorId === viewerId ? ALLOW_PRIVATE : DENY
}

export async function authorizeReportBound(
  repo: MediaAuthorizationRepository,
  reportId: string,
  viewerId: string | null,
): Promise<MediaAccessDecision> {
  const report = await repo.findReportAccess(reportId)
  if (!report || report.deletedAt !== null) return DENY
  if (isPubliclyVisibleStatus(report.status) && report.visibility === "public") return ALLOW_PUBLIC
  if (viewerId !== null && report.reporterUserId === viewerId) return ALLOW_PRIVATE
  return DENY
}

async function authorizeUnbound(
  repo: MediaAuthorizationRepository,
  asset: MediaAssetView,
  now: Date,
): Promise<MediaAccessDecision> {
  if (await repo.isAvatarMedia(asset.id)) return ALLOW_PUBLIC
  return withinGrace(asset.createdAt, now) ? ALLOW_PRIVATE : DENY
}
