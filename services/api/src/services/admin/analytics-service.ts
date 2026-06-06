/**
 * Admin analytics service (Phase 2): the 11 read-only aggregate endpoints (#56-#66, enumeration 2.G /
 * 4.11). All derived from reports / cleanups / jurisdictions / users / mail_events.
 *
 * The AnalyticsRepository returns RAW aggregates (counts, grouped rows, medians computed in SQL); this
 * service does the PURE SHAPING the wire DTOs need: percentage computation, filling the 6 canonical
 * report categories (so a category with no reports still renders a 0 bar), building the funnel stage
 * percentages, computing KPI deltas + direction arrows, and generating the month / week labels. Every
 * shaping helper here is pure + unit-testable with seeded aggregate inputs; the SQL-heavy repo methods are
 * exercised by the Docker-gated integration test.
 *
 * Reconciliation (decisions 8): by-category + resolution-by-category use the 6 real report categories
 * (the design's "cleanup" is the Events domain, not a report category). "Avg. route time" is a Phase 3
 * (VRP) metric and is reported as 0 with a "Phase 3" delta until routing is deployed.
 */

import type {
  AnalyticsByCategoryResponse,
  AnalyticsCategoryRow,
  AnalyticsCoverageResponse,
  AnalyticsEventsResponse,
  AnalyticsFunnelResponse,
  AnalyticsHeatmapResponse,
  AnalyticsKpi,
  AnalyticsKpisResponse,
  AnalyticsPinsByWeekResponse,
  AnalyticsResolutionByCategoryResponse,
  AnalyticsRetentionResponse,
  AnalyticsTopContributorsResponse,
  AnalyticsTopJurisdictionsResponse,
  ReportCategory,
} from "@civfix/shared"

// ---------------------------------------------------------------------------
// Canonical taxonomy + labels (the 6 real report categories, in canonical order)
// ---------------------------------------------------------------------------

/** The 6 canonical report categories in canonical order (mirrors REPORT_CATEGORY_VALUES). */
export const ANALYTICS_CATEGORIES: readonly ReportCategory[] = [
  "trash",
  "recycling",
  "graffiti",
  "hazard",
  "water",
  "other",
] as const

/** Short month labels for the byMonth / cohort axes. */
const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** How many trailing weeks the pins-by-week trend covers. */
export const PINS_BY_WEEK_WEEKS = 8
/** How many trailing months the events byMonth trend covers. */
export const EVENTS_BY_MONTH_MONTHS = 8
/** How many cohort months the retention grid covers. */
export const RETENTION_COHORTS = 6

// ---------------------------------------------------------------------------
// Repository raw-aggregate shapes
// ---------------------------------------------------------------------------

/** Two-period counter (this period vs the prior period) used to compute a KPI delta. */
export interface PeriodCount {
  current: number
  previous: number
}

/** The raw KPI aggregates (this month vs last month) the repo returns. */
export interface KpiAggregates {
  pins: PeriodCount
  /** Resolved share is computed by the service from resolved / total per period. */
  resolvedRatio: { current: number; previous: number }
  cleanupsPlanned: PeriodCount
  events: PeriodCount
  volunteers: PeriodCount
}

/** One weekly bucket: the ISO week-start date + the pin count in that week. */
export interface WeekBucket {
  weekStart: Date
  count: number
}

/** One monthly bucket: year + month (1-12) + the value in that month. */
export interface MonthBucket {
  year: number
  month: number
  count: number
}

/** A per-category aggregate row (category -> count). */
export interface CategoryCount {
  category: ReportCategory
  count: number
}

/** A per-category median-hours row. */
export interface CategoryMedian {
  category: ReportCategory
  medianHours: number
}

/** Raw funnel stage counts (each is a count of reports that reached that stage). */
export interface FunnelCounts {
  dropped: number
  routed: number
  acknowledged: number
  resolved: number
}

/** Raw coverage counts (jurisdictions WITH a contact vs WITHOUT). */
export interface CoverageCounts {
  mapped: number
  needsMapping: number
}

/** Raw event aggregates (this month + volunteers + bags + the byMonth buckets). */
export interface EventAggregates {
  thisMonth: number
  volunteers: number
  bags: number
  byMonth: MonthBucket[]
}

/** A top-jurisdiction raw row (org name + pin volume + resolved count). */
export interface TopJurisdictionRow {
  org: string
  pins: number
  resolved: number
}

/** A top-contributor raw row (name + city + report + cleanup counts). */
export interface TopContributorRow {
  name: string
  city: string
  reports: number
  cleanups: number
}

/** A heatmap raw cell (jurisdiction geoid + name + pin density + centroid lat/lng). */
export interface HeatmapCellRow {
  geoid: string
  name: string
  density: number
  lat: number
  lng: number
}

