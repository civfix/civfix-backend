import type {
  BreakdownRow,
  EventPhase,
  FunnelStep,
  Panel,
  SeriesPoint,
  SuppressedRate,
} from "@civfix/shared"
import {
  eventPhase,
  suppressRate,
  type DayCount,
  type DerivedBreakdownRow,
  type DerivedPanel,
  type SeriesClosure,
} from "@civfix/shared/host"
import type { EventClockRecord } from "./analytics-repository.js"
import type { MetricRow } from "./metrics-repository.js"
import { MS_PER_DAY } from "../../lib/time.js"

export const PORTFOLIO_EVENT_LIMIT = 200

const ISO_DAY_LENGTH = 10
const EPOCH_YEAR = 1970

export function isoDayOf(at: Date): string {
  return at.toISOString().slice(0, ISO_DAY_LENGTH)
}

export function shiftDayKey(day: string, deltaDays: number): string {
  const [year, month, date] = day.split("-").map(Number)
  const shifted = new Date(
    Date.UTC(year ?? EPOCH_YEAR, (month ?? 1) - 1, date ?? 1) + deltaDays * MS_PER_DAY,
  )
  return isoDayOf(shifted)
}

export function clockPhase(clock: EventClockRecord, at: Date): EventPhase {
  return eventPhase(
    {
      status: clock.status,
      scheduledAt: clock.scheduledAt.toISOString(),
      endsAt: clock.endsAt?.toISOString() ?? null,
      completedAt: clock.completedAt?.toISOString() ?? null,
    },
    at.getTime(),
  )
}

export function emptyRate(): SuppressedRate {
  return { value: null, numerator: null, denominator: null, suppressed: true }
}

export function toSuppressedRate(
  ratio: { value: number | null; suppressed: boolean },
  numerator: number,
  denominator: number,
): SuppressedRate {
  return {
    value: ratio.value,
    numerator: ratio.suppressed ? null : numerator,
    denominator: ratio.suppressed ? null : denominator,
    suppressed: ratio.suppressed,
  }
}

export function toRate(numerator: number, denominator: number): SuppressedRate {
  return toSuppressedRate(suppressRate(numerator, denominator), numerator, denominator)
}

export function toSeries(
  points: readonly { day: string; value: number | null; suppressed: boolean }[],
): SeriesPoint[] {
  return points.map((point) => ({
    day: point.day,
    value: point.value,
    suppressed: point.suppressed,
  }))
}

export function toFunnelSteps(
  panel: DerivedPanel<{ key: string; value: number | null; suppressed: boolean }>,
): FunnelStep[] {
  return panel.rows.map((row) => ({
    step: row.key,
    label: row.key,
    value: row.value,
    suppressed: row.suppressed,
  }))
}

export function closureAllowsTotal(closure: SeriesClosure): boolean {
  return closure.panelSuppressed || closure.totalPublishable
}

export function metricTotal(rows: readonly MetricRow[], metric: string): number | null {
  const matching = rows.filter((row) => row.metric === metric)
  if (matching.length === 0) return null
  return matching.reduce((acc, row) => acc + row.value, 0)
}

export function seriesOf(rows: readonly MetricRow[], metric: string): DayCount[] {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    if (row.metric !== metric) continue
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.value)
  }
  return [...byDay].map(([day, count]) => ({ day, count }))
}

export function toPanel(panel: DerivedPanel<DerivedBreakdownRow>, maxRows?: number): Panel {
  const rows = maxRows === undefined ? panel.rows : panel.rows.slice(0, maxRows)
  return {
    panelSuppressed: panel.panelSuppressed,
    rows: rows.map(
      (row): BreakdownRow => ({
        key: row.key,
        label: row.key,
        value: row.value,
        suppressed: row.suppressed,
      }),
    ),
  }
}
