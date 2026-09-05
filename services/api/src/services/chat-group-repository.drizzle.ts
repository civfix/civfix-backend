
import type { Sql } from "../db/client.js"
import type { MediaDTO, MediaKind, MediaStatus, PersonDTO } from "@civfix/shared"
import type { ChatGroupKind, ChatGroupVisibility } from "../db/schema/chat-groups.js"
import type { GROUP_MEMBER_ROLE_VALUES } from "../db/schema/types.js"
import type { PresignMedia } from "./media-presign.js"
import { publicAuthorIdentity } from "./public-author.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
import { resolveAvatarMediaOrThrow } from "./avatar-media.js"
import { monotonicReadWatermarkUpdate } from "./chat-read-state.drizzle.js"
import { isUuid } from "../db/cursor-helpers.js"
import { servedKeyExpr } from "./media-served-key.js"

export type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

export const GROUP_MEMBER_SCAN_CAP = 2000

export interface GroupRoomAccess {
  kind: ChatGroupKind
  visibility: ChatGroupVisibility
  role: GroupMemberRole | null
}

export function canPostToGroup(access: { kind: ChatGroupKind; role: GroupMemberRole | null }): boolean {
  if (access.role === null) return false
  return access.kind === "group" || access.role === "owner" || access.role === "admin"
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
  avatarMediaId: string | null
  ownerId: string
  visibility: ChatGroupVisibility
}

export interface UpdateChatGroupPatch {
  name?: string
  description?: string | null
  avatarMediaId?: string
  visibility?: ChatGroupVisibility
}