/**
 * A retention raw row: one cohort (signup year/month) with its size and, for each trailing period index,
 * the number of cohort members ACTIVE in that period (period 0 = the signup month). The service converts
 * the active counts to retention ratios.
 */
export interface RetentionRow {
  year: number
  month: number
  size: number
  /** activeByPeriod[i] = members active in period i (0-based; 0 is the signup month). */
  activeByPeriod: number[]
}

/**
 * Persistence seam for analytics. The Drizzle impl runs the (raw SQL) aggregates; the offline tests pass
 * an in-memory impl that returns canned aggregates so the SHAPING is unit-tested without a database.
 */
export interface AnalyticsRepository {
  kpis(): Promise<KpiAggregates>
  pinsByWeek(weeks: number): Promise<WeekBucket[]>
  byCategory(): Promise<CategoryCount[]>
  funnel(): Promise<FunnelCounts>
  coverage(): Promise<CoverageCounts>
  resolutionByCategory(): Promise<CategoryMedian[]>
  events(months: number): Promise<EventAggregates>
  topJurisdictions(limit: number): Promise<TopJurisdictionRow[]>
  topContributors(limit: number): Promise<TopContributorRow[]>
  heatmap(limit: number): Promise<HeatmapCellRow[]>
  retention(cohorts: number): Promise<RetentionRow[]>
}

// ---------------------------------------------------------------------------
// Pure shaping helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/** Round to one decimal place (KPI deltas, percentages render with one decimal). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Percentage (0-100) of part over whole, one decimal; 0 when whole is 0 (no divide-by-zero). */
export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return round1((part / whole) * 100)
}

/** Direction of a delta for the up/down arrow. */
export function deltaDir(current: number, previous: number): "up" | "down" | "flat" {
  if (current > previous) return "up"
  if (current < previous) return "down"
  return "flat"
}

/** A signed integer-count delta label (e.g. "+5", "-2", "0"). */
export function countDeltaLabel(current: number, previous: number): string {
  const diff = current - previous
  if (diff > 0) return `+${diff}`
  return `${diff}`
}

/** A signed percentage-point delta label (e.g. "+3.0pt", "-1.5pt"). */
export function pointDeltaLabel(currentPct: number, previousPct: number): string {
  const diff = round1(currentPct - previousPct)
  if (diff > 0) return `+${diff}pt`
  return `${diff}pt`
}

/** Build the KPI cells from the raw period aggregates (deltas + arrows computed here). */
export function buildKpis(agg: KpiAggregates): AnalyticsKpi[] {
  const resolvedCurrentPct = round1(agg.resolvedRatio.current * 100)
  const resolvedPreviousPct = round1(agg.resolvedRatio.previous * 100)
  return [
    {
      label: "Pins this month",
      num: agg.pins.current,
      delta: countDeltaLabel(agg.pins.current, agg.pins.previous),
      dir: deltaDir(agg.pins.current, agg.pins.previous),
    },
    {
      label: "Resolved",
      num: resolvedCurrentPct,
      delta: pointDeltaLabel(resolvedCurrentPct, resolvedPreviousPct),
      dir: deltaDir(resolvedCurrentPct, resolvedPreviousPct),
    },
    {
      label: "Cleanups planned",
      num: agg.cleanupsPlanned.current,
      delta: countDeltaLabel(agg.cleanupsPlanned.current, agg.cleanupsPlanned.previous),
      dir: deltaDir(agg.cleanupsPlanned.current, agg.cleanupsPlanned.previous),
    },
    {
      // Avg. route time is a Phase 3 (VRP) metric; reported as 0 until routing is deployed. The analytics
      // page hides any label matching /route/i in its KPI strip, but the value is part of the contract.
      label: "Avg. route time",
      num: 0,
      delta: "Phase 3",
      dir: "flat",
    },
    {
      label: "Events this month",
      num: agg.events.current,
      delta: countDeltaLabel(agg.events.current, agg.events.previous),
      dir: deltaDir(agg.events.current, agg.events.previous),
    },
    {
      label: "Volunteers",
      num: agg.volunteers.current,
      delta: countDeltaLabel(agg.volunteers.current, agg.volunteers.previous),
      dir: deltaDir(agg.volunteers.current, agg.volunteers.previous),
    },
  ]
}

/**
 * Fill the per-category counts into the 6 canonical categories (in canonical order) with pct over the
 * total. A category with no rows renders count 0, pct 0.
 */
export function buildByCategory(rows: CategoryCount[]): AnalyticsCategoryRow[] {
  const byCat = new Map<ReportCategory, number>()
  for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.count)
  const total = [...byCat.values()].reduce((a, b) => a + b, 0)
  return ANALYTICS_CATEGORIES.map((cat) => {
    const count = byCat.get(cat) ?? 0
    return { cat, count, pct: pct(count, total) }
  })
}

