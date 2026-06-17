/**
 * Postgres-backed SocialRepository (the production implementation of the social persistence seam).
 *
 * ALL people/follow/profile access flows through here so the social service stays infra-free and
 * unit-testable with an in-memory repo. Written against the raw postgres-js tag (`Sql`) to match the rest
 * of the backend; the follower/following counts and isFollowing flags are computed inline so a single
 * round-trip builds each list page.
 *
 * DIRECTORY (listPeople): excludes the viewer and soft-deleted users (deleted_at IS NULL). The optional
 * `q` filters case-insensitively on handle OR display_name (ILIKE with the term escaped + wrapped in
 * %...%). Pagination is keyset on (display_name, id) ascending with a `${name}|${id}` cursor; the id
 * tiebreak keeps a total order when names collide, and `|` cannot appear in a UUID so the split is
 * unambiguous (display_name MAY contain `|`, so we split on the LAST delimiter for the cursor parse).
 *
 * PAST EVENTS (pastEventsFor): the cleanups the user organized OR was a member of, most recent first
 * (scheduled_at DESC), projected into the SAME CleanupRecord shape the cleanups domain uses (geom decoded,
 * organizer joined, going counted) so toCleanupDTO renders them identically. `dist` is always null here.
 */

import type { Sql } from "../db/client.js"
import { avatarGradient } from "@civfix/shared"
import type {
  PersonView,
  ProfileStats,
  SocialRepository,
} from "./social-service.js"
import type { CleanupRecord, CleanupPersonView } from "./cleanup-service.js"
import type { CleanupStatus, CleanupType, EventKind, UserSearchResultDTO } from "@civfix/shared"

/** Shape of a person row as selected for the directory/profile (counts joined inline). */
interface PersonRowSelect {
  id: string
  display_name: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  verified: boolean
  /** The avatar media's r2 object key (LEFT JOIN media_assets on users.avatar_media_id), or null. */
  avatar_r2_key: string | null
}

/** The same shape plus the per-row isFollowing flag for the directory list. */
interface PersonRowSelectWithFollow extends PersonRowSelect {
  is_following: boolean
}

/** Project a selected person row into the structural PersonView the service consumes. */
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
  }
}

/** Shape of a cleanup row as selected for pastEvents (geom decoded, organizer joined, going counted). */
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
  created_at: Date
  going: number
  org_display_name: string
  org_handle: string | null
  org_bio: string | null
}

/** Project a selected cleanup row into the structural CleanupRecord (dist always null for pastEvents). */
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
    createdAt: r.created_at,
    going: Number(r.going),
    dist: null,
    organizer,
  }
}

