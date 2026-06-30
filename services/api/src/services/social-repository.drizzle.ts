
import type { Sql } from "../db/client.js"
import type {
  PersonView,
  ProfileStats,
  SocialRepository,
} from "./social-service.js"
import type { CleanupRecord, CleanupPersonView } from "./cleanup-service.js"
import type { CleanupStatus, CleanupType, EventKind, SocialLinks } from "@civfix/shared"
import { parseNameCursor } from "../db/cursor-helpers.js"
import { escapeLike } from "./admin/like.js"

export {
  searchByHandlePrefix,
  searchMentionable,
} from "./user-search.drizzle.js"
export {
  resolveHandles,
  resolveMentionTargets,
  resolveUserIdsToMentions,
} from "./mention-resolver.drizzle.js"

interface PersonRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  verified: boolean
  avatar_r2_key: string | null
  avatar_url: string | null
  social_links?: SocialLinks | null
}

interface PersonRowSelectWithFollow extends PersonRowSelect {
  is_following: boolean
}

function toPersonView(r: PersonRowSelect): PersonView {
  return {
    id: r.id,
    displayName: r.display_name,
    handle: r.handle,
    bio: r.bio,
    followers: Number(r.followers),
    following: Number(r.following),
    verified: r.verified,
    avatarR2Key: r.avatar_r2_key,
    avatarUrl: r.avatar_url,
    socialLinks: r.social_links ?? null,
  }
}

function pagePeople(
  rows: PersonRowSelectWithFollow[],
  limit: number,
): { items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const items = page.map((r) => ({ ...toPersonView(r), isFollowing: r.is_following }))
  const nextCursor = hasMore && last ? `${last.display_name}|${last.id}` : null
  return { items, nextCursor }
}

interface CleanupRowSelect {
  id: string
  organizer_user_id: string
  type: CleanupType
  event_kind: EventKind
  title: string
  description: string | null
  lng: number
  lat: number
  scheduled_at: Date
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  jurisdiction_geoid: string | null
  reference_code: string | null
  created_at: Date
  going: number
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
}

function toCleanupRecord(r: CleanupRowSelect): CleanupRecord {
  const organizer: CleanupPersonView = {
    id: r.organizer_user_id,
    displayName: r.org_display_name,
    handle: r.org_handle,
    bio: r.org_bio,
  }
  return {
    id: r.id,
    organizerUserId: r.organizer_user_id,
    type: r.type,
    eventKind: r.event_kind,
    title: r.title,
    description: r.description,
    lat: r.lat,
    lng: r.lng,
    scheduledAt: r.scheduled_at,
    status: r.status,
    bring: r.bring,
    address: r.address,
    jurisdictionGeoid: r.jurisdiction_geoid,
    referenceCode: r.reference_code,
    createdAt: r.created_at,
    going: Number(r.going),
    dist: null,
    organizer,
  }
}

async function connectionsPage(
  sql: Sql,
  args: { viewerId: string | null; cursor: string | null; limit: number },
  joinPredicate: ReturnType<Sql>,
): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
  const cursor = parseNameCursor(args.cursor)
  const viewerId = args.viewerId
  const cursorFilter =
    cursor !== null
      ? sql`AND (u.display_name, u.id) > (${cursor.name}, ${cursor.id}::uuid)`
      : sql``
  const followingExpr =
    viewerId !== null
      ? sql`EXISTS (SELECT 1 FROM follows_people ff WHERE ff.follower_id = ${viewerId} AND ff.followee_id = u.id)`
      : sql`FALSE`

  const rows = await sql<PersonRowSelectWithFollow[]>`
    SELECT
      u.id,
      u.display_name,
      u.handle,
      u.bio,
      (SELECT count(*)::int FROM follows_people f WHERE f.followee_id = u.id) AS followers,
      (SELECT count(*)::int FROM follows_people f WHERE f.follower_id = u.id) AS following,
      EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
      am.r2_key AS avatar_r2_key,
      u.avatar_url,
      ${followingExpr} AS is_following
    FROM users u
    JOIN follows_people f ON ${joinPredicate}
    LEFT JOIN media_assets am ON am.id = u.avatar_media_id
    WHERE u.deleted_at IS NULL
      ${cursorFilter}
    ORDER BY u.display_name ASC, u.id ASC
    LIMIT ${args.limit + 1}
  `
  return pagePeople(rows, args.limit)
}