/** Fill the per-category medians into the 6 canonical categories (missing -> 0 hours). */
export function buildResolutionByCategory(rows: CategoryMedian[]): AnalyticsResolutionByCategoryResponse {
  const byCat = new Map<ReportCategory, number>()
  for (const r of rows) byCat.set(r.category, r.medianHours)
  return {
    rows: ANALYTICS_CATEGORIES.map((cat) => ({ cat, hours: round1(byCat.get(cat) ?? 0) })),
  }
}

/**
 * Build the funnel stages with percentages relative to the FIRST stage (pin dropped). Each stage's pct is
 * its count over the dropped count (the top of the funnel); the first stage is 100% when there is any
 * volume.
 */
export function buildFunnel(counts: FunnelCounts): AnalyticsFunnelResponse {
  const top = counts.dropped
  const stage = (label: string, count: number) => ({ stage: label, count, pct: pct(count, top) })
  return {
    stages: [
      stage("Pin dropped", counts.dropped),
      stage("Routed to gov", counts.routed),
      stage("Acknowledged", counts.acknowledged),
      stage("Resolved", counts.resolved),
    ],
  }
}

/** Build the coverage response (pct = mapped over the mapped + needs-mapping total). */
export function buildCoverage(counts: CoverageCounts): AnalyticsCoverageResponse {
  const total = counts.mapped + counts.needsMapping
  return { pct: pct(counts.mapped, total), mapped: counts.mapped, needsMapping: counts.needsMapping }
}

/**
 * Fill the weekly buckets into a fixed `weeks`-length series ending at the most recent week. `buckets` is
 * the repo's sparse list (one entry per week that had pins); this aligns them to the trailing window
 * ending at `ref` and produces the `weeks`-element value array + the design's labels ('', ..., 'last',
 * 'now'). Pure (ref injected).
 */
export function buildPinsByWeek(
  buckets: WeekBucket[],
  weeks: number,
  ref: Date,
): AnalyticsPinsByWeekResponse {
  // Index buckets by their week-start (UTC midnight of the Monday-anchored week is what the repo emits;
  // here we only need to bucket by the same week key the repo used). We bucket by the difference in whole
  // weeks from the current week.
  const refWeek = startOfWeekUtc(ref).getTime()
  const values = new Array<number>(weeks).fill(0)
  for (const b of buckets) {
    const bWeek = startOfWeekUtc(b.weekStart).getTime()
    const weeksAgo = Math.round((refWeek - bWeek) / WEEK_MS)
    if (weeksAgo >= 0 && weeksAgo < weeks) {
      // index 0 is the oldest week in the window, weeks-1 is the current week.
      values[weeks - 1 - weeksAgo] = b.count
    }
  }
  const labels = values.map((_v, i) => {
    if (i === weeks - 1) return "now"
    if (i === weeks - 2) return "last"
    return ""
  })
  return { weeks: values, labels }
}

/**
 * Fill the monthly buckets into a fixed `months`-length series ending at the month of `ref`, with short
 * month labels. Pure (ref injected).
 */
export function buildByMonth(
  buckets: MonthBucket[],
  months: number,
  ref: Date,
): { byMonth: number[]; monthLabels: string[] } {
  const refYear = ref.getUTCFullYear()
  const refMonth = ref.getUTCMonth() + 1 // 1-12
  const byKey = new Map<string, number>()
  for (const b of buckets) byKey.set(`${b.year}-${b.month}`, b.count)
  const byMonth: number[] = []
  const monthLabels: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const { year, month } = subtractMonths(refYear, refMonth, i)
    byMonth.push(byKey.get(`${year}-${month}`) ?? 0)
    monthLabels.push(MONTH_ABBR[month - 1] ?? "")
  }
  return { byMonth, monthLabels }
}

/** Build the events response from the raw aggregates + the trailing monthly trend. */
export function buildEvents(
  agg: EventAggregates,
  months: number,
  ref: Date,
): AnalyticsEventsResponse {
  const { byMonth, monthLabels } = buildByMonth(agg.byMonth, months, ref)
  return {
    thisMonth: agg.thisMonth,
    volunteers: agg.volunteers,
    bags: agg.bags,
    byMonth,
    monthLabels,
  }
}

/** Build the retention grid: each cohort's active counts become retention ratios (0-1) by period. */
export function buildRetention(rows: RetentionRow[], periods: number): AnalyticsRetentionResponse {
  const cohorts = rows.map((r) => {
    const values: number[] = []
    for (let i = 0; i < periods; i++) {
      const active = r.activeByPeriod[i] ?? 0
      values.push(r.size > 0 ? round1((active / r.size) * 100) / 100 : 0)
    }
    return {
      cohort: `${MONTH_ABBR[r.month - 1] ?? ""} ${r.year}`,
      size: r.size,
      values,
    }
  })
  const periodLabels = Array.from({ length: periods }, (_v, i) => `M${i}`)
  return { cohorts, periodLabels }
}

