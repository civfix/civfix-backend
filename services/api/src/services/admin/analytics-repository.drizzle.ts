
import type { Sql } from "../../db/client.js"
import type {
  AnalyticsRepository,
  CategoryCount,
  CategoryMedian,
  CoverageCounts,
  EventAggregates,
  FunnelCounts,
  HeatmapCellRow,
  KpiAggregates,
  MonthBucket,
  RetentionRow,
  TopContributorRow,
  TopJurisdictionRow,
  WeekBucket,
} from "./analytics-types.js"
import type { ReportCategory } from "@civfix/shared"

function num(value: string | null | undefined): number {
  if (value == null) return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function makeDrizzleAnalyticsRepository(sql: Sql): AnalyticsRepository {
  return {
    async kpis(): Promise<KpiAggregates> {
      const [reportRows, cleanupRows, newUserRows] = await Promise.all([
        sql<
          {
            cur_total: string
            cur_resolved: string
            prev_total: string
            prev_resolved: string
          }[]
        >`
          SELECT
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now())
            )::text AS cur_total,
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now()) AND status = 'resolved'
            )::text AS cur_resolved,
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now()) - interval '1 month'
                AND created_at < date_trunc('month', now())
            )::text AS prev_total,
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now()) - interval '1 month'
                AND created_at < date_trunc('month', now()) AND status = 'resolved'
            )::text AS prev_resolved
          FROM reports
          WHERE deleted_at IS NULL AND visibility = 'public'
        `,
        sql<
          {
            cur_planned: string
            prev_planned: string
            cur_events: string
            prev_events: string
          }[]
        >`
          SELECT
            COUNT(*) FILTER (
              WHERE status = 'upcoming' AND created_at >= date_trunc('month', now())
            )::text AS cur_planned,
            COUNT(*) FILTER (
              WHERE status = 'upcoming'
                AND created_at >= date_trunc('month', now()) - interval '1 month'
                AND created_at < date_trunc('month', now())
            )::text AS prev_planned,
            COUNT(*) FILTER (
              WHERE scheduled_at >= date_trunc('month', now())
            )::text AS cur_events,
            COUNT(*) FILTER (
              WHERE scheduled_at >= date_trunc('month', now()) - interval '1 month'
                AND scheduled_at < date_trunc('month', now())
            )::text AS prev_events
          FROM cleanups
        `,
        sql<{ cur_new: string; prev_new: string }[]>`
          SELECT
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now())
            )::text AS cur_new,
            COUNT(*) FILTER (
              WHERE created_at >= date_trunc('month', now()) - interval '1 month'
                AND created_at < date_trunc('month', now())
            )::text AS prev_new
          FROM users
          WHERE deleted_at IS NULL
        `,
      ])
      const r = reportRows[0]
      const curTotal = num(r?.cur_total)
      const prevTotal = num(r?.prev_total)
      const curResolved = num(r?.cur_resolved)
      const prevResolved = num(r?.prev_resolved)
      const c = cleanupRows[0]
      const u = newUserRows[0]

      return {
        pins: { current: curTotal, previous: prevTotal },
        resolvedRatio: {
          current: curTotal > 0 ? curResolved / curTotal : 0,
          previous: prevTotal > 0 ? prevResolved / prevTotal : 0,
        },
        cleanupsPlanned: { current: num(c?.cur_planned), previous: num(c?.prev_planned) },
        events: { current: num(c?.cur_events), previous: num(c?.prev_events) },
        newUsers: { current: num(u?.cur_new), previous: num(u?.prev_new) },
      }
    },

    async pinsByWeek(weeks: number): Promise<WeekBucket[]> {
      const rows = await sql<{ week_start: Date; n: string }[]>`
        SELECT date_trunc('week', created_at) AS week_start, COUNT(*)::text AS n
        FROM reports
        WHERE deleted_at IS NULL
          AND visibility = 'public'
          AND created_at >= date_trunc('week', now()) - make_interval(weeks => ${weeks - 1})
        GROUP BY 1
        ORDER BY 1
      `
      return rows.map((r) => ({ weekStart: r.week_start, count: num(r.n) }))
    },

    async byCategory(): Promise<CategoryCount[]> {
      const rows = await sql<{ category: ReportCategory; n: string }[]>`
        SELECT category, COUNT(*)::text AS n
        FROM reports
        WHERE deleted_at IS NULL AND visibility = 'public'
        GROUP BY category
      `
      return rows.map((r) => ({ category: r.category, count: num(r.n) }))
    },

    async funnel(): Promise<FunnelCounts> {
      const rows = await sql<
        { dropped: string; routed: string; acknowledged: string; resolved: string }[]
      >`
        SELECT
          COUNT(*)::text AS dropped,
          COUNT(*) FILTER (WHERE jurisdiction_geoid IS NOT NULL)::text AS routed,
          COUNT(*) FILTER (
            WHERE status IN ('acknowledged', 'in_progress', 'resolved')
          )::text AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'resolved')::text AS resolved
        FROM reports
        WHERE deleted_at IS NULL AND visibility = 'public'
      `
      const r = rows[0]
      return {
        dropped: num(r?.dropped),
        routed: num(r?.routed),
        acknowledged: num(r?.acknowledged),
        resolved: num(r?.resolved),
      }
    },

    async coverage(): Promise<CoverageCounts> {
      const rows = await sql<{ mapped: string; needs: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE has_contact)::text AS mapped,
          COUNT(*) FILTER (WHERE NOT has_contact)::text AS needs
        FROM (
          SELECT
            j.geoid,
            (
              (j.contact_emails IS NOT NULL AND array_length(j.contact_emails, 1) > 0)
              OR EXISTS (
                SELECT 1 FROM jurisdiction_contacts jc
                WHERE jc.geoid = j.geoid AND jc.email IS NOT NULL
              )
            ) AS has_contact
          FROM jurisdictions j
        ) s
      `
      const r = rows[0]
      return { mapped: num(r?.mapped), needsMapping: num(r?.needs) }
    },

    async resolutionByCategory(): Promise<CategoryMedian[]> {
      // "Time to resolution" is measured from submission to the RESOLVED TRANSITION (the newest
      // report_timeline row at status='resolved'), falling back to published_at only for a resolved report
      // with no transition row (pre-timeline rows). Never now(): the previous COALESCE(published_at, now())
      // measured publish latency, and for a resolved-but-unpublished report it grew by a day every day, so
      // the dashboard number inflated on its own and no two page loads agreed.
      //
      // A resolved report with neither a transition row nor published_at contributes NOTHING (rather than a
      // wall-clock guess): percentile_cont ignores NULLs, so the median stays over rows we can actually time.
      const rows = await sql<{ category: ReportCategory; median_hours: string | null }[]>`
        SELECT
          r.category,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (COALESCE(t.resolved_at, r.published_at) - r.created_at)) / 3600.0
          )::text AS median_hours
        FROM reports r
        LEFT JOIN LATERAL (
          SELECT MAX(rt.created_at) AS resolved_at
          FROM report_timeline rt
          WHERE rt.report_id = r.id AND rt.status = 'resolved'
        ) t ON true
        WHERE r.deleted_at IS NULL AND r.status = 'resolved' AND r.visibility = 'public'
        GROUP BY r.category
      `
      return rows.map((r) => ({ category: r.category, medianHours: num(r.median_hours) }))
    },

    async events(months: number): Promise<EventAggregates> {
      const [headline, volunteers, byMonthRows] = await Promise.all([
        sql<{ this_month: string; bags: string }[]>`
          SELECT
            COUNT(*) FILTER (WHERE scheduled_at >= date_trunc('month', now()))::text AS this_month,
            COALESCE(SUM(bags) FILTER (WHERE scheduled_at >= date_trunc('month', now())), 0)::text AS bags
          FROM cleanups
        `,
        sql<{ vol: string }[]>`
          SELECT COUNT(DISTINCT m.user_id)::text AS vol
          FROM cleanup_members m
          JOIN cleanups cl ON cl.id = m.cleanup_id
          WHERE cl.scheduled_at >= date_trunc('month', now())
        `,
        sql<{ y: string; m: string; n: string }[]>`
          SELECT
            EXTRACT(YEAR FROM scheduled_at)::text AS y,
            EXTRACT(MONTH FROM scheduled_at)::text AS m,
            COUNT(*)::text AS n
          FROM cleanups
          WHERE scheduled_at >= date_trunc('month', now()) - make_interval(months => ${months - 1})
          GROUP BY 1, 2
          ORDER BY 1, 2
        `,
      ])
      const byMonth: MonthBucket[] = byMonthRows.map((r) => ({
        year: num(r.y),
        month: num(r.m),
        count: num(r.n),
      }))
      return {
        thisMonth: num(headline[0]?.this_month),
        volunteers: num(volunteers[0]?.vol),
        bags: num(headline[0]?.bags),
        byMonth,
      }
    },

    async topJurisdictions(limit: number): Promise<TopJurisdictionRow[]> {
      const rows = await sql<{ org: string; pins: string; resolved: string }[]>`
        SELECT
          COALESCE(j.name, r.jurisdiction_geoid) AS org,
          COUNT(*)::text AS pins,
          COUNT(*) FILTER (WHERE r.status = 'resolved')::text AS resolved
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.deleted_at IS NULL
          AND r.visibility = 'public'
          AND r.jurisdiction_geoid IS NOT NULL
        GROUP BY 1
        ORDER BY COUNT(*) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({ org: r.org, pins: num(r.pins), resolved: num(r.resolved) }))
    },

    async topContributors(limit: number): Promise<TopContributorRow[]> {
      const rows = await sql<
        { name: string; city: string | null; reports: string; cleanups: string }[]
      >`
        WITH report_counts AS (
          SELECT reporter_user_id AS user_id, COUNT(*)::int AS n
          FROM reports
          WHERE deleted_at IS NULL AND reporter_user_id IS NOT NULL
          GROUP BY reporter_user_id
        ),
        cleanup_counts AS (
          SELECT organizer_user_id AS user_id, COUNT(*)::int AS n
          FROM cleanups
          GROUP BY organizer_user_id
        ),
        user_city AS (
          SELECT DISTINCT ON (r.reporter_user_id)
            r.reporter_user_id AS user_id, j.name AS city
          FROM reports r
          JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          WHERE r.reporter_user_id IS NOT NULL
          ORDER BY r.reporter_user_id, r.created_at DESC
        )
        SELECT
          u.display_name AS name,
          uc.city AS city,
          COALESCE(rc.n, 0)::text AS reports,
          COALESCE(cc.n, 0)::text AS cleanups
        FROM users u
        LEFT JOIN report_counts rc ON rc.user_id = u.id
        LEFT JOIN cleanup_counts cc ON cc.user_id = u.id
        LEFT JOIN user_city uc ON uc.user_id = u.id
        WHERE COALESCE(rc.n, 0) + COALESCE(cc.n, 0) > 0
        ORDER BY COALESCE(rc.n, 0) + COALESCE(cc.n, 0) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        name: r.name,
        city: r.city ?? "",
        reports: num(r.reports),
        cleanups: num(r.cleanups),
      }))
    },

    async heatmap(limit: number): Promise<HeatmapCellRow[]> {
      const rows = await sql<
        { geoid: string; name: string; density: string; lat: number; lng: number }[]
      >`
        SELECT
          j.geoid,
          j.name,
          COUNT(r.id)::text AS density,
          ST_Y(ST_Centroid(j.geom)) AS lat,
          ST_X(ST_Centroid(j.geom)) AS lng
        FROM jurisdictions j
        JOIN reports r
          ON r.jurisdiction_geoid = j.geoid
          AND r.deleted_at IS NULL
          AND r.visibility = 'public'
        GROUP BY j.geoid, j.name, j.geom
        ORDER BY COUNT(r.id) DESC
        LIMIT ${limit}
      `
      return rows.map((r) => ({
        geoid: r.geoid,
        name: r.name,
        density: num(r.density),
        lat: r.lat,
        lng: r.lng,
      }))
    },

    async retention(cohorts: number): Promise<RetentionRow[]> {
      const rows = await sql<
        { y: string; m: string; size: string; period: string; active: string }[]
      >`
        WITH cohort_users AS (
          SELECT
            u.id AS user_id,
            date_trunc('month', u.created_at) AS cohort_month
          FROM users u
          WHERE u.created_at >= date_trunc('month', now()) - make_interval(months => ${cohorts - 1})
        ),
        activity AS (
          SELECT reporter_user_id AS user_id, date_trunc('month', created_at) AS active_month
          FROM reports
          WHERE reporter_user_id IS NOT NULL AND deleted_at IS NULL
          UNION ALL
          SELECT user_id, date_trunc('month', joined_at) AS active_month
          FROM cleanup_members
          WHERE joined_at IS NOT NULL
        ),
        cohort_sizes AS (
          SELECT cohort_month, COUNT(*)::int AS size
          FROM cohort_users
          GROUP BY cohort_month
        ),
        active_counts AS (
          SELECT
            cu.cohort_month,
            (
              (EXTRACT(YEAR FROM a.active_month) - EXTRACT(YEAR FROM cu.cohort_month)) * 12
              + (EXTRACT(MONTH FROM a.active_month) - EXTRACT(MONTH FROM cu.cohort_month))
            )::int AS period,
            COUNT(DISTINCT cu.user_id)::int AS active
          FROM cohort_users cu
          JOIN activity a ON a.user_id = cu.user_id
          WHERE a.active_month >= cu.cohort_month
          GROUP BY cu.cohort_month, period
        )
        SELECT
          EXTRACT(YEAR FROM cs.cohort_month)::text AS y,
          EXTRACT(MONTH FROM cs.cohort_month)::text AS m,
          cs.size::text AS size,
          COALESCE(ac.period, 0)::text AS period,
          COALESCE(ac.active, 0)::text AS active
        FROM cohort_sizes cs
        LEFT JOIN active_counts ac ON ac.cohort_month = cs.cohort_month
        ORDER BY cs.cohort_month, period
      `
      const byCohort = new Map<string, RetentionRow>()
      for (const row of rows) {
        const year = num(row.y)
        const month = num(row.m)
        const key = `${year}-${month}`
        let cohort = byCohort.get(key)
        if (!cohort) {
          cohort = { year, month, size: num(row.size), activeByPeriod: [] }
          byCohort.set(key, cohort)
        }
        const period = num(row.period)
        if (period >= 0 && period < cohorts) {
          cohort.activeByPeriod[period] = num(row.active)
        }
      }
      const result: RetentionRow[] = []
      for (const cohort of byCohort.values()) {
        const dense: number[] = []
        for (let i = 0; i < cohorts; i++) dense.push(cohort.activeByPeriod[i] ?? 0)
        result.push({ ...cohort, activeByPeriod: dense })
      }
      result.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month))
      return result
    },
  }
}
