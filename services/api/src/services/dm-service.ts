import { AppError, relativeAgo, avatarGradient } from "@civfix/shared"
import type { ChatMessageDTO, MessageThreadDTO, PersonDTO } from "@civfix/shared"
import type { BlocksRepository } from "./blocks-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

export const DM_FORBIDDEN_MESSAGE = "You can't message this account."

export interface DmTargetUser {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  avatarUrl: string | null
  allowDirectMessages: boolean
}

export type DmUserLookup = (userId: string) => Promise<DmTargetUser | null>

export interface DmServiceDeps {
  dm: DmRepository
  blocks: BlocksRepository
  loadUser: DmUserLookup
  isMutedFor?: (userId: string, threadId: string) => Promise<boolean>
  now?: () => Date
}

export interface DmService {
  openDm(viewerId: string, targetUserId: string): Promise<MessageThreadDTO>
}

function lastPreview(last: ChatMessageDTO): string {
  const body = last.body
  if (typeof body === "string" && body.trim() !== "") return body
  const first = last.attachments?.[0]
  if (first) return first.kind === "video" ? "Video" : "Photo"
  return ""
}

function peerOf(target: DmTargetUser): PersonDTO {
  return {
    id: target.id,
    name: target.displayName,
    handle: target.handle,
    bio: target.bio,
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
      if (targetUserId === viewerId) throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)

      const target = await deps.loadUser(targetUserId)
      if (target === null) throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)

      if (await deps.blocks.isBlockedEitherWay(viewerId, targetUserId)) {
        throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)
      }

      const existing = await deps.dm.getThreadForPair(viewerId, targetUserId)
      if (!target.allowDirectMessages && existing === null) {
        throw AppError.forbidden(DM_FORBIDDEN_MESSAGE)
      }

      const thread = existing ?? (await deps.dm.openOrCreateThread(viewerId, targetUserId))

      const [page, muted, unread] = await Promise.all([
        deps.dm.history(thread.id, undefined, 1),
        deps.isMutedFor
          ? deps.isMutedFor(viewerId, thread.id).catch(() => false)
          : Promise.resolve(false),
        deps.dm.countUnread(thread.id, viewerId).catch(() => 0),
      ])
      const last = page.items[0] ?? null
      const lastAt = last !== null ? new Date(last.createdAt) : null

      const peer = peerOf(target)
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
        ago: lastAt !== null ? relativeAgo(lastAt, now()) : null,
        lastMessageAt: lastAt !== null ? lastAt.toISOString() : null,
        lastFromMe: last !== null && last.from?.id === viewerId,
        unread,
        members: 2,
        muted,
      }
    },
  }
}
