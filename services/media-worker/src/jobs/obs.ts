/**
 * Every runner (media.checks + the four crons) takes an injectable clock, logger and error reporter so
 * tests are deterministic and offline mode stays silent. The fallbacks were hand-rolled at seven call
 * sites and had already drifted in shape; resolving them in ONE place keeps "what a runner logs/reports
 * when nothing is injected" a single decision rather than seven.
 */

export type JobLogFn = (line: string, extra?: Record<string, unknown>) => void
export type JobReportFn = (err: unknown, context?: Record<string, unknown>) => void

export interface JobObsDeps {
  now?: () => Date
  log?: JobLogFn
  report?: JobReportFn
}

export interface JobObs {
  log: JobLogFn
  report: JobReportFn
  now: () => Date
}

const defaultLog: JobLogFn = (line, extra) => console.log(line, extra ?? {})
/** Reporting is OPTIONAL by design: without a GlitchTip DSN wired there is nowhere to report to. */
const noopReport: JobReportFn = () => {}
const realClock = (): Date => new Date()

export function resolveJobObs(deps: JobObsDeps): JobObs {
  return {
    log: deps.log ?? defaultLog,
    report: deps.report ?? noopReport,
    now: deps.now ?? realClock,
  }
}
