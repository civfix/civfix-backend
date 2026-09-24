import type postgres from "postgres"
import type { Queryable, Sql } from "../db/client.js"
import type {
  PersonView,
  ProfileEventsPage,
  ProfileEventsPageArgs,
  ProfileStats,
  SocialRepository,
  UpcomingEventsArgs,
} from "./social-service.js"
import type { CleanupRecord, CleanupPersonView } from "./cleanup-service.js"
import type {
  CleanupStatus,
  CleanupType,
  EventAddressSource,
  EventKind,
  EventVisibility,
  SocialLinks,
} from "@civfix/shared"
import {
  encodeNameCursor,
  encodeTimeCursor,
  pageWith,
  paginate,
  parseNameCursor,
  parseTimeCursor,
} from "../db/cursor-helpers.js"
import { escapeLike } from "./admin/like.js"
import { cleanupStatusExpr, goingScalar } from "./cleanup-sql.js"
import { servedKeyExpr } from "./media-served-key.js"
import { CIVFIX_OFFICIAL_USER_ID } from "../auth/official-account.js"

export { searchByHandlePrefix, searchMentionable } from "./user-search.drizzle.js"
export {
  resolveHandles,
  resolveMentionTargets,
  resolveUserIdsToMentions,
} from "./mention-resolver.drizzle.js"

type SqlFragment = postgres.Fragment

const SUGGEST_NEARBY_METERS = 25_000

export const SUGGEST_CANDIDATE_POOL = 200

export const SUGGEST_CANDIDATE_RADIUS_DEG = 2.5

export const SUGGEST_KNN_INDEX = "users_last_activity_gist"
export const SUGGEST_RECENCY_INDEX = "users_last_activity_at_idx"

export interface PersonRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  avatar_r2_key: string | null
  avatar_url: string | null
  social_links?: SocialLinks | null
  donation_url?: string | null
  show_volunteer_hours: boolean | null
}

interface PersonRowSelectWithFollow extends PersonRowSelect {
  is_following: boolean
}

export function toPersonView(r: PersonRowSelect): PersonView {
  return {
    id: r.id,
    displayName: r.display_name,
    handle: r.handle,
    bio: r.bio,
    followers: Number(r.followers),
    following: Number(r.following),
    avatarR2Key: r.avatar_r2_key,
    avatarUrl: r.avatar_url,
    socialLinks: r.social_links ?? null,
    donationUrl: r.donation_url ?? null,
    showVolunteerHours: r.show_volunteer_hours === undefined ? false : r.show_volunteer_hours,
  }
}

function pagePeople(
  rows: PersonRowSelectWithFollow[],
  limit: number,
): { items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null } {
  const { items, nextCursor } = pageWith(rows, limit, (last) =>
    encodeNameCursor({ name: last.display_name, id: last.id }),
  )
  return {
    items: items.map((r) => ({ ...toPersonView(r), isFollowing: r.is_following })),
    nextCursor,
  }
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
  completed_at: Date | null
  ends_at: Date
  timezone: string | null
  status: CleanupStatus
  bring: string[] | null
  address: string | null
  address_source: EventAddressSource | null
  jurisdiction_geoid: string | null
  reference_code: string | null
  created_at: Date
  capacity: number | null
  visibility: EventVisibility
  going: number
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
  org_avatar_url: string | null
  org_donation_url: string | null
}

