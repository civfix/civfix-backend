/**
 * P4 Task 4.3: chat_groups + chat_group_members persistence (migration 0047).
 *
 * The GROUP MANAGEMENT store: room rows (chat_groups) and the three-tier membership ladder
 * (chat_group_members: owner|admin|member). Group MESSAGES are NOT here — they ride the unified
 * chat_messages table via the group_id scope in chat-repository.drizzle.ts, exactly as report chat
 * rides report_id.
 *
 * Pure data access; every authorization gate (who may update / add / remove / set roles) lives in
 * chat-group-service.ts. Written against the raw postgres-js tag (`Sql`) like the other chat repos.
 *
 * MEMBER-LIST ORDERING (documented contract, mirrored by the keyset cursor): role first
 * (owner, then admins, then members), joined_at ASC then user_id ASC within a tier — the same shape
 * as the cleanup attendee roster's `(role='organizer') DESC, joined_at ASC` ordering. The cursor is
 * the LAST ROW'S user_id; resuming re-resolves that member's (role, joined_at) and keysets on
 * (role_rank, joined_at, user_id). A cursor whose membership row vanished mid-pagination falls back
 * to the first page (same stance as an unknown `before` history cursor).
 *
 * AVATARS: the group avatar is a media_assets row (avatar_media_id, ON DELETE SET NULL). Clients
 * upload via the presign flow and pass avatarUploadId; findMediaIdByUploadId resolves it (the
 * capability model: knowing the unguessable uploadId is the proof — a miss is silently ignored,
 * mirroring the users-avatar finalize in auth/pg-stores). Hydration serves the avatar only once the
 * media worker promoted it to status 'ready' (the EXIF/GPS privacy gate all message attachments
 * respect); a still-validating avatar reads as null until then.
 */

import type { Sql } from "../db/client.js"
import type { MediaDTO, MediaKind, MediaStatus, PersonDTO } from "@civfix/shared"
import type { ChatGroupKind, ChatGroupVisibility } from "../db/schema/chat-groups.js"
import type { GROUP_MEMBER_ROLE_VALUES } from "../db/schema/types.js"
import type { PresignMedia } from "./media-presign.js"
import { publicAuthorIdentity } from "./public-author.js"
import { isUuid } from "../db/cursor-helpers.js"

export type GroupMemberRole = (typeof GROUP_MEMBER_ROLE_VALUES)[number]

/**
 * The kind + visibility of a group plus the viewer's role in it (null = not a member), resolved in ONE
 * query — the P5 channel/public-read gate needs all three at once (the WS group lane's read-vs-send
 * decision and the edit route's send-permission check). `null` from accessOf = the group row is gone.
 */
export interface GroupRoomAccess {
  kind: ChatGroupKind
  visibility: ChatGroupVisibility
  role: GroupMemberRole | null
}

/**
 * P5 send-permission predicate: who may POST (and type / edit) in a group room. A regular group
 * ('group') is member-writable; a CHANNEL is owner/admin-only (members are read-only). Single-sourced
 * so the WS send lane, the edit route, and any future caller all agree — a non-member never posts.
 */
export function canPostToGroup(access: { kind: ChatGroupKind; role: GroupMemberRole | null }): boolean {
  if (access.role === null) return false
  return access.kind === "group" || access.role === "owner" || access.role === "admin"
}

/** A chat_groups row with its avatar hydrated (null = none or not yet 'ready') and live member count. */
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

/** One membership row hydrated to the wire shape (user as PersonDTO, joined_at as Date). */
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
  /**
   * Insert the group + the owner membership row (role 'owner') + the given member rows (role
   * 'member') in ONE transaction; returns the new group id. `memberIds` must already be deduped,
   * self-free, and block-filtered (the service owns those gates).
   */
  create(input: CreateChatGroupInput, memberIds: string[]): Promise<string>
  findById(id: string): Promise<ChatGroupView | null>
  /** Apply a set-only patch (omitted keys unchanged). No-op when the patch is empty. */
  update(id: string, patch: UpdateChatGroupPatch): Promise<void>
  /** The user's chat_group_members.role, or null when not a member (feeds the chat-powers resolver). */
  roleOf(groupId: string, userId: string): Promise<GroupMemberRole | null>
  /**
   * P5: the group's kind + visibility + the viewer's role in ONE round trip; null when the group row is
   * gone. Backs the WS group lane's read-vs-send/channel gate and the edit route's send-permission check.
   */
  accessOf(groupId: string, userId: string): Promise<GroupRoomAccess | null>
  /** Idempotent bulk insert as role 'member' (ON CONFLICT DO NOTHING keeps existing roles). */
  addMembers(groupId: string, userIds: string[]): Promise<void>
  /** Delete the membership row; true when a row was actually removed. */
  removeMember(groupId: string, userId: string): Promise<boolean>
  /** Flip an EXISTING member's role (admin <-> member); true when a row matched. */
  setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<boolean>
  /** One hydrated membership row, or null when not a member. */
  findMember(groupId: string, userId: string, viewerId: string | null): Promise<GroupMemberView | null>
  /** Keyset page of members in the documented ordering (see module banner). */
  listMembers(
    groupId: string,
    viewerId: string | null,
    cursor: string | null,
    limit: number,
  ): Promise<{ members: GroupMemberView[]; nextCursor: string | null }>
  /** Resolve a presign-flow uploadId to its media_assets id; null when unknown (silently ignored). */
  findMediaIdByUploadId(uploadId: string): Promise<string | null>
  /**
   * The subset of `candidateIds` the actor may actually invite, in input order — ONE round trip
   * (review fix: replaces a per-candidate blocked-pair fan-out). A candidate survives only when it
   * EXISTS in users (a schema-valid but unknown uuid would otherwise trip the membership FK -> 500),
   * is not soft-deleted, and is not blocked either way with `actorId`. Dropped ids are silently
   * skipped, never errors (the create/addMembers "skip, don't leak" contract).
   */
  invitableIdsOf(actorId: string, candidateIds: string[]): Promise<string[]>
  /** Member user ids of a group (mention scoping + thread signals; mirrors report listMemberIds). */
  listMemberIds(groupId: string): Promise<string[]>
  /**
   * WS ack (4.4): set chat_group_members.last_read_at to the target message's created_at, only ever
   * moving the watermark FORWARD (the report-chat advanceReadWatermark twin, scoped on group_id).
   * No-op for non-members or when the message id does not resolve to a row in THIS group.
   */
  advanceReadWatermark(groupId: string, userId: string, upToMessageId: string): Promise<void>
  /** Mark-read-on-join (4.4): monotonic last_read_at = max(current, at). No-op for non-members. */
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

