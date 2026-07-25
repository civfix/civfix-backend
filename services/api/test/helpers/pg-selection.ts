/**
 * "Does this vitest run need the shared Postgres container at all?"
 *
 * globalSetup runs for EVERY invocation, including `npx vitest run test/unit/foo.test.ts` — and booting
 * PostGIS + applying 60 migrations to serve a run that never touches the database would tax every unit
 * test run on a machine that happens to have Docker up. vitest resolves its file list AFTER globalSetup,
 * and hands globalSetup no view of it, so the decision is made from the CLI's own positional file
 * filters (the same substring match vitest itself applies to a spec's absolute path).
 *
 * BIAS: every ambiguous case answers "start it". A filter we cannot resolve to a known test file (a
 * space-separated flag value such as the `dot` in `--reporter dot`, a typo, `--related`'s source paths)
 * makes this return true, so the worst outcome of a misread argv is a container nobody uses — never a
 * silently-skipped integration suite. And withPg() still falls back to booting its own container if it
 * finds no shared one, so this module can only ever affect speed, not correctness.
 */

/** vitest's own subcommands; the first positional is one of these, not a file filter. */
const SUBCOMMANDS = new Set([
  "run",
  "watch",
  "dev",
  "related",
  "bench",
  "init",
  "list",
  "typecheck",
])

/**
 * Extract the positional file filters from a vitest argv (`process.argv.slice(2)`).
 *
 * Flags are dropped; a leading subcommand is dropped. The VALUE of a space-separated flag
 * (`--reporter dot`) is indistinguishable from a filter here and is deliberately kept — it resolves to
 * no test file, which `selectSharedPgStart` treats as "unrecognized, start anyway".
 */
export function cliFileFilters(argv: readonly string[]): string[] {
  const tokens = [...argv]
  if (tokens.length > 0 && tokens[0] !== undefined && SUBCOMMANDS.has(tokens[0])) tokens.shift()
  return tokens.filter((t) => !t.startsWith("-") && t.length > 0)
}

/** Strip vitest's `:line[:col]` suffix (`foo.test.ts:12`) so the rest is a plain path fragment. */
function stripLineSuffix(filter: string): string {
  return filter.replace(/:\d+(?::\d+)?$/, "")
}

export interface SharedPgSelection {
  start: boolean
  /**
   * Human-readable justification. globalSetup forwards it to the workers in the provided context
   * (`{ kind: "not-started", reason }`), so a surprising decision is visible from a test rather than
   * only in a log line every unit-test run would have to pay for.
   */
  reason: string
}

/**
 * Decide whether to start the shared container.
 *
 * @param filters    positional filters from `cliFileFilters`
 * @param testFiles  every test file this project could run (absolute paths)
 * @param needsPg    true when that test file uses the Postgres harness
 */
export function selectSharedPgStart(
  filters: readonly string[],
  testFiles: readonly string[],
  needsPg: (file: string) => boolean,
): SharedPgSelection {
  if (filters.length === 0) {
    return { start: true, reason: "no file filters: the whole suite runs" }
  }
  const matched = new Set<string>()
  for (const raw of filters) {
    const filter = stripLineSuffix(raw)
    if (filter === "") continue
    for (const file of testFiles) {
      if (file.includes(filter)) matched.add(file)
    }
  }
  if (matched.size === 0) {
    return {
      start: true,
      reason: `filters ${JSON.stringify([...filters])} match no known test file: starting to be safe`,
    }
  }
  const pgFiles = [...matched].filter((f) => needsPg(f))
  if (pgFiles.length > 0) {
    return { start: true, reason: `${pgFiles.length} selected test file(s) use the pg harness` }
  }
  return {
    start: false,
    reason: `none of the ${matched.size} selected test file(s) use the pg harness`,
  }
}