function toCleanupRecord(r: CleanupRowSelect): CleanupRecord {
  const organizer: CleanupPersonView = {
    id: r.organizer_user_id,
    displayName: r.org_display_name,
    handle: r.org_handle,
    bio: r.org_bio,
    avatarUrl: r.org_avatar_url,
    donationUrl: r.org_donation_url,
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
    completedAt: r.completed_at,
    status: r.status,
    bring: r.bring,
    address: r.address,
    addressSource: r.address_source,
    jurisdictionGeoid: r.jurisdiction_geoid,
    referenceCode: r.reference_code,
    createdAt: r.created_at,
    capacity: r.capacity,
    going: Number(r.going),
    dist: null,
    organizer,
    endsAt: r.ends_at,
    timezone: r.timezone,
    visibility: r.visibility,
    coverMediaId: null,
    coverKey: null,
    galleryMediaIds: [],
    donationUrl: null,
    pageSlug: null,
    registrationOpensAt: null,
    registrationClosesAt: null,
    organizationId: null,
    organization: null,
    reminderOffsetsMin: null,
    hostReplyTo: null,
    hostReplyToVerifiedAt: null,
  }
}

function organizedIds(sql: Sql, userId: string): ReturnType<Sql> {
  return sql`SELECT id AS cleanup_id FROM cleanups WHERE organizer_user_id = ${userId}`
}

function organizedOrAttendedIds(sql: Sql, userId: string): ReturnType<Sql> {
  return sql`
    SELECT id AS cleanup_id FROM cleanups WHERE organizer_user_id = ${userId}
    UNION
    SELECT cleanup_id FROM cleanup_members WHERE user_id = ${userId}
  `
}

function profileEventRows(
  sql: Sql,
  args: { ids: ReturnType<Sql>; where: ReturnType<Sql>; order: ReturnType<Sql>; limit: number },
): Promise<CleanupRowSelect[]> {
  return sql<CleanupRowSelect[]>`
    WITH ids AS (${args.ids})
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
      c.completed_at,
      c.ends_at,
      c.timezone,
      ${cleanupStatusExpr(sql)} AS status,
      c.bring,
      c.address,
      c.address_source,
      c.jurisdiction_geoid,
      c.reference_code,
      c.created_at,
      c.capacity,
      c.visibility,
      ${goingScalar(sql)} AS going,
      u.display_name AS org_display_name,
      u.handle AS org_handle,
      u.bio AS org_bio,
      u.avatar_url AS org_avatar_url,
      u.donation_url AS org_donation_url
    FROM cleanups c
    JOIN ids ON ids.cleanup_id = c.id
    JOIN users u ON u.id = c.organizer_user_id
    WHERE c.status <> 'cancelled'
      AND c.visibility = 'public'
      ${args.where}
    ${args.order}
    LIMIT ${args.limit}
  `
}

type ConnectionRow = PersonRowSelectWithFollow & { edge_created_at: Date }

function pageConnections(
  rows: ConnectionRow[],
  limit: number,
): { items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null } {
  const { items, nextCursor } = paginate(rows, limit, (last) => ({
    at: last.edge_created_at,
    id: last.id,
  }))
  const sorted = [...items].sort((a, b) => {
    const nameCmp = a.display_name.localeCompare(b.display_name)
    return nameCmp !== 0 ? nameCmp : a.id.localeCompare(b.id)
  })
  return {
    items: sorted.map((r) => ({ ...toPersonView(r), isFollowing: r.is_following })),
    nextCursor,
  }
}

