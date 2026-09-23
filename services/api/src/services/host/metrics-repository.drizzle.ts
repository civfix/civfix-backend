import type { Sql } from "../../db/client.js"

export interface MetricUpsert {
  cleanupId: string
  day: string
  metric: string
  bucket: string
  value: number
}

export interface MetricRow {
  day: string
  metric: string
  bucket: string
  value: number
}

export interface MetricsRepository {
  resolveSlug(slug: string): Promise<{ cleanupId: string; timezone: string | null } | null>
  eventTimezone(cleanupId: string): Promise<string | null>
  listRollupEvents(since: Date, limit: number): Promise<string[]>
  recomputeFromSource(cleanupId: string, timezone: string, since: Date): Promise<MetricUpsert[]>
  upsertExact(rows: readonly MetricUpsert[]): Promise<void>
  upsertGreatest(rows: readonly MetricUpsert[]): Promise<void>
  read(
    cleanupId: string,
    metrics: readonly string[],
    from: string,
    to: string,
  ): Promise<MetricRow[]>
  readMany(
    cleanupIds: readonly string[],
    metrics: readonly string[],
    from: string,
    to: string,
  ): Promise<MetricRow[]>
}

export function makeDrizzleMetricsRepository(sql: Sql): MetricsRepository {
  return {
    async resolveSlug(slug: string) {
      const rows = await sql<{ id: string; timezone: string | null }[]>`
        SELECT id, timezone FROM cleanups
         WHERE page_slug = ${slug} AND status <> 'cancelled'
         LIMIT 1`
      const row = rows[0]
      return row === undefined ? null : { cleanupId: row.id, timezone: row.timezone }
    },

    async eventTimezone(cleanupId: string) {
      const rows = await sql<{ timezone: string | null }[]>`
        SELECT timezone FROM cleanups WHERE id = ${cleanupId} LIMIT 1`
      return rows[0]?.timezone ?? null
    },

    async listRollupEvents(since: Date, limit: number) {
      const rows = await sql<{ id: string }[]>`
        SELECT DISTINCT c.id
          FROM cleanups c
         WHERE c.updated_at >= ${since}
            OR EXISTS (
              SELECT 1 FROM cleanup_registrations r
               WHERE r.cleanup_id = c.id AND r.registered_at >= ${since})
            OR EXISTS (
              SELECT 1 FROM broadcasts b
               WHERE b.cleanup_id = c.id AND b.created_at >= ${since})
         ORDER BY c.id
         LIMIT ${limit}`
      return rows.map((r) => r.id)
    },

    async recomputeFromSource(cleanupId: string, timezone: string, since: Date) {
      const rows = await sql<{ day: string; metric: string; bucket: string; n: string }[]>`
        SELECT to_char((r.registered_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
               'registrations' AS metric, '' AS bucket, count(*)::text AS n
          FROM cleanup_registrations r
         WHERE r.cleanup_id = ${cleanupId} AND r.registered_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((r.cancelled_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'cancellations', '', count(*)::text
          FROM cleanup_registrations r
         WHERE r.cleanup_id = ${cleanupId} AND r.cancelled_at IS NOT NULL AND r.cancelled_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((s.checked_in_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'checkins', '', count(*)::text
          FROM cleanup_registration_seats s
         WHERE s.cleanup_id = ${cleanupId} AND s.checked_in_at IS NOT NULL AND s.checked_in_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((s.no_show_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'no_shows', '', count(*)::text
          FROM cleanup_registration_seats s
         WHERE s.cleanup_id = ${cleanupId} AND s.no_show_at IS NOT NULL AND s.no_show_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((w.created_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'waitlist_joined', '', count(*)::text
          FROM cleanup_waitlist w
         WHERE w.cleanup_id = ${cleanupId} AND w.created_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((b.finished_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'broadcast_recipients', '', sum(b.recipient_count)::text
          FROM broadcasts b
         WHERE b.cleanup_id = ${cleanupId} AND b.finished_at IS NOT NULL AND b.finished_at >= ${since}
         GROUP BY 1
        UNION ALL
        SELECT to_char((d.created_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'broadcast_' || d.status, d.channel, count(*)::text
          FROM broadcast_deliveries d
          JOIN broadcasts b ON b.id = d.broadcast_id
         WHERE b.cleanup_id = ${cleanupId} AND d.created_at >= ${since}
           AND d.status IN ('sent','failed','suppressed')
         GROUP BY 1, 2, 3
        UNION ALL
        SELECT to_char((bu.created_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD'),
               'unsubscribes', '', count(*)::text
          FROM broadcast_unsubscribes bu
         WHERE bu.cleanup_id = ${cleanupId} AND bu.created_at >= ${since}
         GROUP BY 1`
      return rows.map((row) => ({
        cleanupId,
        day: row.day,
        metric: row.metric,
        bucket: row.bucket,
        value: Number(row.n),
      }))
    },

    async upsertExact(rows: readonly MetricUpsert[]) {
      if (rows.length === 0) return
      await sql`
        INSERT INTO event_metrics_daily (cleanup_id, day, metric, bucket, value)
        SELECT t.cleanup_id, t.day::date, t.metric, t.bucket, t.value
          FROM unnest(
                 ${rows.map((r) => r.cleanupId)}::uuid[], ${rows.map((r) => r.day)}::text[],
                 ${rows.map((r) => r.metric)}::text[], ${rows.map((r) => r.bucket)}::text[],
                 ${rows.map((r) => r.value)}::bigint[]
               ) AS t(cleanup_id, day, metric, bucket, value)
        ON CONFLICT (cleanup_id, day, metric, bucket)
          DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
    },

    async upsertGreatest(rows: readonly MetricUpsert[]) {
      if (rows.length === 0) return
      await sql`
        INSERT INTO event_metrics_daily (cleanup_id, day, metric, bucket, value)
        SELECT t.cleanup_id, t.day::date, t.metric, t.bucket, t.value
          FROM unnest(
                 ${rows.map((r) => r.cleanupId)}::uuid[], ${rows.map((r) => r.day)}::text[],
                 ${rows.map((r) => r.metric)}::text[], ${rows.map((r) => r.bucket)}::text[],
                 ${rows.map((r) => r.value)}::bigint[]
               ) AS t(cleanup_id, day, metric, bucket, value)
        ON CONFLICT (cleanup_id, day, metric, bucket)
          DO UPDATE SET value = GREATEST(event_metrics_daily.value, EXCLUDED.value),
                        updated_at = now()`
    },

    async read(cleanupId: string, metrics: readonly string[], from: string, to: string) {
      const rows = await sql<{ day: string; metric: string; bucket: string; value: string }[]>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, bucket, value::text
          FROM event_metrics_daily
         WHERE cleanup_id = ${cleanupId}
           AND metric = ANY(${[...metrics]}::text[])
           AND day BETWEEN ${from}::date AND ${to}::date
         ORDER BY day
         LIMIT 20000`
      return rows.map((row) => ({
        day: row.day,
        metric: row.metric,
        bucket: row.bucket,
        value: Number(row.value),
      }))
    },

    async readMany(
      cleanupIds: readonly string[],
      metrics: readonly string[],
      from: string,
      to: string,
    ) {
      if (cleanupIds.length === 0) return []
      const rows = await sql<{ day: string; metric: string; bucket: string; value: string }[]>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, bucket, sum(value)::text AS value
          FROM event_metrics_daily
         WHERE cleanup_id = ANY(${[...cleanupIds]}::uuid[])
           AND metric = ANY(${[...metrics]}::text[])
           AND day BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1, 2, 3
         ORDER BY day
         LIMIT 20000`
      return rows.map((row) => ({
        day: row.day,
        metric: row.metric,
        bucket: row.bucket,
        value: Number(row.value),
      }))
    },
  }
}
