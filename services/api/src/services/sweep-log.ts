/**
 * The level for a scheduled sweep's summary line. Sweeps run every few minutes whether or not there is
 * anything to do; only a run that changed something (or failed) is worth an info line in production.
 */
export function sweepLogLevel(counts: Record<string, number>): "info" | "debug" {
  return Object.values(counts).some((count) => count > 0) ? "info" : "debug"
}