async function connectionsPage(
  sql: Sql,
  args: { viewerId: string | null; cursor: string | null; limit: number },
  joinPredicate: ReturnType<Sql>,
): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }> {
  const cursor = parseTimeCursor(args.cursor)
  const viewerId = args.viewerId
  const cursorFilter =
    cursor !== null ? sql`AND (f.created_at, u.id) < (${cursor.at}, ${cursor.id}::uuid)` : sql``
  const followingExpr =
    viewerId !== null
      ? sql`EXISTS (SELECT 1 FROM follows_people ff WHERE ff.follower_id = ${viewerId} AND ff.followee_id = u.id)`
      : sql`FALSE`
  const blockFilter =
    viewerId !== null
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
        )`
      : sql``

  const rows = await sql<ConnectionRow[]>`
    SELECT
      u.id,
      u.display_name,
      u.handle,
      u.bio,
      u.follower_count AS followers,
      u.following_count AS following,
      ${servedKeyExpr(sql, "am")} AS avatar_r2_key,
      u.avatar_url,
      u.show_volunteer_hours,
      u.edge_created_at,
      ${followingExpr} AS is_following
    FROM (
      SELECT
        u.id, u.display_name, u.handle, u.bio, u.avatar_media_id, u.avatar_url,
        u.show_volunteer_hours,
        u.follower_count, u.following_count,
        f.created_at AS edge_created_at
      FROM users u
      JOIN follows_people f ON ${joinPredicate}
      WHERE u.deleted_at IS NULL
        ${blockFilter}
        ${cursorFilter}
      ORDER BY f.created_at DESC, u.id DESC
      LIMIT ${args.limit + 1}
    ) u
    LEFT JOIN media_assets am ON am.id = u.avatar_media_id
    ORDER BY u.edge_created_at DESC, u.id DESC
  `
  return pageConnections(rows, args.limit)
}

function suggestFollowsStatement(
  sql: Queryable,
  args: { viewerId: string; limit: number },
): SqlFragment {
  const viewerId = args.viewerId
  const eligible = (): SqlFragment => sql`
    u.deleted_at IS NULL
    AND u.handle IS NOT NULL
    AND u.id <> ${viewerId}
    AND u.id <> ${CIVFIX_OFFICIAL_USER_ID}
    AND NOT EXISTS (
      SELECT 1 FROM follows_people f
      WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_blocks b
      WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
         OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
    )
  `
  return sql`
        WITH viewer_point AS (
          SELECT p.geom FROM (
            SELECT r.geom, r.created_at FROM reports r
              WHERE r.reporter_user_id = ${viewerId} AND r.deleted_at IS NULL
            UNION ALL
            SELECT c.geom, c.created_at FROM cleanups c
              WHERE c.organizer_user_id = ${viewerId}
            UNION ALL
            SELECT c.geom, c.created_at
              FROM cleanups c JOIN cleanup_members m ON m.cleanup_id = c.id
              WHERE m.user_id = ${viewerId}
          ) p
          ORDER BY p.created_at DESC NULLS LAST
          LIMIT 1
        ),
        near_pool AS (
          SELECT n.id
          FROM viewer_point vp
          CROSS JOIN LATERAL (
            SELECT u.id
            FROM users u
            WHERE ${eligible()}
              AND u.last_activity_geom IS NOT NULL
              AND ST_DWithin(u.last_activity_geom, vp.geom, ${SUGGEST_CANDIDATE_RADIUS_DEG})
            ORDER BY u.last_activity_geom <-> vp.geom
            LIMIT ${SUGGEST_CANDIDATE_POOL}
          ) n
        ),
        recent_pool AS (
          SELECT u.id
          FROM users u
          WHERE ${eligible()}
            AND u.last_activity_at IS NOT NULL
          ORDER BY u.last_activity_at DESC
          LIMIT ${SUGGEST_CANDIDATE_POOL}
        ),
        new_pool AS (
          SELECT u.id
          FROM users u
          WHERE ${eligible()}
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT ${SUGGEST_CANDIDATE_POOL}
        ),
        pool AS (
          SELECT id FROM near_pool
          UNION SELECT id FROM recent_pool
          UNION SELECT id FROM new_pool
        ),
        candidates AS (
          SELECT
            u.id,
            u.display_name,
            u.handle,
            u.bio,
            u.avatar_media_id,
            u.avatar_url,
            u.show_volunteer_hours,
            u.created_at,
            u.follower_count AS followers,
            u.following_count AS following,
            EXISTS (
              SELECT 1 FROM cleanups oc
              WHERE oc.organizer_user_id = u.id AND oc.visibility = 'public'
            ) AS is_organizer,
            dist.meters AS dist_meters,
            (dist.meters IS NOT NULL AND dist.meters <= ${SUGGEST_NEARBY_METERS}) AS is_near
          FROM pool p
          JOIN users u ON u.id = p.id
          LEFT JOIN LATERAL (
            SELECT ST_Distance(vp.geom::geography, u.last_activity_geom::geography) AS meters
            FROM viewer_point vp
            WHERE u.last_activity_geom IS NOT NULL
          ) dist ON TRUE
        ),
        ranked AS (
          SELECT * FROM candidates
          ORDER BY
            (is_near AND is_organizer) DESC,
            is_near DESC,
            is_organizer DESC,
            dist_meters ASC NULLS LAST,
            followers DESC,
            created_at DESC
          LIMIT ${args.limit}
        )
        SELECT
          c.id,
          c.display_name,
          c.handle,
          c.bio,
          c.followers,
          c.following,
          ${servedKeyExpr(sql, "am")} AS avatar_r2_key,
          c.avatar_url,
          c.show_volunteer_hours,
          c.is_organizer
        FROM ranked c
        LEFT JOIN media_assets am ON am.id = c.avatar_media_id
        ORDER BY
          (c.is_near AND c.is_organizer) DESC,
          c.is_near DESC,
          c.is_organizer DESC,
          c.dist_meters ASC NULLS LAST,
          c.followers DESC,
          c.created_at DESC
      `
}

export async function explainSuggestFollows(
  sql: Queryable,
  args: { viewerId: string; limit: number },
): Promise<string> {
  const rows = await sql<Record<string, string>[]>`
    EXPLAIN (COSTS OFF, VERBOSE) ${suggestFollowsStatement(sql, args)}
  `
  return rows.map((r) => Object.values(r)[0] ?? "").join("\n")
}

export function makeDrizzleSocialRepository(sql: Sql): SocialRepository {
  async function findPerson(keyFilter: ReturnType<Sql>): Promise<PersonView | null> {
    const rows = await sql<PersonRowSelect[]>`
      SELECT
        u.id,
        u.display_name,
        u.handle,
        u.bio,
        u.follower_count AS followers,
        u.following_count AS following,
        ${servedKeyExpr(sql, "am")} AS avatar_r2_key,
        u.avatar_url,
        u.social_links,
        u.donation_url,
        u.show_volunteer_hours
      FROM users u
      LEFT JOIN media_assets am ON am.id = u.avatar_media_id
      WHERE ${keyFilter} AND u.deleted_at IS NULL
      LIMIT 1
    `
    return rows[0] ? toPersonView(rows[0]) : null
  }

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
          ? sql`AND ((u.handle::text) ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\' OR u.display_name ILIKE ${"%" + escapeLike(args.q) + "%"} ESCAPE '\\')`
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
      const blockFilter =
        viewerId !== null
          ? sql`AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
            )`
          : sql``

      const rows = await sql<PersonRowSelectWithFollow[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          u.follower_count AS followers,
          u.following_count AS following,
          ${servedKeyExpr(sql, "am")} AS avatar_r2_key,
          u.avatar_url,
          u.show_volunteer_hours,
          ${followingExpr} AS is_following
        FROM (
          SELECT
            u.id, u.display_name, u.handle, u.bio, u.avatar_media_id, u.avatar_url,
            u.show_volunteer_hours,
            u.follower_count, u.following_count
          FROM users u
          WHERE u.deleted_at IS NULL
            ${selfFilter}
            ${blockFilter}
            ${qFilter}
            ${cursorFilter}
          ORDER BY u.display_name ASC, u.id ASC
          LIMIT ${args.limit + 1}
        ) u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        ORDER BY u.display_name ASC, u.id ASC
      `
      return pagePeople(rows, args.limit)
    },

    suggestFollows(args): Promise<Array<PersonView & { isFollowing: boolean }>> {
      return sql<Array<PersonRowSelect & { is_organizer: boolean }>>`
        ${suggestFollowsStatement(sql, args)}
      `.then((rows) => rows.map((r) => ({ ...toPersonView(r), isFollowing: false })))
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
      return findPerson(sql`u.id = ${id}`)
    },

    async findPersonByHandle(handle: string): Promise<PersonView | null> {
      return findPerson(sql`u.handle = ${handle}`)
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
      return sql.begin(async (tx) => {
        const inserted = await tx<{ follower_id: string }[]>`
          INSERT INTO follows_people (follower_id, followee_id)
          VALUES (${followerId}, ${followeeId})
          ON CONFLICT (follower_id, followee_id) DO NOTHING
          RETURNING follower_id
        `
        if (inserted.length === 0) return { exists: true, created: false }
        await tx`
          UPDATE users SET
            follower_count = follower_count + CASE WHEN id = ${followeeId} THEN 1 ELSE 0 END,
            following_count = following_count + CASE WHEN id = ${followerId} THEN 1 ELSE 0 END
          WHERE id IN (${followerId}, ${followeeId})
        `
        return { exists: true, created: true }
      })
    },

    async removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }> {
      if (!(await userExists(followeeId))) return { exists: false }
      return sql.begin(async (tx) => {
        const removed = await tx<{ follower_id: string }[]>`
          DELETE FROM follows_people
          WHERE follower_id = ${followerId} AND followee_id = ${followeeId}
          RETURNING follower_id
        `
        if (removed.length === 0) return { exists: true }
        await tx`
          UPDATE users SET
            follower_count = GREATEST(follower_count - CASE WHEN id = ${followeeId} THEN 1 ELSE 0 END, 0),
            following_count = GREATEST(following_count - CASE WHEN id = ${followerId} THEN 1 ELSE 0 END, 0)
          WHERE id IN (${followerId}, ${followeeId})
        `
        return { exists: true }
      })
    },

    async followerCount(userId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT follower_count AS count FROM users WHERE id = ${userId}
      `
      return rows[0]?.count ?? 0
    },

    async pastEventsPageFor(
      userId: string,
      args: ProfileEventsPageArgs,
    ): Promise<ProfileEventsPage> {
      const cursor = parseTimeCursor(args.cursor)
      const rows = await profileEventRows(sql, {
        ids: organizedOrAttendedIds(sql, userId),
        where:
          cursor !== null
            ? sql`AND c.scheduled_at < now() AND (c.scheduled_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)`
            : sql`AND c.scheduled_at < now()`,
        order: sql`ORDER BY c.scheduled_at DESC, c.id DESC`,
        limit: args.limit + 1,
      })
      const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.scheduled_at, id: last.id }),
      )
      return { items: items.map(toCleanupRecord), nextCursor }
    },

    async upcomingEventsFor(userId: string, args: UpcomingEventsArgs): Promise<CleanupRecord[]> {
      const rows = await profileEventRows(sql, {
        ids: args.includeAttending
          ? organizedOrAttendedIds(sql, userId)
          : organizedIds(sql, userId),
        where: sql`AND c.scheduled_at >= now()`,
        order: sql`ORDER BY c.scheduled_at ASC, c.id ASC`,
        limit: args.limit,
      })
      return rows.map(toCleanupRecord)
    },

    async statsFor(userId: string): Promise<ProfileStats> {
      const rows = await sql<{ reports: number; fixed: number; cleanups: number }[]>`
        SELECT
          (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = ${userId} AND r.deleted_at IS NULL) AS reports,
          (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = ${userId} AND r.deleted_at IS NULL AND r.status = 'resolved') AS fixed,
          (
            SELECT count(*)::int FROM cleanups c
            WHERE c.organizer_user_id = ${userId} AND c.visibility = 'public'
          ) AS cleanups
      `
      return {
        reports: rows[0]?.reports ?? 0,
        fixed: rows[0]?.fixed ?? 0,
        cleanups: rows[0]?.cleanups ?? 0,
      }
    },
  }
}
