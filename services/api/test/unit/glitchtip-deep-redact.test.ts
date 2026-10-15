import { describe, expect, it } from "vitest"
import { scrubBreadcrumb, scrubEvent } from "../../src/errors/glitchtip.js"

function nest(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = leaf
  for (let i = 0; i < depth; i += 1) value = { level: value }
  return value
}

describe("GlitchTip scrubbing of deeply nested data", () => {
  it("never ships a sensitive key nested past the redaction depth", () => {
    const out = scrubEvent({ extra: nest(12, { email: "user@example.com", token: "sess_abc" }) })

    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain("user@example.com")
    expect(serialized).not.toContain("sess_abc")
  })

  it("applies the same cap to breadcrumb data", () => {
    const out = scrubBreadcrumb({ data: nest(12, { password: "hunter2" }) })

    expect(JSON.stringify(out)).not.toContain("hunter2")
  })

  it("keeps shallow diagnostic values intact", () => {
    const out = scrubEvent({ extra: nest(3, { requestId: "req-1" }) })

    expect(JSON.stringify(out)).toContain("req-1")
  })
})
