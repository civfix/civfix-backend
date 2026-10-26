import { describe, it, expect } from "vitest"
import type { FastifyRequest } from "fastify"
import { bearerToken } from "../../src/auth/transport.js"

function requestWith(authorization: string | string[] | undefined): FastifyRequest {
  return { headers: { authorization } } as FastifyRequest
}

describe("bearerToken", () => {
  it.each([
    ["Bearer abc.def-ghi", "abc.def-ghi"],
    ["bearer abc", "abc"],
    ["BEARER\tabc", "abc"],
    ["  Bearer   abc  ", "abc"],
    ["Bearer\u00a0abc", "abc"],
    ["Bearer \nabc", "abc"],
    ["Bearer a b", "a b"],
  ])("reads %j as %j", (header, expected) => {
    expect(bearerToken(requestWith(header))).toBe(expected)
  })

  it.each([
    [undefined],
    [""],
    ["Bearer"],
    ["Bearer   "],
    ["Bearerabc"],
    ["Basic abc"],
    ["xBearer abc"],
    ["Bear er abc"],
    ["Bearer abc\ndef"],
    ["Bearer abc\rdef"],
    ["Bearer abc\u2028def"],
    ["Bearer abc\u2029def"],
  ])("rejects %j", (header) => {
    expect(bearerToken(requestWith(header))).toBeNull()
  })

  it("reads only the first of a repeated header", () => {
    expect(bearerToken(requestWith(["Bearer first", "Bearer second"]))).toBe("first")
  })

  it("rejects a long run of whitespace before a line break quickly", () => {
    const header = `Bearer ${" ".repeat(200_000)}x\ny`
    const started = performance.now()
    expect(bearerToken(requestWith(header))).toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
