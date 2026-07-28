
import type { Sql } from "../db/client.js"
import type {
  PersonView,
  ProfileStats,
  SocialRepository,
} from "./social-service.js"
import type { CleanupRecord, CleanupPersonView } from "./cleanup-service.js"
import type { CleanupStatus, CleanupType, EventKind, SocialLinks } from "@civfix/shared"
import { encodeNameCursor, pageWith, parseNameCursor } from "../db/cursor-helpers.js"
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

/** "In the viewer's area" radius for follow suggestions (~25 km). */
const SUGGEST_NEARBY_METERS = 25_000

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
  /**
   * P6 hours privacy (0061). REQUIRED on this row shape, not optional like `social_links`: PersonView
   * carries the tri-state and every projection below selects `u.show_volunteer_hours`, so a new
   * projection that forgets it is a compile error rather than a silently `undefined` privacy flag.
   */
  show_volunteer_hours: boolean | null
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
    showVolunteerHours: r.show_volunteer_hours,
  }
}

function pagePeople(
  rows: PersonRowSelectWithFollow[],
  limit: number,
): { items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null } {
  // The people surfaces key on (display_name, id), so the cursor is the NAME cursor parseNameCursor reads.
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
  // L13: the follower/following connection pages were the ONE people-listing surface with no block
  // filter — suggestFollows, people search, the home/replies/saves feeds and every DM surface all carry
  // this exact NOT EXISTS. Blocks in this product are a mutual-invisibility control, not a messaging-only
  // one (the block hides the pair from each other's *content* everywhere else), so a blocked account
  // surfacing in a public roster the viewer can page through is a real leak of the control. Symmetric
  // (either direction blocks) to match every other call site. Anonymous viewers have no block
  // relationships at all, so the clause is simply omitted rather than joined against a null id.
  const blockFilter =
    viewerId !== null
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
          WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
        )`
      : sql``

  // M-follow-counts: the counts are the denormalized users.follower_count / users.following_count
  // (0059_users_follow_counters.sql), so the roster no longer re-walks each listed person's edge list.
  // NOTE the counts include that person's edges to/from SOFT-DELETED users while this roster does not
  // list them (`u.deleted_at IS NULL` below) — the pre-existing asymmetry of the aggregates, documented
  // in the migration. The page is still cut FIRST and only the (limit + 1) survivors pay for the
  // verified probe / avatar join: expressions in an outer target list are never pushed below a LIMIT.
  const rows = await sql<PersonRowSelectWithFollow[]>`
    SELECT
      u.id,
      u.display_name,
      u.handle,
      u.bio,
      u.follower_count AS followers,
      u.following_count AS following,
      EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
      am.r2_key AS avatar_r2_key,
      u.avatar_url,
      u.show_volunteer_hours,
      ${followingExpr} AS is_following
    FROM (
      SELECT
        u.id, u.display_name, u.handle, u.bio, u.avatar_media_id, u.avatar_url,
        u.show_volunteer_hours,
        u.follower_count, u.following_count
      FROM users u
      JOIN follows_people f ON ${joinPredicate}
      WHERE u.deleted_at IS NULL
        ${blockFilter}
        ${cursorFilter}
      ORDER BY u.display_name ASC, u.id ASC
      LIMIT ${args.limit + 1}
    ) u
    LEFT JOIN media_assets am ON am.id = u.avatar_media_id
    ORDER BY u.display_name ASC, u.id ASC
  `
  return pagePeople(rows, args.limit)
}

export function makeDrizzleSocialRepository(sql: Sql): SocialRepository {
  // The single-person projection (findPersonById / findPersonByHandle differ ONLY in the lookup key, and
  // are the two reads that carry social_links). One body so a field addition cannot land in just one.
  async function findPerson(keyFilter: ReturnType<Sql>): Promise<PersonView | null> {
    const rows = await sql<PersonRowSelect[]>`
      SELECT
        u.id,
        u.display_name,
        u.handle,
        u.bio,
        u.follower_count AS followers,
        u.following_count AS following,
        EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
        am.r2_key AS avatar_r2_key,
        u.avatar_url,
        u.social_links,
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
      // M-people-blocks: people SEARCH was the last people surface with no block filter — connections,
      // suggestions, DM/mention search and every feed carry this exact symmetric NOT EXISTS. A block is a
      // mutual-invisibility control here, so a blocked (or blocking) account must not surface in the search
      // list with live follower counts. Anonymous viewers have no block rows, so the clause is omitted.
      const blockFilter =
        viewerId !== null
          ? sql`AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
            )`
          : sql``

      // Page first, then hydrate the verified probe / avatar join — see connectionsPage for why the
      // projection sits outside the LIMIT. The two totals are plain denormalized columns (0059).
      const rows = await sql<PersonRowSelectWithFollow[]>`
        SELECT
          u.id,
          u.display_name,
          u.handle,
          u.bio,
          u.follower_count AS followers,
          u.following_count AS following,
          EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = u.id AND v.status = 'verified') AS verified,
          am.r2_key AS avatar_r2_key,
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

    async suggestFollows(args): Promise<Array<PersonView & { isFollowing: boolean }>> {
      const viewerId = args.viewerId
      // "The viewer's area" = the point of their most recent activity (a report they filed, or a
      // cleanup they organized/joined). Each CANDIDATE's area = their most recent report or hosted
      // cleanup. `is_near` = both points exist and are within SUGGEST_NEARBY_METERS of each other;
      // `is_organizer` = the candidate hosts at least one cleanup/event. Ranking tiers:
      //   1. nearby organizers  2. nearby people  3. organizers elsewhere  4. everyone else
      // within a tier: closer first (NULL distances last), then higher follower count, then newest.
      // Exclusions: self, soft-deleted, handle-less, already-followed, blocked either way.
      //
      // M-suggest-cost: the tier expressions are computed ONCE per candidate in `candidates` and only
      // referenced by name in the ORDER BY — the flat version re-ran the organizer EXISTS twice and the
      // follower count a second time inside the sort key, for every user in the table. Everything the
      // ranking does NOT need (the verified probe, the avatar join) is deferred to `ranked`, i.e. to the
      // `limit` rows actually returned. `followers` is a ranking key and is now the denormalized
      // users.follower_count (0059_users_follow_counters.sql), so the sort no longer costs a count(*)
      // scan per candidate; `following` rides along from the same row for free. The candidate set is
      // still the whole users table; narrowing it (activity window / bounded pool) would change WHICH
      // people are suggested, so it stays a product decision rather than a refactor.
      const rows = await sql<
        Array<PersonRowSelect & { is_organizer: boolean }>
      >`
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
            EXISTS (SELECT 1 FROM cleanups oc WHERE oc.organizer_user_id = u.id) AS is_organizer,
            dist.meters AS dist_meters,
            (dist.meters IS NOT NULL AND dist.meters <= ${SUGGEST_NEARBY_METERS}) AS is_near
          FROM users u
          LEFT JOIN LATERAL (
            SELECT p.geom FROM (
              SELECT r.geom, r.created_at FROM reports r
                WHERE r.reporter_user_id = u.id AND r.deleted_at IS NULL
              UNION ALL
              SELECT c.geom, c.created_at FROM cleanups c
                WHERE c.organizer_user_id = u.id
            ) p
            ORDER BY p.created_at DESC NULLS LAST
            LIMIT 1
          ) cand ON TRUE
          LEFT JOIN LATERAL (
            SELECT ST_Distance(vp.geom::geography, cand.geom::geography) AS meters
            FROM viewer_point vp
            WHERE cand.geom IS NOT NULL
          ) dist ON TRUE
          WHERE u.deleted_at IS NULL
            AND u.handle IS NOT NULL
            AND u.id <> ${viewerId}
            AND NOT EXISTS (
              SELECT 1 FROM follows_people f
              WHERE f.follower_id = ${viewerId} AND f.followee_id = u.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
              WHERE (b.blocker_id = ${viewerId} AND b.blocked_id = u.id)
                 OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId})
            )
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
          EXISTS (SELECT 1 FROM user_verification v WHERE v.user_id = c.id AND v.status = 'verified') AS verified,
          am.r2_key AS avatar_r2_key,
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
      return rows.map((r) => ({ ...toPersonView(r), isFollowing: false }))
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

    // M-follow-counts write side (0059_users_follow_counters.sql): the edge write and the two counter
    // bumps are ONE transaction, and the bump is gated on the INSERT/DELETE having actually changed a
    // row — an idempotent re-follow (ON CONFLICT DO NOTHING → zero rows) or a re-unfollow must not move
    // anything. Same shape as the post counters (post-repository.drizzle.ts like/unlike).
    //
    // Both users move in a SINGLE UPDATE on purpose. Two statements ("bump the followee, then the
    // follower") take the two row locks in OPPOSITE orders for a mutual follow-back and can deadlock;
    // one statement's lock order is a property of its plan, so it is the same for both directions. The
    // UPDATE touches no key column, so it takes only a NO KEY UPDATE row lock, which does not conflict
    // with the FOR KEY SHARE that every FK-referencing insert takes on the same users row (the reason
    // removeMember uses FOR NO KEY UPDATE in cleanup-repository).
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
        // The DELETE is idempotent by contract (the route reports "not following" as success), so a
        // zero-row delete leaves the counters alone. GREATEST clamps at 0 so drift can never present a
        // negative follower count to a client.
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

    // Reads the denormalized counter, so the follow/unfollow response no longer walks the target's whole
    // follower list. No deleted_at filter: the aggregate this replaced had none either, and the counter
    // is only ever read for a user the caller just resolved. A user id with no row reads 0, as before.
    async followerCount(userId: string): Promise<number> {
      const rows = await sql<{ count: number }[]>`
        SELECT follower_count AS count FROM users WHERE id = ${userId}
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
        -- L-past-events: the profile strip is PAST events (UserProfileDTO.pastEvents). Without these two
        -- terms it was "the 20 most recent by scheduled_at", so an upcoming event the user had merely RSVP'd
        -- to — and a cancelled one they never attended — rendered as civic history. status is NOT NULL, so
        -- the <> is safe.
        WHERE c.scheduled_at < now()
          AND c.status <> 'cancelled'
        ORDER BY c.scheduled_at DESC, c.id DESC
        LIMIT ${limit}
      `
      return rows.map(toCleanupRecord)
    },

    async statsFor(userId: string): Promise<ProfileStats> {
      const rows = await sql<{ reports: number; fixed: number; cleanups: number }[]>`
        SELECT
          (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = ${userId} AND r.deleted_at IS NULL) AS reports,
          (SELECT count(*)::int FROM reports r WHERE r.reporter_user_id = ${userId} AND r.deleted_at IS NULL AND r.status = 'resolved') AS fixed,
          (SELECT count(*)::int FROM cleanups c WHERE c.organizer_user_id = ${userId}) AS cleanups
      `
      return {
        reports: rows[0]?.reports ?? 0,
        fixed: rows[0]?.fixed ?? 0,
        cleanups: rows[0]?.cleanups ?? 0,
      }
    },
  }
}
