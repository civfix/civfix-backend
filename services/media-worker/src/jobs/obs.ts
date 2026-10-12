/**
 * Shared observability deps for the worker's job runners.
 *
 * Every runner (media.checks + the four crons) takes an injectable clock, logger and error reporter so
 * tests are deterministic and offline mode stays silent. The fallbacks were hand-rolled at seven call
 * sites and had already drifted in shape; resolving them in ONE place keeps "what a runner logs/reports
 * when nothing is injected" a single decision rather than seven.
 */

export type JobLogFn = (line: string, extra?: Record<string, unknown>) => void
export type JobReportFn = (err: unknown, context?: Record<string, unknown>) => void

/** The observability slice every job runner's deps interface extends. All optional; see resolveJobObs. */
export interface JobObsDeps {
  /** Injectable clock (defaults to a real `new Date()`) for deterministic tests. */
  now?: () => Date
  log?: JobLogFn
  /** Lines only a local run wants to see, such as a sweep that found nothing to do. */
  debug?: JobLogFn
  report?: JobReportFn
}

export interface JobObs {
  log: JobLogFn
  debug: JobLogFn
  report: JobReportFn
  now: () => Date
}

const defaultLog: JobLogFn = (line, extra) => console.log(line, extra ?? {})
/**
 * The worker writes plain console lines with no level filter, and console.debug reaches stdout like
 * any other line, so production drops debug lines here instead of shipping them to Grafana.
 */
export const debugLog: JobLogFn = (line, extra) => {
  if (process.env.NODE_ENV === "production") return
  console.debug(line, extra ?? {})
}
/** Reporting is OPTIONAL by design: without a GlitchTip DSN wired there is nowhere to report to. */
const noopReport: JobReportFn = () => {}
const realClock = (): Date => new Date()

/** Resolve the injectable log/report/clock to their defaults. */
export function resolveJobObs(deps: JobObsDeps): JobObs {
  return {
    log: deps.log ?? defaultLog,
    debug: deps.debug ?? debugLog,
    report: deps.report ?? noopReport,
    now: deps.now ?? realClock,
  }
}
