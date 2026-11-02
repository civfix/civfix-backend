import { describe, expect, it } from "vitest"

import {
  expectConsoleError,
  expectConsoleWarn,
  startConsoleGuard,
  stopConsoleGuard,
} from "../src/console.js"

// Each case ends the guard the setup file started, asserts on the verdict, then re-arms it for the
// setup file's own afterEach.
function settle(): void {
  try {
    stopConsoleGuard()
  } finally {
    startConsoleGuard()
  }
}

describe("console guard", () => {
  it("fails a test on an unexpected console.error or console.warn", () => {
    console.error("stray error", { id: 7 })
    console.warn("stray warning")
    expect(settle).toThrow(
      /console\.error: stray error \{ id: 7 \}[\s\S]*console\.warn: stray warning/,
    )
  })

  it("swallows a call matching an expected substring or pattern", () => {
    expectConsoleError("chunk 812")
    expectConsoleWarn(/deprecated/i)
    console.error(new Error("Loading chunk 812 failed."))
    console.error("Loading chunk 812 failed again.")
    console.warn("Deprecated prop")
    expect(settle).not.toThrow()
  })

  it("fails when an expected call never happens", () => {
    expectConsoleError("never logged")
    expect(settle).toThrow(/expected a console\.error matching never logged, but none was logged/)
  })

  it("does not let an expected error excuse a warning", () => {
    expectConsoleError("boom")
    console.warn("boom")
    expect(settle).toThrow(/console\.warn: boom[\s\S]*expected a console\.error matching boom/)
  })
})
