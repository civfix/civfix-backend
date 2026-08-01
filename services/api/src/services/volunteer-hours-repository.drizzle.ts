import { avatarGradient } from "@civfix/shared"
import type { LeaderboardEntryDTO, MyVolunteerHoursDTO, VolunteerHoursSource } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import { encodeTimeCursor, pageWith } from "../db/cursor-helpers.js"
import { blockedPairExpr, hiddenIdentity } from "./hidden-identity.js"
import { EVENT_HOURS_MEMBER_CAP, ITEMISED_SOURCES } from "./volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  LogEventHoursArgs,
  LogEventHoursResult,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

/**
 * `pageWith`'s encoder must return a cursor STRING or null; the leaderboard pages by offset, so this is
 * the "there is another page" marker its boolean has-more collapses into. Never leaves this module.
 */
const MORE_PAGES = "more"

/** The shape every ledger read below selects, so the row -> view mapping has ONE implementation. */
interface LedgerRow {
  id: string
  source: VolunteerHoursSource
  hours: number
  created_at: Date
  scheduled_at: Date | null
  cleanup_id: string | null
  cleanup_title: string | null
  reference_code: string | null
  report_id: string | null
  jurisdiction_geoid: string | null
  jurisdiction_name: string | null
  creditor_id: string | null
  creditor_name: string | null
  creditor_handle: string | null
  creditor_verified: boolean | null
}

function toEntryView(r: LedgerRow): VolunteerHoursEntryView {
  return {
    id: r.id,
    source: r.source,
    hours: r.hours,
    createdAt: r.created_at,
    // `occurredAt` is when the SERVICE happened, which for an event is the day it was scheduled, not the
    // day a host got round to logging it. Report/manual credits have no such date, so they fall back.
    occurredAt: r.scheduled_at ?? r.created_at,
    cleanupId: r.cleanup_id,
    cleanupTitle: r.cleanup_title,
    cleanupReferenceCode: r.reference_code,
    reportId: r.report_id,
    jurisdictionGeoid: r.jurisdiction_geoid,
    jurisdictionName: r.jurisdiction_name,
    creditedBy:
      r.creditor_id !== null
        ? {
            id: r.creditor_id,
            name: r.creditor_name ?? "",
            handle: r.creditor_handle,
            verified: r.creditor_verified ?? false,
          }
        : null,
  }
}