interface MemberRowSelect {
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
}

function toMemberView(r: MemberRowSelect): GroupMemberView {
  const author = publicAuthorIdentity({
    id: r.user_id,
    displayName: r.display_name ?? "",
    handle: r.handle,
    avatarUrl: r.avatar_url,
    deletedAt: r.user_deleted_at,
  })
  const user: PersonDTO = {
    id: r.user_id,
    name: author.name,
    handle: author.handle,
    bio: author.deleted ? null : r.bio,
    avatar: author.avatar,
    ...(author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
    // The roster does not load follower counts (same stance as the cleanup attendee roster).
    followers: 0,
    following: 0,
    isFollowing: r.is_following,
    ...(r.verified ? { verified: true } : {}),
    ...(author.deleted ? { deleted: true } : {}),
  }
  return { user, role: r.role, joinedAt: r.joined_at }
}

export function makeChatGroupRepository(sql: Sql, presign?: PresignMedia): ChatGroupRepository {
  async function toGroupView(r: GroupRowSelect): Promise<ChatGroupView> {
    // Serve the avatar only once 'ready' (EXIF-strip privacy gate); a presign-less wiring (offline
    // harnesses) also reads as null rather than leaking raw keys.
    let avatar: MediaDTO | null = null
    if (presign && r.avatar_id !== null && r.avatar_status === "ready" && r.avatar_r2_key !== null) {
      const { url, thumbUrl } = await presign(r.avatar_r2_key, r.avatar_thumb_key)
      avatar = {
        id: r.avatar_id,
        // kind is NOT NULL on media_assets; the fallback only satisfies the joined-nullable type.
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
      ${followingExpr} AS is_following
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
          a.r2_key AS avatar_r2_key,
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
      await sql`
        INSERT INTO chat_group_members ${sql(rows, "group_id", "user_id", "role")}
        ON CONFLICT (group_id, user_id) DO NOTHING
      `
    },

    async removeMember(groupId: string, userId: string): Promise<boolean> {
      const rows = await sql<{ user_id: string }[]>`
        DELETE FROM chat_group_members
        WHERE group_id = ${groupId} AND user_id = ${userId}
        RETURNING user_id
      `
      return rows.length > 0
    },

    async setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<boolean> {
      // The owner row is untouchable here by construction: the service rejects owner targets, and the
      // WHERE below refuses to demote an 'owner' row even if a future caller slips one through.
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
      // Resolve the cursor row's keyset position; a stale/foreign cursor falls back to page one.
      // The anchor's (rank, joined_at, user_id) tuple deliberately NEVER leaves the database (a
      // row-valued subquery): round-tripping joined_at through the driver truncates microseconds to
      // milliseconds (postgres-js serializes Date/`::timestamptz`-hinted params via a JS Date), and a
      // same-tx roster shares ONE microsecond timestamp — a truncated anchor would compare "less
      // than" every tied row and re-include the previous page. The existence pre-check keeps the
      // page-one fallback (a vanished cursor must not turn the filter into an all-NULL empty page).
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

    async findMediaIdByUploadId(uploadId: string): Promise<string | null> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_assets WHERE upload_id = ${uploadId} LIMIT 1
      `
      return rows[0]?.id ?? null
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
      // Re-project onto the caller's order (the SELECT returns rows in arbitrary order).
      return candidateIds.filter((id) => allowed.has(id))
    },

    async listMemberIds(groupId: string): Promise<string[]> {
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM chat_group_members
        WHERE group_id = ${groupId}
        ORDER BY joined_at ASC, user_id ASC
      `
      return rows.map((r) => r.user_id)
    },

    async advanceReadWatermark(groupId: string, userId: string, upToMessageId: string): Promise<void> {
      // Monotonic (GREATEST against the current value, floored at epoch 0 so a NULL prior watermark is
      // treated as the floor) — the exact report_chat_members twin, scoped on chat_messages.group_id.
      await sql`
        UPDATE chat_group_members m
        SET last_read_at = GREATEST(COALESCE(m.last_read_at, to_timestamp(0)), cm.created_at)
        FROM chat_messages cm
        WHERE m.group_id = ${groupId}
          AND m.user_id = ${userId}
          AND cm.id = ${upToMessageId}
          AND cm.group_id = ${groupId}
      `
    },

    async markRead(groupId: string, userId: string, at: Date): Promise<void> {
      await sql`
        UPDATE chat_group_members
        SET last_read_at = GREATEST(COALESCE(last_read_at, to_timestamp(0)), ${at})
        WHERE group_id = ${groupId} AND user_id = ${userId}
      `
    },
  }
}
