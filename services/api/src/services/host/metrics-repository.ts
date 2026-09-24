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
  listRollupEvents(since: Date, after: string | null, limit: number): Promise<string[]>
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
