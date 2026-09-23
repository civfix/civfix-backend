/**
 * Tests for the pg TEST HARNESS itself (test/helpers/pg-selection.ts + the pure half of
 * pg-container.ts). These decide whether a vitest run boots the shared PostGIS container and what
 * database each test file clones, so a silent mistake here either taxes every unit-test run with a
 * container nobody uses or (much worse) hands two test files the same database.
 *
 * The bias under test is deliberate: an ambiguous CLI always resolves to "start the container", because
 * over-starting only costs time while under-starting would let an integration file quietly skip.
 */

import { describe, expect, it } from "vitest"
import { cliFileFilters, selectSharedPgStart } from "./pg-selection.js"
import {
  assertPgSkipAllowed,
  pgSkipDecision,
  uniqueTestDbName,
  uriWithDatabase,
} from "./pg-container.js"

const UNIT = "/repo/services/api/test/unit/cleanups-routes.test.ts"
const INTEGRATION = "/repo/services/api/test/integration/map-pg.test.ts"
const FILES = [UNIT, INTEGRATION]
const needsPg = (file: string): boolean => file === INTEGRATION

describe("cliFileFilters", () => {
  it("drops a leading subcommand and every flag, keeping the positional filters", () => {
    expect(cliFileFilters(["run", "--reporter=dot", "test/unit/a.test.ts", "-u"])).toEqual([
      "test/unit/a.test.ts",
    ])
  })

  it("returns no filters for a bare full-suite run", () => {
    expect(cliFileFilters(["run"])).toEqual([])
    expect(cliFileFilters([])).toEqual([])
    expect(cliFileFilters(["watch", "--coverage"])).toEqual([])
  })

  it("drops the subcommand only in first position (a later 'run' is a path filter)", () => {
    expect(cliFileFilters(["run", "run"])).toEqual(["run"])
  })

  it("keeps a space-separated flag VALUE (it is indistinguishable from a filter here)", () => {
    // Deliberate: selectSharedPgStart resolves this to "unrecognized -> start", the safe direction.
    expect(cliFileFilters(["run", "--reporter", "dot"])).toEqual(["dot"])
  })
})

describe("selectSharedPgStart", () => {
  it("starts when nothing is filtered (the whole suite, CI's `vitest run`)", () => {
    const d = selectSharedPgStart([], FILES, needsPg)
    expect(d.start).toBe(true)
    expect(d.reason).toContain("whole suite")
  })

  it("does NOT start when every selected file is a non-pg test", () => {
    expect(selectSharedPgStart(["unit/cleanups-routes"], FILES, needsPg)).toEqual({
      start: false,
      reason: "none of the 1 selected test file(s) use the pg harness",
    })
  })

  it("starts when a selected file uses the harness", () => {
    const d = selectSharedPgStart(["map-pg"], FILES, needsPg)
    expect(d.start).toBe(true)
    expect(d.reason).toContain("1 selected test file(s) use the pg harness")
  })

  it("starts when a mixed selection contains one pg file", () => {
    expect(selectSharedPgStart(["unit/cleanups-routes", "map-pg"], FILES, needsPg).start).toBe(true)
  })

  it("matches an absolute path filter and a `:line` suffix the same way vitest does", () => {
    expect(selectSharedPgStart([INTEGRATION], FILES, needsPg).start).toBe(true)
    expect(selectSharedPgStart([`${INTEGRATION}:42`], FILES, needsPg).start).toBe(true)
    expect(selectSharedPgStart([`${UNIT}:7`], FILES, needsPg).start).toBe(false)
  })

  it("starts when a filter resolves to no known test file (flag value / typo)", () => {
    const d = selectSharedPgStart(["dot"], FILES, needsPg)
    expect(d.start).toBe(true)
    expect(d.reason).toContain("match no known test file")
  })

  it("starts when the only pg file in the project is selected among many unit files", () => {
    const many = [...Array(20).keys()].map((i) => `/repo/services/api/test/unit/u${i}.test.ts`)
    expect(selectSharedPgStart(["u3"], [...many, INTEGRATION], needsPg).start).toBe(false)
    expect(selectSharedPgStart(["test/"], [...many, INTEGRATION], needsPg).start).toBe(true)
  })
})

/**
 * The skip guard. The Docker-absent SKIP is a developer-machine affordance; in CI it would let a broken
 * Docker socket delete the ENTIRE integration suite from a run that still reports success. These cases
 * pin which environment gets which answer, since the failure they prevent is invisible by construction.
 */
describe("pgSkipDecision", () => {
  it("allows a skip on a plain developer machine", () => {
    expect(pgSkipDecision({}).allowed).toBe(true)
    expect(pgSkipDecision({ CI: "" }).allowed).toBe(true)
    expect(pgSkipDecision({ CI: "false" }).allowed).toBe(true)
  })

  it("FORBIDS a skip in CI (GitHub Actions sets CI=true), naming the deciding variable", () => {
    const d = pgSkipDecision({ CI: "true" })
    expect(d.allowed).toBe(false)
    expect(d.because).toBe("CI=true")
  })

  it("accepts the truthy spellings other providers use", () => {
    for (const value of ["1", "TRUE", "yes", " on "]) {
      expect(pgSkipDecision({ CI: value }).allowed).toBe(false)
    }
  })

  it("forbids a skip when CIVFIX_REQUIRE_PG is set, with no CI in play", () => {
    const d = pgSkipDecision({ CIVFIX_REQUIRE_PG: "1" })
    expect(d.allowed).toBe(false)
    expect(d.because).toContain("CIVFIX_REQUIRE_PG")
  })

  it("lets CIVFIX_ALLOW_PG_SKIP override both (a CI job that intentionally has no Docker)", () => {
    expect(pgSkipDecision({ CI: "true", CIVFIX_ALLOW_PG_SKIP: "1" }).allowed).toBe(true)
    expect(pgSkipDecision({ CIVFIX_REQUIRE_PG: "1", CIVFIX_ALLOW_PG_SKIP: "true" }).allowed).toBe(
      true,
    )
  })
})

describe("assertPgSkipAllowed", () => {
  it("throws where a skip is forbidden, quoting the underlying Docker failure", () => {
    expect(() =>
      assertPgSkipAllowed("connect ENOENT /var/run/docker.sock", { CI: "true" }),
    ).toThrow(/REQUIRED in this environment \(CI=true\)[\s\S]*docker\.sock/)
  })

  it("names the escape hatch in the message, so the failure is actionable", () => {
    expect(() => assertPgSkipAllowed("no docker", { CIVFIX_REQUIRE_PG: "1" })).toThrow(
      /CIVFIX_ALLOW_PG_SKIP=1/,
    )
  })

  it("is a no-op on a developer machine", () => {
    expect(() => assertPgSkipAllowed("no docker", {})).not.toThrow()
  })
})

describe("per-file database plumbing", () => {
  it("rewrites only the database in a connection URI", () => {
    const uri = "postgres://test:secret@127.0.0.1:54321/test"
    expect(uriWithDatabase(uri, "civfix_template")).toBe(
      "postgres://test:secret@127.0.0.1:54321/civfix_template",
    )
  })

  it("mints a fresh, quote-free identifier per call", () => {
    const a = uniqueTestDbName()
    const b = uniqueTestDbName()
    expect(a).toMatch(/^civfix_t_[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    // A database name over 63 bytes is silently TRUNCATED by Postgres, which would collapse two test
    // files onto one database.
    expect(a.length).toBeLessThanOrEqual(63)
  })
})