export function makeDrizzleVolunteerHoursRepository(sql: Sql): VolunteerHoursRepository {
  return {
    // There is NO awardReportHours. See the VolunteerHoursRepository interface: `logEventHours` below is
    // the only writer of `volunteer_hours` / `user_jurisdiction_hours` in the whole service, which is what
    // makes 0065's rollup RECOMPUTE safe (no value in the rollup can lack a backing ledger row).
    async logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
      if (args.entries.length === 0) return { credited: 0, changed: [] }
      // Parallel arrays for the set-based per-row upsert: unnest(uuid[], float8[]) pairs them up
      // positionally, so each attendee gets THEIR OWN hours (WS5 per-attendee shape).
      const userIds = args.entries.map((e) => e.userId)
      const hoursByRow = args.entries.map((e) => e.hours)
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('volunteer_event:' || ${args.cleanupId}))`

        // M21 (history): the upsert below overwrites `hours` in place and overwrites
        // `logged_by_user_id` with it, so before this there was NO record that a value had ever been
        // different — a host could inflate a credit and later restore it invisibly, against a number
        // that feeds the PUBLIC jurisdiction leaderboard. Snapshot the pre-image INSIDE the
        // advisory-locked transaction (so it is exactly what the upsert is about to replace) and append
        // an immutable journal row per credited attendee. NULL previous_hours = no prior credit, which
        // is deliberately distinct from a stored 0.
        //
        // This runs BEFORE the upsert and in the SAME transaction: an audit row written afterwards
        // could be lost to a crash while the mutation committed, which is the one ordering that must
        // never happen for a journal.
        //
        // B33b: the same statement is ALSO the pre-image source for the hours_logged bell. It already
        // computes exactly "what this attendee had before, and what they have now" under the advisory
        // lock, so RETURNING it costs nothing and there is no second read that could disagree with the
        // journal. The service rings only where previous_hours IS NULL (a new credit) or new > previous.
        const audit = await tx<
          { user_id: string; previous_hours: number | null; new_hours: number }[]
        >`
          INSERT INTO volunteer_hours_audit
            (cleanup_id, user_id, actor_user_id, previous_hours, new_hours)
          SELECT
            ${args.cleanupId}, t.u, ${args.actorId}, prev.hours, t.h
          FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
          LEFT JOIN volunteer_hours prev
            ON prev.cleanup_id = ${args.cleanupId}
           AND prev.source = 'event'
           AND prev.user_id = t.u
          RETURNING
            user_id,
            previous_hours::float8 AS previous_hours,
            new_hours::float8 AS new_hours
        `
        const changed = audit.map((r) => ({
          userId: r.user_id,
          hours: r.new_hours,
          previousHours: r.previous_hours,
        }))

        // The event has NO jurisdiction (a host moved it outside all coverage, or it never had one). The
        // ledger row is still written/updated, with jurisdiction_geoid NULL — and any PRIOR credit that
        // was booked into a real jurisdiction must be REVERSED out of that rollup, exactly as the
        // non-null branch below reverses a move from one geoid to another. Without the reversal the old
        // jurisdiction's PUBLIC leaderboard keeps hours for an event that no longer takes place in it,
        // with no ledger row backing them and no way to ever settle up (this branch is the only writer
        // that can leave the rollup without a matching volunteer_hours row).
        // volunteer-hours-repository.memory.ts:53-55 is the in-memory twin of this reversal.
        if (args.geoid === null) {
          const upserted = await tx<{ user_id: string }[]>`
            WITH prev AS (
              SELECT user_id, hours AS old_hours, jurisdiction_geoid AS old_geoid
              FROM volunteer_hours
              WHERE cleanup_id = ${args.cleanupId}
                AND source = 'event'
                AND user_id = ANY(${userIds}::uuid[])
            ),
            upsert AS (
              INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
              SELECT t.u, t.h, 'event', ${args.cleanupId}, NULL, ${args.actorId}
              FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
              ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
              DO UPDATE SET
                hours = EXCLUDED.hours,
                jurisdiction_geoid = EXCLUDED.jurisdiction_geoid,
                logged_by_user_id = EXCLUDED.logged_by_user_id
              RETURNING user_id
            ),
            reversal AS (
              INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
              SELECT p.user_id, p.old_geoid, -p.old_hours
              FROM upsert up
              JOIN prev p ON p.user_id = up.user_id
              WHERE p.old_geoid IS NOT NULL
              ON CONFLICT (user_id, jurisdiction_geoid)
              DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
              RETURNING user_id
            )
            SELECT user_id FROM upsert
          `
          // `reversal` is a data-modifying CTE: Postgres runs it to completion whether or not the main
          // query reads it, so the count below stays "attendees credited" (one row per input attendee).
          return { credited: upserted.length, changed }
        }
        // Same delta-based rollup maintenance as before, now per row: each attendee's rollup moves by
        // (their new hours - their previous event credit), so a re-log overwrites without double-count.
        //
        // The delta is booked PER GEOID, not against the current one blindly. An event's
        // jurisdiction_geoid changes when a host edits its location (cleanup-service re-resolves it), and
        // the previous credit is then sitting in the OLD jurisdiction's rollup: applying (new - old) to
        // the NEW geoid would under-credit there and leave the stale hours behind in the old one, drifting
        // BOTH public leaderboards. So the current geoid gets the full amount whenever the prior credit
        // lived elsewhere, and the old geoid gets that prior credit reversed out.
        const upserted = await tx<{ user_id: string }[]>`
          WITH prev AS (
            SELECT user_id, hours AS old_hours, jurisdiction_geoid AS old_geoid
            FROM volunteer_hours
            WHERE cleanup_id = ${args.cleanupId}
              AND source = 'event'
              AND user_id = ANY(${userIds}::uuid[])
          ),
          upsert AS (
            INSERT INTO volunteer_hours (user_id, hours, source, cleanup_id, jurisdiction_geoid, logged_by_user_id)
            SELECT t.u, t.h, 'event', ${args.cleanupId}, ${args.geoid}, ${args.actorId}
            FROM unnest(${userIds}::uuid[], ${hoursByRow}::float8[]) AS t(u, h)
            ON CONFLICT (cleanup_id, user_id) WHERE source = 'event'
            DO UPDATE SET
              hours = EXCLUDED.hours,
              jurisdiction_geoid = EXCLUDED.jurisdiction_geoid,
              logged_by_user_id = EXCLUDED.logged_by_user_id
            RETURNING user_id, hours
          ),
          deltas AS (
            SELECT
              up.user_id,
              ${args.geoid}::text AS geoid,
              up.hours - COALESCE(
                CASE WHEN p.old_geoid = ${args.geoid} THEN p.old_hours END, 0
              ) AS delta
            FROM upsert up
            LEFT JOIN prev p ON p.user_id = up.user_id
            UNION ALL
            -- The event moved jurisdictions since this attendee was last credited: take the stale hours
            -- back out of the jurisdiction it no longer belongs to. Disjoint from the branch above (that
            -- one is always the CURRENT geoid), so no (user, geoid) pair is inserted twice.
            SELECT p.user_id, p.old_geoid, -p.old_hours
            FROM upsert up
            JOIN prev p ON p.user_id = up.user_id
            WHERE p.old_geoid IS NOT NULL AND p.old_geoid <> ${args.geoid}
          )
          INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
          SELECT d.user_id, d.geoid, d.delta FROM deltas d
          ON CONFLICT (user_id, jurisdiction_geoid)
          DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
          RETURNING user_id
        `
        // Rows credited, NOT rows written: the reversal branch can emit a second row for the same
        // attendee, and the caller's `credited` count is per attendee.
        return { credited: new Set(upserted.map((r) => r.user_id)).size, changed }
      })
    },

    async totalsFor(userId: string): Promise<MyVolunteerHoursDTO> {
      const rows = await sql<{ geoid: string; name: string | null; hours: number }[]>`
        SELECT
          ujh.jurisdiction_geoid AS geoid,
          j.name AS name,
          ujh.total_hours::float8 AS hours
        FROM user_jurisdiction_hours ujh
        JOIN jurisdictions j ON j.geoid = ujh.jurisdiction_geoid
        WHERE ujh.user_id = ${userId} AND ujh.total_hours > 0
        ORDER BY ujh.total_hours DESC, ujh.jurisdiction_geoid
      `
      const byJurisdiction = rows.map((r) => ({ geoid: r.geoid, name: r.name, hours: r.hours }))
      const totalHours = byJurisdiction.reduce((sum, r) => sum + r.hours, 0)
      return { totalHours, byJurisdiction }
    },

    async totalHoursFor(userId: string): Promise<number> {
      const rows = await sql<{ total: number }[]>`
        SELECT COALESCE(SUM(total_hours), 0)::float8 AS total
        FROM user_jurisdiction_hours
        WHERE user_id = ${userId} AND total_hours > 0
      `
      return rows[0]?.total ?? 0
    },

    /**
     * B49 / C18 — the privacy filter is `AND u.show_volunteer_hours IS NOT FALSE`, in the main query AND
     * in both supplementary queries below. It is deliberately NOT `AND u.show_volunteer_hours`: the
     * column is a nullable tri-state and every account that exists today holds NULL, so a bare truth test
     * is three-valued and would return the empty set — an empty leaderboard on deploy day, everywhere.
     *
     * `withExtras` gates the two supplementary queries. The Discovery preview reads `limit: 3` and
     * renders neither a viewer rank nor a participant count, so making it pay for them would triple the
     * cost of the hottest anonymous read this feature adds.
     */
    async leaderboard(
      geoid: string,
      limit: number,
      offset: number,
      viewerId: string | null,
      withExtras: boolean,
    ): Promise<LeaderboardPage> {
      const jurRows = await sql<{ name: string }[]>`
        SELECT name FROM jurisdictions WHERE geoid = ${geoid} LIMIT 1
      `
      const jurisdictionName = jurRows[0]?.name ?? null

      const blockedPair = blockedPairExpr(sql, viewerId, sql`ujh.user_id`)

      const rows = await sql<
        {
          user_id: string
          name: string
          handle: string | null
          avatar_url: string | null
          verified: boolean
          hours: number
          blocked_pair: boolean
        }[]
      >`
        SELECT
          ujh.user_id,
          u.display_name AS name,
          u.handle,
          u.avatar_url,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = ujh.user_id AND uv.status = 'verified'
          ) AS verified,
          ${blockedPair} AS blocked_pair,
          ujh.total_hours::float8 AS hours
        FROM user_jurisdiction_hours ujh
        JOIN users u ON u.id = ujh.user_id
        WHERE ujh.jurisdiction_geoid = ${geoid}
          AND ujh.total_hours > 0
          AND u.deleted_at IS NULL
          AND u.show_volunteer_hours IS NOT FALSE
        ORDER BY ujh.total_hours DESC, ujh.user_id
        LIMIT ${limit + 1} OFFSET ${offset}
      `

      // DB B48 — the viewer's own standing, even when they are past the fetched page. Only for a signed-in
      // viewer, and only when the caller wants it. A viewer with show_volunteer_hours = false is not on
      // the board at all, so `me` is empty and both fields come back null.
      let viewerRank: number | null = null
      let viewerHours: number | null = null
      if (withExtras && viewerId !== null) {
        const meRows = await sql<{ hours: number | null; rank: number | null }[]>`
          WITH me AS (
            SELECT ujh.total_hours
            FROM user_jurisdiction_hours ujh
            JOIN users u ON u.id = ujh.user_id
            WHERE ujh.user_id = ${viewerId}
              AND ujh.jurisdiction_geoid = ${geoid}
              AND ujh.total_hours > 0
              AND u.deleted_at IS NULL
              AND u.show_volunteer_hours IS NOT FALSE
          )
          SELECT
            (SELECT total_hours::float8 FROM me) AS hours,
            CASE WHEN EXISTS (SELECT 1 FROM me) THEN (
              SELECT count(*)::int + 1
              FROM user_jurisdiction_hours o
              JOIN users ou ON ou.id = o.user_id
              WHERE o.jurisdiction_geoid = ${geoid}
                AND o.total_hours > (SELECT total_hours FROM me)
                AND o.total_hours > 0
                AND ou.deleted_at IS NULL
                AND ou.show_volunteer_hours IS NOT FALSE
            ) END AS rank
        `
        viewerHours = meRows[0]?.hours ?? null
        viewerRank = meRows[0]?.rank ?? null
      }

      // Only on the FIRST page: a deep page must not pay for a count, and the number exists so a thin or
      // empty board reads as "be the first" rather than broken.
      let participantCount: number | null = null
      if (withExtras && offset === 0) {
        const countRows = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM user_jurisdiction_hours ujh
          JOIN users u ON u.id = ujh.user_id
          WHERE ujh.jurisdiction_geoid = ${geoid}
            AND ujh.total_hours > 0
            AND u.deleted_at IS NULL
            AND u.show_volunteer_hours IS NOT FALSE
        `
        participantCount = countRows[0]?.count ?? 0
      }

      // OFFSET paging, not a keyset: the contract carries `nextOffset` because a leaderboard row's
      // sort key (total_hours) moves under the reader. So only the has-more SPLIT is shared with the
      // keyset repos — `pageWith` drops the probe row and the encoder just marks "another page exists";
      // the offset arithmetic stays here. A `null` marker on a limit-0 page (unreachable: clampLimit
      // floors the limit at 1) correctly ends the page instead of advertising the same offset forever.
      const { items: page, nextCursor: more } = pageWith(rows, limit, () => MORE_PAGES)
      const entries: LeaderboardEntryDTO[] = page.map((r, i) => {
        const rankAndHours = { rank: offset + i + 1, userId: r.user_id, hours: r.hours }
        if (r.blocked_pair) {
          const hidden = hiddenIdentity(r.user_id)
          return { ...rankAndHours, name: hidden.name, avatar: hidden.avatar, verified: false }
        }
        return {
          ...rankAndHours,
          name: r.name,
          ...(r.handle !== null ? { handle: r.handle } : {}),
          avatar: avatarGradient(r.user_id),
          ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
          verified: r.verified,
        }
      })

      return {
        jurisdictionName,
        entries,
        nextOffset: more === null ? null : offset + limit,
        participantCount,
        viewerRank,
        viewerHours,
      }
    },

    /**
     * B30a — the itemised ledger, newest-first on the house keyset `(created_at DESC, id DESC)`, backed
     * by 0062's `volunteer_hours (user_id, created_at DESC, id DESC)` index so the row-value comparison
     * needs no sort. A malformed cursor arrives here as `null` from `parseTimeCursor` and degrades to
     * "from the start" rather than raising a 22P02 on the `::uuid` cast.
     *
     * `voided_at IS NULL` is filtered from day one (B30b): nothing writes that column yet, so the
     * predicate is a no-op today and a future void/revoke path needs no read change and no backfill.
     */
    async listEntries(
      args: ListEntriesArgs,
    ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }> {
      const sources = args.sources ?? ITEMISED_SOURCES
      // House idiom (post-/report-/notification-repository): the keyset predicate is a CONDITIONAL
      // fragment rather than a `$1 IS NULL OR …`, so page 1 plans without a dead comparison.
      const keyset =
        args.cursor !== null
          ? sql`AND (vh.created_at, vh.id) < (${args.cursor.at}, ${args.cursor.id}::uuid)`
          : sql``
      const rows = await sql<LedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          c.scheduled_at,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.report_id,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = lb.id AND uv.status = 'verified'
          ) AS creditor_verified
        FROM volunteer_hours vh
        LEFT JOIN cleanups c      ON c.id = vh.cleanup_id
        LEFT JOIN jurisdictions j ON j.geoid = vh.jurisdiction_geoid
        LEFT JOIN users lb        ON lb.id = vh.logged_by_user_id
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source = ANY(${sources as string[]}::text[])
          ${keyset}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${args.limit + 1}
      `
      const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
        encodeTimeCursor({ at: last.created_at, id: last.id }),
      )
      return { items: items.map(toEntryView), nextCursor }
    },

    /**
     * C10 — what has already been logged for one event. `viewerId === null` is the acting-host read (no
     * per-user filter); a non-null id restricts `entries` to that one attendee. `anyLogged` is computed
     * from the SAME index either way, so the attendee branch can tell "the host has not logged yet" from
     * "the host logged and did not credit me" without seeing anybody else's row.
     *
     * Deliberately NOT joined to `cleanup_members`: an attendee removed after being credited still holds
     * their credit, and dropping their row here would make the host's summary silently under-count. The
     * membership gate lives in the service (`CleanupHoursLookup.roleOf`), where it decides SCOPE.
     */
    async listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger> {
      const mine = viewerId !== null ? sql`AND vh.user_id = ${viewerId}::uuid` : sql``
      const rows = await sql<{ user_id: string; hours: number; created_at: Date }[]>`
        SELECT vh.user_id, vh.hours::float8 AS hours, vh.created_at
        FROM volunteer_hours vh
        WHERE vh.cleanup_id = ${cleanupId}
          AND vh.source = 'event'
          AND vh.voided_at IS NULL
          ${mine}
        ORDER BY vh.created_at DESC, vh.id DESC
        LIMIT ${EVENT_HOURS_MEMBER_CAP}
      `
      const entries = rows.map((r) => ({
        userId: r.user_id,
        hours: r.hours,
        loggedAt: r.created_at,
      }))
      // The unfiltered read already answers "has anything been logged", so the probe runs ONLY on the
      // filtered (attendee) path — where an empty `entries` is exactly the ambiguous case it resolves.
      if (viewerId === null) return { entries, anyLogged: entries.length > 0 }
      const probe = await sql<{ any_logged: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM volunteer_hours
          WHERE cleanup_id = ${cleanupId} AND source = 'event' AND voided_at IS NULL
        ) AS any_logged
      `
      return { entries, anyLogged: probe[0]?.any_logged ?? false }
    },

    /**
     * C18's two predicates, from ONE row read. `aggregate` is `IS NOT FALSE` (NULL — every account that
     * exists today — stays visible, byte-identical to the `volunteerHours` scalar their profile already
     * publishes); `items` is `IS TRUE` (the per-event list with dates and crediting hosts is new
     * disclosure and needs an explicit opt-in). A missing row (or a tombstoned account) is hidden on both.
     */
    async hoursVisibilityFor(userId: string): Promise<HoursVisibility> {
      const rows = await sql<{ aggregate: boolean; items: boolean }[]>`
        SELECT
          (show_volunteer_hours IS NOT FALSE) AS aggregate,
          (show_volunteer_hours IS TRUE) AS items
        FROM users
        WHERE id = ${userId} AND deleted_at IS NULL
        LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return { aggregate: false, items: false }
      return { aggregate: row.aggregate, items: row.items }
    },

    /**
     * The certificate transcript read (WP21). Same ledger, same `voided_at IS NULL` filter, but ordered
     * ASCENDING (a printed transcript reads oldest-first) and bounded by `limit`. `entryCount` is the
     * FULL matching count even when `items` was truncated, so the document can say so honestly, while
     * `totalHours` sums only the returned rows — B40b: a printed total that does not equal the sum of the
     * printed lines is a self-contradicting document.
     *
     * `vh.source <> 'report'` is on BOTH queries and is the highest-value predicate in this file: it is
     * what keeps a report filing off a signed, publicly verifiable PDF handed to a school, an employer or
     * a court. 0065 voided every historical report row, so this is belt AND braces — a certificate is
     * frozen at issue time and CANNOT be corrected afterwards (0064's banner), so the read that feeds it
     * must not depend on a data migration having run.
     */
    async entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage> {
      const geoidFilter =
        args.geoid !== null ? sql`AND vh.jurisdiction_geoid = ${args.geoid}` : sql``
      const fromFilter = args.from !== null ? sql`AND vh.created_at >= ${args.from}` : sql``
      const toFilter = args.to !== null ? sql`AND vh.created_at <= ${args.to}` : sql``
      const rows = await sql<LedgerRow[]>`
        SELECT
          vh.id,
          vh.source,
          vh.hours::float8 AS hours,
          vh.created_at,
          c.scheduled_at,
          vh.cleanup_id,
          c.title AS cleanup_title,
          c.reference_code,
          vh.report_id,
          vh.jurisdiction_geoid,
          j.name AS jurisdiction_name,
          lb.id AS creditor_id,
          lb.display_name AS creditor_name,
          lb.handle AS creditor_handle,
          EXISTS (
            SELECT 1 FROM user_verification uv
            WHERE uv.user_id = lb.id AND uv.status = 'verified'
          ) AS creditor_verified
        FROM volunteer_hours vh
        LEFT JOIN cleanups c      ON c.id = vh.cleanup_id
        LEFT JOIN jurisdictions j ON j.geoid = vh.jurisdiction_geoid
        LEFT JOIN users lb        ON lb.id = vh.logged_by_user_id
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source <> 'report'
          ${geoidFilter}
          ${fromFilter}
          ${toFilter}
        ORDER BY vh.created_at ASC, vh.id ASC
        LIMIT ${args.limit}
      `
      const countRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM volunteer_hours vh
        WHERE vh.user_id = ${args.userId}
          AND vh.voided_at IS NULL
          AND vh.source <> 'report'
          ${geoidFilter}
          ${fromFilter}
          ${toFilter}
      `
      const items = rows.map(toEntryView)
      return {
        items,
        totalHours: Math.round(items.reduce((sum, r) => sum + r.hours, 0) * 100) / 100,
        entryCount: countRows[0]?.count ?? items.length,
      }
    },
  }
}