export interface ChatGroupRepository {
  create(input: CreateChatGroupInput, memberIds: string[]): Promise<string>
  findById(id: string): Promise<ChatGroupView | null>
  update(id: string, patch: UpdateChatGroupPatch): Promise<void>
  roleOf(groupId: string, userId: string): Promise<GroupMemberRole | null>
  accessOf(groupId: string, userId: string): Promise<GroupRoomAccess | null>
  addMembers(groupId: string, userIds: string[]): Promise<void>
  removeMember(groupId: string, userId: string): Promise<boolean>
  banMember(groupId: string, userId: string, bannedBy: string): Promise<void>
  isBanned(groupId: string, userId: string): Promise<boolean>
  setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<boolean>
  findMember(groupId: string, userId: string, viewerId: string | null): Promise<GroupMemberView | null>
  listMembers(
    groupId: string,
    viewerId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<{ members: GroupMemberView[]; nextCursor: string | null }>
  findMediaIdByUploadId(uploadId: string, groupId?: string): Promise<string>
  invitableIdsOf(actorId: string, candidateIds: string[]): Promise<string[]>
  blockedPairsAmong(userIds: string[]): Promise<Set<string>>
  listMemberIds(groupId: string, limit?: number): Promise<string[]>
  advanceReadWatermark(groupId: string, userId: string, upToMessageId: string): Promise<void>
  markRead(groupId: string, userId: string, at: Date): Promise<void>
}

interface GroupRowSelect {
  id: string
  kind: ChatGroupKind
  name: string
  description: string | null
  visibility: ChatGroupVisibility
  owner_id: string
  created_at: Date
  member_count: number
  avatar_id: string | null
  avatar_kind: MediaKind | null
  avatar_codec: string | null
  avatar_r2_key: string | null
  avatar_thumb_key: string | null
  avatar_status: MediaStatus | null
  avatar_width: number | null
  avatar_height: number | null
}

export interface MemberRowSelect {
  user_id: string
  role: GroupMemberRole
  joined_at: Date
  display_name: string | null
  handle: string | null
  bio: string | null
  avatar_url: string | null
  user_deleted_at: Date | null
  verified: boolean
  is_following: boolean
  blocked_pair: boolean
}

export function toMemberView(r: MemberRowSelect): GroupMemberView {
  const author = publicAuthorIdentity({
    id: r.user_id,
    displayName: r.display_name ?? "",
    handle: r.handle,
    avatarUrl: r.avatar_url,
    deletedAt: r.user_deleted_at,
  })
  const hidden = r.blocked_pair && !author.deleted ? hiddenIdentity(r.user_id) : null
  const user: PersonDTO = {
    id: r.user_id,
    name: hidden?.name ?? author.name,
    handle: hidden !== null ? null : author.handle,
    bio: author.deleted || hidden !== null ? null : r.bio,
    avatar: author.avatar,
    ...(hidden === null && author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: r.is_following,
    ...(r.verified && hidden === null && !author.deleted ? { verified: true } : {}),
    ...(author.deleted ? { deleted: true } : {}),
  }
  return { user, role: r.role, joinedAt: r.joined_at }
}

export function makeChatGroupRepository(sql: Sql, presign?: PresignMedia): ChatGroupRepository {
  async function toGroupView(r: GroupRowSelect): Promise<ChatGroupView> {
    let avatar: MediaDTO | null = null
    if (presign && r.avatar_id !== null && r.avatar_status === "ready" && r.avatar_r2_key !== null) {
      const { url, thumbUrl } = await presign(r.avatar_r2_key, r.avatar_thumb_key)
      avatar = {
        id: r.avatar_id,
        kind: r.avatar_kind ?? "image",
        codec: r.avatar_codec,
        url,
        ...(thumbUrl !== undefined ? { thumbUrl } : {}),
        width: r.avatar_width,
        height: r.avatar_height,
        status: r.avatar_status,
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      visibility: r.visibility,
      ownerId: r.owner_id,
      createdAt: r.created_at,
      avatar,
      memberCount: Number(r.member_count),
    }
  }

  const memberColumns = (viewerId: string | null) => {
    const followingExpr =
      viewerId !== null
        ? sql`EXISTS (SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id)`
        : sql`FALSE`
    const blockedPair = blockedPairExpr(sql, viewerId, sql`u.id`)
    return sql`
      m.user_id,
      m.role,
      m.joined_at,
      u.display_name,
      u.handle,
      u.bio,
      u.avatar_url,
      u.deleted_at AS user_deleted_at,
      EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
      ${followingExpr} AS is_following,
      ${blockedPair} AS blocked_pair
    `
  }

  return {
    async create(input: CreateChatGroupInput, memberIds: string[]): Promise<string> {
      return sql.begin(async (tx) => {
        const [g] = await tx<{ id: string }[]>`
          INSERT INTO chat_groups (kind, name, description, avatar_media_id, owner_id, visibility)
          VALUES (${input.kind}, ${input.name}, ${input.description}, ${input.avatarMediaId},
                  ${input.ownerId}, ${input.visibility})
          RETURNING id
        `
        const groupId = g!.id
        await tx`
          INSERT INTO chat_group_members (group_id, user_id, role)
          VALUES (${groupId}, ${input.ownerId}, 'owner')
        `
        if (memberIds.length > 0) {
          const rows = memberIds.map((userId) => ({ group_id: groupId, user_id: userId, role: "member" }))
          await tx`
            INSERT INTO chat_group_members ${tx(rows, "group_id", "user_id", "role")}
            ON CONFLICT (group_id, user_id) DO NOTHING
          `
        }
        return groupId
      })
    },

    async findById(id: string): Promise<ChatGroupView | null> {
      if (!isUuid(id)) return null
      const rows = await sql<GroupRowSelect[]>`
        SELECT
          g.id, g.kind, g.name, g.description, g.visibility, g.owner_id, g.created_at,
          (SELECT count(*)::int FROM chat_group_members m WHERE m.group_id = g.id) AS member_count,
          a.id AS avatar_id,
          a.kind AS avatar_kind,
          a.codec AS avatar_codec,
          ${servedKeyExpr(sql, "a")} AS avatar_r2_key,
          a.thumb_key AS avatar_thumb_key,
          a.status AS avatar_status,
          a.width AS avatar_width,
          a.height AS avatar_height
        FROM chat_groups g
        LEFT JOIN media_assets a ON a.id = g.avatar_media_id
        WHERE g.id = ${id}
        LIMIT 1
      `
      const row = rows[0]
      return row ? toGroupView(row) : null
    },

    async update(id: string, patch: UpdateChatGroupPatch): Promise<void> {
      const set: Record<string, unknown> = {}
      if (patch.name !== undefined) set["name"] = patch.name
      if (patch.description !== undefined) set["description"] = patch.description
      if (patch.avatarMediaId !== undefined) set["avatar_media_id"] = patch.avatarMediaId
      if (patch.visibility !== undefined) set["visibility"] = patch.visibility
      const cols = Object.keys(set)
      if (cols.length === 0) return
      await sql`UPDATE chat_groups SET ${sql(set, ...cols)} WHERE id = ${id}`
    },

    async roleOf(groupId: string, userId: string): Promise<GroupMemberRole | null> {
      const rows = await sql<{ role: GroupMemberRole }[]>`
        SELECT role FROM chat_group_members
        WHERE group_id = ${groupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows[0]?.role ?? null
    },

    async accessOf(groupId: string, userId: string): Promise<GroupRoomAccess | null> {
      if (!isUuid(groupId)) return null
      const rows = await sql<{ kind: ChatGroupKind; visibility: ChatGroupVisibility; role: GroupMemberRole | null }[]>`
        SELECT g.kind, g.visibility, m.role
        FROM chat_groups g
        LEFT JOIN chat_group_members m ON m.group_id = g.id AND m.user_id = ${userId}
        WHERE g.id = ${groupId}
        LIMIT 1
      `
      const row = rows[0]
      return row ? { kind: row.kind, visibility: row.visibility, role: row.role ?? null } : null
    },

    async addMembers(groupId: string, userIds: string[]): Promise<void> {
      if (userIds.length === 0) return
      const rows = userIds.map((userId) => ({ group_id: groupId, user_id: userId, role: "member" }))
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO chat_group_members ${tx(rows, "group_id", "user_id", "role")}
          ON CONFLICT (group_id, user_id) DO NOTHING
        `
        await tx`
          DELETE FROM chat_group_bans
          WHERE group_id = ${groupId} AND user_id IN ${tx(userIds)}
        `
      })
    },

    async removeMember(groupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        DELETE FROM chat_group_members
        WHERE group_id = ${groupId} AND user_id = ${userId}
        RETURNING user_id
      `
      return rows.length > 0
    },

    async banMember(groupId: string, userId: string, bannedBy: string): Promise<void> {
      await sql`
        INSERT INTO chat_group_bans (group_id, user_id, banned_by)
        VALUES (${groupId}, ${userId}, ${bannedBy})
        ON CONFLICT (group_id, user_id)
          DO UPDATE SET banned_by = ${bannedBy}, banned_at = now()
      `
    },

    async isBanned(groupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM chat_group_bans
        WHERE group_id = ${groupId} AND user_id = ${userId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        UPDATE chat_group_members
        SET role = ${role}
        WHERE group_id = ${groupId} AND user_id = ${userId} AND role <> 'owner'
        RETURNING user_id
      `
      return rows.length > 0
    },

    async findMember(
      groupId: string,
      userId: string,
      viewerId: string | null,
    ): Promise<GroupMemberView | null> {
      const rows = await sql<MemberRowSelect[]>`
        SELECT ${memberColumns(viewerId)}
        FROM chat_group_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ${groupId} AND m.user_id = ${userId}
        LIMIT 1
      `
      const row = rows[0]
      return row ? toMemberView(row) : null
    },

    async listMembers(
      groupId: string,
      viewerId: string | null,
      cursor: string | null,
      limit: number,
    ): Promise<{ members: GroupMemberView[]; nextCursor: string | null }> {
      let cursorFilter = sql``
      if (cursor !== null && isUuid(cursor)) {
        const anchorRows = await sql<{ user_id: string }[]>`
          SELECT user_id FROM chat_group_members
          WHERE group_id = ${groupId} AND user_id = ${cursor}
          LIMIT 1
        `
        if (anchorRows[0]) {
          cursorFilter = sql`
            AND (CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at, m.user_id)
              > (
                SELECT CASE c.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, c.joined_at, c.user_id
                FROM chat_group_members c
                WHERE c.group_id = ${groupId} AND c.user_id = ${cursor}
              )
          `
        }
      }
      const rows = await sql<MemberRowSelect[]>`
        SELECT ${memberColumns(viewerId)}
        FROM chat_group_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ${groupId}
          ${cursorFilter}
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END ASC,
                 m.joined_at ASC, m.user_id ASC
        LIMIT ${limit + 1}
      `
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      return {
        members: page.map(toMemberView),
        nextCursor: hasMore && last ? last.user_id : null,
      }
    },

    async findMediaIdByUploadId(uploadId: string, groupId?: string): Promise<string> {
      const media = await resolveAvatarMediaOrThrow(sql, uploadId, { groupId })
      return media.id
    },

    async invitableIdsOf(actorId: string, candidateIds: string[]): Promise<string[]> {
      if (candidateIds.length === 0) return []
      const rows = await sql<{ id: string }[]>`
        SELECT u.id
        FROM users u
        WHERE u.id IN ${sql(candidateIds)}
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = ${actorId} AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = ${actorId})
          )
      `
      const allowed = new Set(rows.map((r) => r.id))
      return candidateIds.filter((id) => allowed.has(id))
    },

    async blockedPairsAmong(userIds: string[]): Promise<Set<string>> {
      const unique = [...new Set(userIds)]
      const set = new Set<string>()
      if (unique.length < 2) return set
      const rows = await sql<{ blocker_id: string; blocked_id: string }[]>`
        SELECT blocker_id, blocked_id FROM user_blocks
        WHERE blocker_id IN ${sql(unique)} AND blocked_id IN ${sql(unique)}
      `
      for (const r of rows) {
        set.add(`${r.blocker_id}|${r.blocked_id}`)
        set.add(`${r.blocked_id}|${r.blocker_id}`)
      }
      return set
    },

    async listMemberIds(groupId: string, limit = GROUP_MEMBER_SCAN_CAP): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM chat_group_members
        WHERE group_id = ${groupId}
        ORDER BY joined_at ASC, user_id ASC
        LIMIT ${limit}
      `
      return rows.map((r) => r.user_id)
    },

    async advanceReadWatermark(groupId: string, userId: string, upToMessageId: string): Promise<void> {
      await monotonicReadWatermarkUpdate(
        sql,
        "chat_group_members",
        { group_id: groupId, user_id: userId },
        {
          messagesTable: "chat_messages",
          messageId: upToMessageId,
          scopeColumn: "group_id",
          scopeId: groupId,
        },
      )
    },

    async markRead(groupId: string, userId: string, at: Date): Promise<void> {
      await monotonicReadWatermarkUpdate(
        sql,
        "chat_group_members",
        { group_id: groupId, user_id: userId },
        at,
      )
    },
  }
}