// ---------------------------------------------------------------------------
// Date helpers (UTC; pure)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** UTC start-of-week anchored to Monday (matches date_trunc('week', ...) in Postgres, which is Monday). */
export function startOfWeekUtc(d: Date): Date {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // getUTCDay: 0=Sun..6=Sat. Postgres week starts Monday; shift so Monday is the anchor.
  const dow = copy.getUTCDay()
  const deltaToMonday = (dow + 6) % 7
  return new Date(copy.getTime() - deltaToMonday * DAY_MS)
}

/** Subtract `n` whole months from (year, month[1-12]) returning the resulting (year, month). */
export function subtractMonths(year: number, month: number, n: number): { year: number; month: number } {
  // Convert to a 0-based absolute month index, subtract, convert back.
  const idx = year * 12 + (month - 1) - n
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Default row cap for the table-style analytics (top jurisdictions / contributors / heatmap). */
export const ANALYTICS_TABLE_LIMIT = 10
/** Heatmap cell cap (a denser list than the small tables). */
export const ANALYTICS_HEATMAP_LIMIT = 100

export interface AnalyticsServiceDeps {
  repo: AnalyticsRepository
  /** Injectable clock (defaults to Date.now) so the week/month windows are deterministic. */
  now?: () => Date
}

export interface AnalyticsService {
  kpis(): Promise<AnalyticsKpisResponse>
  pinsByWeek(): Promise<AnalyticsPinsByWeekResponse>
  byCategory(): Promise<AnalyticsByCategoryResponse>
  funnel(): Promise<AnalyticsFunnelResponse>
  coverage(): Promise<AnalyticsCoverageResponse>
  resolutionByCategory(): Promise<AnalyticsResolutionByCategoryResponse>
  events(): Promise<AnalyticsEventsResponse>
  topJurisdictions(): Promise<AnalyticsTopJurisdictionsResponse>
  topContributors(): Promise<AnalyticsTopContributorsResponse>
  heatmap(): Promise<AnalyticsHeatmapResponse>
  retention(): Promise<AnalyticsRetentionResponse>
}

export function makeAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const now = deps.now ?? (() => new Date())
  return {
    async kpis(): Promise<AnalyticsKpisResponse> {
      return { kpis: buildKpis(await deps.repo.kpis()) }
    },
    async pinsByWeek(): Promise<AnalyticsPinsByWeekResponse> {
      const buckets = await deps.repo.pinsByWeek(PINS_BY_WEEK_WEEKS)
      return buildPinsByWeek(buckets, PINS_BY_WEEK_WEEKS, now())
    },
    async byCategory(): Promise<AnalyticsByCategoryResponse> {
      return { rows: buildByCategory(await deps.repo.byCategory()) }
    },
    async funnel(): Promise<AnalyticsFunnelResponse> {
      return buildFunnel(await deps.repo.funnel())
    },
    async coverage(): Promise<AnalyticsCoverageResponse> {
      return buildCoverage(await deps.repo.coverage())
    },
    async resolutionByCategory(): Promise<AnalyticsResolutionByCategoryResponse> {
      return buildResolutionByCategory(await deps.repo.resolutionByCategory())
    },
    async events(): Promise<AnalyticsEventsResponse> {
      const agg = await deps.repo.events(EVENTS_BY_MONTH_MONTHS)
      return buildEvents(agg, EVENTS_BY_MONTH_MONTHS, now())
    },
    async topJurisdictions(): Promise<AnalyticsTopJurisdictionsResponse> {
      const rows = await deps.repo.topJurisdictions(ANALYTICS_TABLE_LIMIT)
      return {
        rows: rows.map((r) => ({ org: r.org, pins: r.pins, resolved: pct(r.resolved, r.pins) })),
      }
    },
    async topContributors(): Promise<AnalyticsTopContributorsResponse> {
      const rows = await deps.repo.topContributors(ANALYTICS_TABLE_LIMIT)
      return {
        rows: rows.map((r) => ({
          name: r.name,
          city: r.city,
          reports: r.reports,
          cleanups: r.cleanups,
        })),
      }
    },
    async heatmap(): Promise<AnalyticsHeatmapResponse> {
      const cells = await deps.repo.heatmap(ANALYTICS_HEATMAP_LIMIT)
      return {
        cells: cells.map((c) => ({
          geoid: c.geoid,
          name: c.name,
          density: c.density,
          lat: c.lat,
          lng: c.lng,
        })),
      }
    },
    async retention(): Promise<AnalyticsRetentionResponse> {
      const rows = await deps.repo.retention(RETENTION_COHORTS)
      return buildRetention(rows, RETENTION_COHORTS)
    },
  }
}