export function makeDrizzleSocialRepository(sql: Sql): SocialRepository {
  async function userExists(id: string): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `
    return rows.length > 0
  }

  return {
    async listPeople(args): Promise<{
      items: Array<PersonView & { isFollowing: boolean }>
      nextCursor: string | null
    }> {
      const cursor = parseNameCursor(args.cursor)
      const viewerId = args.viewerId
      const qFilter =
        args.q !== null
          ?
            sql`AND ((u.handle::text) ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\' OR u.display_name ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\')`
          : sql``
      const selfFilter = viewerId !== null ? sql`AND u.id <> ${viewerId}` : sql``
      const cursorFilter =
        cursor !== null
          ? sql`AND (u.display_name, u.id) > (${cursor.name}, ${cursor.id}::uuid)`
          : sql``
      const followingExpr =
        viewerId !== null
          ? sql`EXISTS (SELECT 1 FROM follows_people f WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id)`
          : sql`FALSE`

      const rows = await sql<PersonRowSelectWithFollow[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          (SELECT count(*)::int FROM follows_people f WHERE f.followee_id = u.id) AS followers,
          (SELECT count(*)::int FROM follows_people f WHERE f.follower_id = u.id) AS following,
          EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
          am.r2_key AS avatar_r2_key,
          u.avatar_url,
          ${followingExpr} AS is_following
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.deleted_at IS NULL
          ${selfFilter}
          ${qFilter}
          ${cursorFilter}
        ORDER BY u.display_name ASC, u.id ASC
        LIMIT ${args.limit + 1}
      `
      return pagePeople(rows, args.limit)
    },

    async listFollowers(args): Promise<{
      items: Array<PersonView & { isFollowing: boolean }>
      nextCursor: string | null
    }> {
      return connectionsPage(sql, args, sql`f.followee_id = ${args.id} AND f.follower_id = u.id`)
    },

    async listFollowing(args): Promise<{
      items: Array<PersonView & { isFollowing: boolean }>
      nextCursor: string | null
    }> {
      return connectionsPage(sql, args, sql`f.follower_id = ${args.id} AND f.followee_id = u.id`)
    },

    async findPersonById(id: string): Promise<PersonView | null> {
      const rows = await sql<PersonRowSelect[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          (SELECT count(*)::int FROM follows_people f WHERE f.followee_id = u.id) AS followers,
          (SELECT count(*)::int FROM follows_people f WHERE f.follower_id = u.id) AS following,
          EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
          am.r2_key AS avatar_r2_key,
          u.avatar_url,
          u.social_links
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.id = ${id} AND u.deleted_at IS NULL
        LIMIT 1
      `
      return rows[0] ? toPersonView(rows[0]) : null
    },

    async findPersonByHandle(handle: string): Promise<PersonView | null> {
      const rows = await sql<PersonRowSelect[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          (SELECT count(*)::int FROM follows_people f WHERE f.followee_id = u.id) AS followers,
          (SELECT count(*)::int FROM follows_people f WHERE f.follower_id = u.id) AS following,
          EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
          am.r2_key AS avatar_r2_key,
          u.avatar_url,
          u.social_links
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.handle = ${handle} AND u.deleted_at IS NULL
        LIMIT 1
      `
      return rows[0] ? toPersonView(rows[0]) : null
    },

    async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
      const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM follows_people
        WHERE follower_id = ${followerId} AND followee_id = ${followeeId}
        LIMIT 1
      `
      return rows.length > 0
    },

    async addFollow(
      followerId: string,
      followeeId: string,
    ): Promise<{ exists: boolean; created: boolean }> {
      if (!(await userExists(followeeId))) return { exists: false, created: false }
      const inserted = await sql<{ follower_id: string }[]>`
        INSERT INTO follows_people (follower_id, followee_id)
        VALUES (${followerId}, ${followeeId})
        ON CONFLICT (follower_id, followee_id) DO NOTHING
        RETURNING follower_id
      `
      return { exists: true, created: inserted.length > 0 }
    },

    async removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }> {
      if (!(await userExists(followeeId))) return { exists: false }
      await sql`
        DELETE FROM follows_people WHERE follower_id = ${followerId} AND followee_id = ${followeeId}
      `
      return { exists: true }
    },

    async followerCount(userId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM follows_people WHERE followee_id = ${userId}
      `
      return rows[0]?.count ?? 0
    },

    async pastEventsFor(userId: string, limit: number): Promise<CleanupRecord[]> {
      const rows = await sql<CleanupRowSelect[]>`
        WITH ids AS (
          SELECT id AS cleanup_id FROM cleanups WHERE organizer_user_id = ${userId}
          UNION
          SELECT cleanup_id FROM cleanup_members WHERE user_id = ${userId}
        )
        SELECT
          c.id,
          c.organizer_user_id,
          c.type,
          c.event_kind,
          c.title,
          c.description,
          ST_X(c.geom) AS lng,
          ST_Y(c.geom) AS lat,
          c.scheduled_at,
          c.status,
          c.bring,
          c.address,
          c.jurisdiction_geoid,
          c.reference_code,
          c.created_at,
          (SELECT count(*)::int FROM cleanup_members m WHERE m.cleanup_id = c.id) AS going,
          u.display_name AS org_display_name,
          u.handle AS org_handle,
          u.bio AS org_bio
        FROM cleanups c
        JOIN ids ON ids.cleanup_id = c.id
        JOIN users u ON u.id = c.organizer_user_id
        ORDER BY c.scheduled_at DESC, c.id DESC
        LIMIT ${limit}
      `
      return rows.map(toCleanupRecord)
    },

    async statsFor(userId: string): Promise<ProfileStats> {
      const rows = await sql<{ reports: number; cleanups: number }[]>`
        SELECT
          (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = ${userId} AND r.deleted_at IS NULL) AS reports,
          (SELECT count(*)::int FROM cleanups c WHERE c.organizer_user_id = ${userId}) AS cleanups
      `
      return {
        reports: rows[0]?.reports ?? 0,
        cleanups: rows[0]?.cleanups ?? 0,
      }
    },
  }
}
