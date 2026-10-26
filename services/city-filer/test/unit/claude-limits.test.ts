import { afterEach, describe, expect, it } from "vitest"
import { claudeOutcome } from "../../src/claude-limits.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"

let h: FilerHarness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

const json = (isError: boolean, result: string) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: isError, result })

describe("Claude usage limits and auth", () => {
  it('T10: is_error with "usage limit reached", then "authentication failed", are failed / ai_unavailable; "unexpected tool error" is failed / portal_error', async () => {
    h = await filerHarness()
    const texts = ["Claude usage limit reached", "authentication failed", "unexpected tool error"]
    await h.claude(
      `return { type: "result", subtype: "success", is_error: true, result: ${JSON.stringify(texts)}[n] }`,
    )

    for (let i = 0; i < texts.length; i++) await h.run(h.filings.add().id, 1)
    expect(h.endings()).toEqual([
      "failed/ai_unavailable",
      "failed/ai_unavailable",
      "failed/portal_error",
    ])
  })

  it("maps sample CLI exits: limits, credit and login problems are unavailable, the rest a portal error", () => {
    const reason = (over: Partial<Parameters<typeof claudeOutcome>[0]>) => {
      const outcome = claudeOutcome({
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        stdout: "",
        ...over,
      })
      return outcome.kind === "ok" ? `ok ${outcome.result}` : outcome.reason
    }
    expect([
      reason({ stdout: `noise\n${json(false, "the reading")}` }),
      reason({ exitCode: 1, stdout: json(true, "API Error: 429 rate_limit_error") }),
      reason({ stdout: json(true, "Credit balance is too low") }),
      reason({ exitCode: 1, stderrTail: "Invalid API key · Please run /login" }),
      reason({ stdout: json(true, "Execution error") }),
      reason({ exitCode: 1, stdout: json(false, "done") }),
      reason({ exitCode: null, timedOut: true, stdout: json(true, "usage limit") }),
    ]).toEqual([
      "ok the reading",
      ...["ai_unavailable", "ai_unavailable", "ai_unavailable"],
      ...["portal_error", "portal_error", "portal_error"],
    ])
  })
})