/** Escape an ILIKE search term so %, _ and \ are treated literally inside the %...% wrapper. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Page a follow-connection list (followers OR following) for a target user. Mirrors listPeople's row
 * shape (the same followers/following/verified/avatar subqueries + isFollowing-relative-to-viewer flag +
 * the (display_name, id) keyset cursor) but the candidate set comes from a JOIN against follows_people
 * via the caller-supplied `joinPredicate` (which both filters by the target `id` AND ties `f` to `u`):
 *   - followers:  `f.followee_id = ${id} AND f.follower_id = u.id`  (u is each follower),
 *   - following:  `f.follower_id = ${id} AND f.followee_id = u.id`  (u is each followee).
 * Soft-deleted users are excluded; results are ordered + cursored identically to the directory.
 */
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
      ${followingExpr} AS is_following
    FROM users u
    JOIN follows_people f ON ${joinPredicate}
    LEFT JOIN media_assets am ON am.id = u.avatar_media_id
    WHERE u.deleted_at IS NULL
      ${cursorFilter}
    ORDER BY u.display_name ASC, u.id ASC
    LIMIT ${args.limit + 1}
  `

  const hasMore = rows.length > args.limit
  const page = hasMore ? rows.slice(0, args.limit) : rows
  const last = page[page.length - 1]
  const items = page.map((r) => ({ ...toPersonView(r), isFollowing: r.is_following }))
  const nextCursor = hasMore && last ? `${last.display_name}|${last.id}` : null
  return { items, nextCursor }
}

export function makeDrizzleSocialRepository(sql: Sql): SocialRepository {
  /** Whether a non-deleted user with this id exists. */
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
      // viewerId for the isFollowing correlated subquery + the self-exclusion. NULL-safe via a sentinel:
      // when there is no viewer, `viewerId` is null and both `u.id <> viewerId` (NULL) and the EXISTS
      // subquery collapse to "no exclusion / never following".
      const viewerId = args.viewerId
      const qFilter =
        args.q !== null
          ? // handle is CITEXT; cast to text so the gin_trgm_ops index users_handle_trgm (an expression
            // index on (handle::text), 0014_search_trgm.sql) can serve this ILIKE — a bare `handle ILIKE`
            // would not match the index expression. ILIKE is case-insensitive on text, so matches are
            // identical. display_name is plain text and uses users_display_name_trgm directly.
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

      const hasMore = rows.length > args.limit
      const page = hasMore ? rows.slice(0, args.limit) : rows
      const last = page[page.length - 1]
      const items = page.map((r) => ({ ...toPersonView(r), isFollowing: r.is_following }))
      const nextCursor =
        hasMore && last ? `${last.display_name}|${last.id}` : null
      return { items, nextCursor }
    },

    async listFollowers(args): Promise<{
      items: Array<PersonView & { isFollowing: boolean }>
      nextCursor: string | null
    }> {
      // The people who follow `args.id`: join follows_people where THEY are the follower and `id` is the
      // followee, then project each follower `u`.
      return connectionsPage(sql, args, sql`f.followee_id = ${args.id} AND f.follower_id = u.id`)
    },

    async listFollowing(args): Promise<{
      items: Array<PersonView & { isFollowing: boolean }>
      nextCursor: string | null
    }> {
      // The people `args.id` follows: join follows_people where `id` is the follower and THEY are the
      // followee, then project each followee `u`.
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
          am.r2_key AS avatar_r2_key
        FROM users u
        LEFT JOIN media_assets am ON am.id = u.avatar_media_id
        WHERE u.id = ${id} AND u.deleted_at IS NULL
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
      // Idempotent upsert: re-following collides on PK(follower_id, followee_id) -> DO NOTHING. The
      // RETURNING clause yields a row ONLY when a new edge was actually inserted, so `created` is exact.
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
      // Cleanups the user organized OR was a member of, de-duplicated, most recent first. The organizer
      // person + member count are joined inline so each row builds a full CleanupRecord.
      //
      // Rather than `WHERE c.organizer_user_id = $1 OR EXISTS(member subquery)` — an OR between a
      // sargable indexed column and a correlated EXISTS that Postgres can't satisfy with the organizer
      // index, forcing a seq scan of cleanups + per-row EXISTS + sort — we gather the matching cleanup
      // ids in a CTE that UNIONs two index-seekable arms: the organizer arm seeks cleanups_organizer_idx,
      // the member arm seeks the cleanup_members PK / cleanup_members_user_idx. UNION (not UNION ALL)
      // dedupes ids, so a user who both organizes AND is a member of a cleanup still yields one row.
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

/**
 * @handle PREFIX search for starting a DM (GET /users/search). Returns the minimal, privacy-conscious
 * UserSearchResultDTO (no email/bio/follower counts). Matches `handle ILIKE <prefix>%` case-insensitively
 * (handle is citext) with the prefix escaped so %/_/\ are literal. Exclusions (the locked product rules):
 *   - self (u.id <> viewerId);
 *   - soft-deleted users (deleted_at IS NOT NULL);
 *   - users with NULL handle (not searchable);
 *   - users with allow_direct_messages = false (DM-disabled accounts are hidden from search);
 *   - users blocked either way w.r.t. the viewer (NOT EXISTS over user_blocks in both directions).
 * `q` is the raw query with a leading `@` already stripped by the route. Ordered by handle asc, capped.
 */
export async function searchByHandlePrefix(
  sql: Sql,
  q: string,
  viewerId: string,
  limit: number,
): Promise<UserSearchResultDTO[]> {
  const prefix = escapeLike(q) + "%"
  const rows = await sql<
    { id: string; handle: string; display_name: string; avatar_url: string | null }[]
  >`
    SELECT u.id, u.handle, u.display_name, u.avatar_url
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.handle IS NOT NULL
      AND u.allow_direct_messages = true
      AND u.id <> ${viewerId}
      -- handle is CITEXT; cast to text so the per-keystroke @handle prefix search can use the
      -- gin_trgm_ops expression index users_handle_trgm on (handle::text) (0014_search_trgm.sql). ILIKE
      -- is case-insensitive on text, so casting does not change which rows match.
      AND (u.handle::text) ILIKE ${prefix} ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1 FROM user_blocks b
        WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
           OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
      )
    ORDER BY u.handle ASC
    LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatar: avatarGradient(r.id),
    ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
  }))
}

/**
 * Parse a `${display_name}|${id}` keyset cursor. display_name may itself contain `|`, but a UUID cannot,
 * so the id is the substring after the LAST `|` and the name is everything before it. Returns null when
 * absent/malformed (no `|`, or an empty id).
 */
function parseNameCursor(cursor: string | null): { name: string; id: string } | null {
  if (cursor === null) return null
  const idx = cursor.lastIndexOf("|")
  if (idx < 0) return null
  const name = cursor.slice(0, idx)
  const id = cursor.slice(idx + 1)
  // The id is cast `${cursor.id}::uuid` downstream; a non-UUID would raise a Postgres 22P02 -> 500. Treat
  // a malformed cursor as "from the start" (null) instead.
  if (!CURSOR_UUID_RE.test(id)) return null
  return { name, id }
}

/** Canonical UUID shape, validated before a cursor id reaches a `::uuid` cast. */
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
