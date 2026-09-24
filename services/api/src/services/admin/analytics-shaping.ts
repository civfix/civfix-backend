import type {
  AnalyticsCategoryRow,
  AnalyticsCoverageResponse,
  AnalyticsEventsResponse,
  AnalyticsFunnelResponse,
  AnalyticsKpi,
  AnalyticsPinsByWeekResponse,
  AnalyticsResolutionByCategoryResponse,
  AnalyticsRetentionResponse,
  ReportCategory,
} from "@civfix/shared"
import { ANALYTICS_CATEGORIES } from "./analytics-types.js"
import type {
  CategoryCount,
  CategoryMedian,
  CoverageCounts,
  EventAggregates,
  FunnelCounts,
  KpiAggregates,
  MonthBucket,
  RetentionRow,
  WeekBucket,
} from "./analytics-repository.js"
import { MS_PER_DAY, MS_PER_WEEK } from "../../lib/time.js"

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

const ROUTE_TIME_PENDING_DELTA = "Phase 3"

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Percentage (0-100) of part over whole, one decimal; 0 when whole is 0 (no divide-by-zero). */
export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return round1((part / whole) * 100)
}

export function deltaDir(current: number, previous: number): "up" | "down" | "flat" {
  if (current > previous) return "up"
  if (current < previous) return "down"
  return "flat"
}

export function countDeltaLabel(current: number, previous: number): string {
  const diff = current - previous
  if (diff > 0) return `+${diff}`
  return `${diff}`
}

export function pointDeltaLabel(currentPct: number, previousPct: number): string {
  const diff = round1(currentPct - previousPct)
  if (diff > 0) return `+${diff}pt`
  return `${diff}pt`
}

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
      // Reported as 0 until routing is deployed. The analytics page hides any label matching /route/i in
      // its KPI strip, but the value is part of the contract.
      label: "Avg. route time",
      num: 0,
      delta: ROUTE_TIME_PENDING_DELTA,
      dir: "flat",
    },
    {
      label: "Events this month",
      num: agg.events.current,
      delta: countDeltaLabel(agg.events.current, agg.events.previous),
      dir: deltaDir(agg.events.current, agg.events.previous),
    },
    {
      label: "New users",
      num: agg.newUsers.current,
      delta: countDeltaLabel(agg.newUsers.current, agg.newUsers.previous),
      dir: deltaDir(agg.newUsers.current, agg.newUsers.previous),
    },
  ]
}

/** Fill the per-category counts into the 6 canonical categories (canonical order) with pct over total. */
export function buildByCategory(rows: CategoryCount[]): AnalyticsCategoryRow[] {
  const byCat = new Map<ReportCategory, number>()
  for (const r of rows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.count)
  const total = [...byCat.values()].reduce((a, b) => a + b, 0)
  return ANALYTICS_CATEGORIES.map((cat) => {
    const count = byCat.get(cat) ?? 0
    return { cat, count, pct: pct(count, total) }
  })
}

export function buildResolutionByCategory(
  rows: CategoryMedian[],
): AnalyticsResolutionByCategoryResponse {
  const byCat = new Map<ReportCategory, number>()
  for (const r of rows) byCat.set(r.category, r.medianHours)
  return {
    rows: ANALYTICS_CATEGORIES.map((cat) => ({ cat, hours: round1(byCat.get(cat) ?? 0) })),
  }
}

/** Funnel stages with each stage's pct relative to the FIRST stage (pin dropped). */
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

export function buildCoverage(counts: CoverageCounts): AnalyticsCoverageResponse {
  const total = counts.mapped + counts.needsMapping
  return {
    pct: pct(counts.mapped, total),
    mapped: counts.mapped,
    needsMapping: counts.needsMapping,
  }
}

/**
 * Align the repo's sparse weekly buckets to a fixed `weeks`-length trailing window ending at `ref`,
 * producing the value array and the design's labels ('', ..., 'last', 'now').
 */
export function buildPinsByWeek(
  buckets: WeekBucket[],
  weeks: number,
  ref: Date,
): AnalyticsPinsByWeekResponse {
  const refWeek = startOfWeekUtc(ref).getTime()
  const values = new Array<number>(weeks).fill(0)
  for (const b of buckets) {
    const bWeek = startOfWeekUtc(b.weekStart).getTime()
    const weeksAgo = Math.round((refWeek - bWeek) / MS_PER_WEEK)
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

/** Align the repo's sparse monthly buckets to a fixed `months`-length window ending at `ref`. */
export function buildByMonth(
  buckets: MonthBucket[],
  months: number,
  ref: Date,
): { byMonth: number[]; monthLabels: string[] } {
  const refYear = ref.getUTCFullYear()
  const refMonth = ref.getUTCMonth() + 1
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

export function buildRetention(rows: RetentionRow[], periods: number): AnalyticsRetentionResponse {
  const cohorts = rows.map((r) => {
    const values: number[] = []
    for (let i = 0; i < periods; i++) {
      const active = r.activeByPeriod[i] ?? 0
      // A retention RATIO (0-1) carried to two decimals (round1 over a percentage, then /100).
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

/** UTC start-of-week anchored to Monday (matches date_trunc('week', ...) in Postgres, which is Monday). */
export function startOfWeekUtc(d: Date): Date {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // getUTCDay: 0=Sun..6=Sat. Postgres week starts Monday; shift so Monday is the anchor.
  const dow = copy.getUTCDay()
  const deltaToMonday = (dow + 6) % 7
  return new Date(copy.getTime() - deltaToMonday * MS_PER_DAY)
}

export function subtractMonths(
  year: number,
  month: number,
  n: number,
): { year: number; month: number } {
  const idx = year * 12 + (month - 1) - n
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 }
}
