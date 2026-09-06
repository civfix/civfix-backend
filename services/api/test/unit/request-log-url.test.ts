import { describe, expect, it } from "vitest"
import { loggedRequestUrl } from "../../src/server.js"

describe("request log url", () => {
  it("drops the query string, so an access code on a GET never reaches the log", () => {
    expect(loggedRequestUrl("/v1/cleanups/abc/ticket-types?accessCode=SUMMER2026")).toBe(
      "/v1/cleanups/abc/ticket-types",
    )
    expect(loggedRequestUrl("/v1/cleanups/abc/ticket-types?limit=5&accessCode=SECRET")).toBe(
      "/v1/cleanups/abc/ticket-types",
    )
  })

  it("leaves a url with no query string untouched", () => {
    expect(loggedRequestUrl("/v1/cleanups/abc")).toBe("/v1/cleanups/abc")
    expect(loggedRequestUrl("")).toBe("")
  })
})
