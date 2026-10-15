import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchJsonWithTimeout,
  fetchJsonOrNull,
  JsonBodyTooLargeError,
} from "../../src/adapters/http-fetch.js"

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function streamResponse(
  text: string,
  opts: { status?: number; contentLength?: string | null; chunks?: number } = {},
): { res: Response; cancelled: () => boolean } {
  const status = opts.status ?? 200
  const bytes = new TextEncoder().encode(text)
  const n = opts.chunks ?? 1
  const size = Math.ceil(bytes.byteLength / n)
  let i = 0
  let cancelled = false
  const body = {
    getReader: () => ({
      read: async () => {
        if (i >= bytes.byteLength) return { done: true, value: undefined }
        const value = bytes.subarray(i, i + size)
        i += size
        return { done: false, value }
      },
      releaseLock: () => {},
      cancel: async () => {
        cancelled = true
      },
    }),
    cancel: async () => {
      cancelled = true
    },
  }
  const headers = {
    get: (k: string) =>
      k.toLowerCase() === "content-length"
        ? opts.contentLength === undefined
          ? String(bytes.byteLength)
          : opts.contentLength
        : null,
  }
  const res = { ok: status >= 200 && status < 300, status, headers, body } as unknown as Response
  return { res, cancelled: () => cancelled }
}

describe("fetchJsonWithTimeout", () => {
  it("returns the parsed body on 2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: "world" })) as unknown as typeof fetch
    const result = await fetchJsonWithTimeout<{ hello: string }>("https://x/y", {
      timeoutMs: 50,
      fetchImpl,
    })
    expect(result).toEqual({ ok: true, status: 200, json: { hello: "world" } })
  })

  it("defaults to redirect:'error' and passes an AbortSignal, while honoring caller init", async () => {
    let init: RequestInit | undefined
    const fetchImpl = vi.fn(async (_u: string, i: RequestInit) => {
      init = i
      return jsonResponse({})
    }) as unknown as typeof fetch

    await fetchJsonWithTimeout("https://x/y", {
      timeoutMs: 50,
      fetchImpl,
      init: { method: "POST", headers: { accept: "application/json" }, body: "b" },
    })

    expect(init?.redirect).toBe("error")
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe("b")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("classifies a non-2xx as kind 'http' WITHOUT reading the body", async () => {
    const json = vi.fn(async () => ({ nope: true }))
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 503, json }) as unknown as Response,
    ) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl })
    expect(result).toEqual({ ok: false, kind: "http", status: 503 })
    expect(json).not.toHaveBeenCalled()
  })

  it("CANCELS the non-2xx body so undici releases the socket instead of holding it until GC", async () => {
    const cancel = vi.fn(async () => {})
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 429,
          body: { cancel },
          json: async () => ({}),
        }) as unknown as Response,
    ) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl })
    expect(result).toEqual({ ok: false, kind: "http", status: 429 })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("survives a body that cannot be cancelled, and a response with no body at all", async () => {
    const throwing = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          body: {
            cancel: async () => {
              throw new TypeError("already locked")
            },
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(
      fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl: throwing }),
    ).resolves.toEqual({ ok: false, kind: "http", status: 500 })

    const noBody = vi.fn(
      async () => ({ ok: false, status: 404 }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(
      fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl: noBody }),
    ).resolves.toEqual({ ok: false, kind: "http", status: 404 })
  })

  it("classifies a rejected fetch as kind 'transport' and preserves the error", async () => {
    const boom = new Error("ECONNREFUSED")
    const fetchImpl = vi.fn(async () => {
      throw boom
    }) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl })
    expect(result).toEqual({ ok: false, kind: "transport", error: boom })
  })

  it("classifies a 2xx with an unparseable body as kind 'body'", async () => {
    const bad = new SyntaxError("Unexpected token <")
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw bad
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl })
    expect(result).toEqual({ ok: false, kind: "body", status: 200, error: bad })
  })

  it("normalizes a missing status (bare test doubles) to 0 rather than lying about the type", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch
    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 50, fetchImpl })
    expect(result).toEqual({ ok: true, status: 0, json: {} })
  })

  it("aborts on the deadline and reports transport failure", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        )
      })) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 1, fetchImpl })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe("transport")
  })

  it("the deadline also covers the BODY read, not just the response headers", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")))
          }),
      } as unknown as Response)) as unknown as typeof fetch

    const result = await fetchJsonWithTimeout("https://x/y", { timeoutMs: 5, fetchImpl })
    expect(result.ok === false && result.kind).toBe("body")
  })

  it("reads and parses a streamed 2xx body (real ReadableStream path), including multi-chunk", async () => {
    const single = streamResponse(JSON.stringify({ a: 1 }))
    const r1 = await fetchJsonWithTimeout<{ a: number }>("https://x/y", {
      timeoutMs: 50,
      fetchImpl: async () => single.res,
    })
    expect(r1).toEqual({ ok: true, status: 200, json: { a: 1 } })

    const multi = streamResponse(JSON.stringify({ hello: "world", n: 42 }), { chunks: 5 })
    const r2 = await fetchJsonWithTimeout<{ hello: string; n: number }>("https://x/y", {
      timeoutMs: 50,
      fetchImpl: async () => multi.res,
    })
    expect(r2.ok && r2.json).toEqual({ hello: "world", n: 42 })
  })

  it("rejects a body whose declared content-length exceeds maxBytes, and cancels it", async () => {
    const big = streamResponse(JSON.stringify({ a: 1 }), { contentLength: "5000000" })
    const result = await fetchJsonWithTimeout("https://x/y", {
      timeoutMs: 50,
      maxBytes: 100,
      fetchImpl: async () => big.res,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe("body")
    expect(result.ok === false && result.kind === "body" && result.error).toBeInstanceOf(
      JsonBodyTooLargeError,
    )
    expect(big.cancelled()).toBe(true)
  })

  it("aborts a streamed body that exceeds maxBytes even when content-length under-reports", async () => {
    const body = "x".repeat(5000)
    const lying = streamResponse(body, { contentLength: "0", chunks: 10 })
    const result = await fetchJsonWithTimeout("https://x/y", {
      timeoutMs: 50,
      maxBytes: 500,
      fetchImpl: async () => lying.res,
    })
    expect(result.ok === false && result.kind).toBe("body")
    expect(result.ok === false && result.kind === "body" && result.error).toBeInstanceOf(
      JsonBodyTooLargeError,
    )
  })

  it("still parses a bare {ok,json} double (no body) via the res.json() fallback under the cap", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: 1 })) as unknown as typeof fetch
    const result = await fetchJsonWithTimeout("https://x/y", {
      timeoutMs: 50,
      maxBytes: 10,
      fetchImpl,
    })
    expect(result).toEqual({ ok: true, status: 200, json: { ok: 1 } })
  })

  it("resolves globalThis.fetch at CALL time when no fetchImpl is injected", async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = vi.fn(async () => jsonResponse({ via: "global" }))
      const result = await fetchJsonWithTimeout<{ via: string }>("https://x/y", { timeoutMs: 50 })
      expect(result.ok && result.json).toEqual({ via: "global" })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("fetchJsonOrNull (fail-open wrapper)", () => {
  it("returns the body on 2xx and null for every failure kind", async () => {
    const ok = vi.fn(async () => jsonResponse({ a: 1 })) as unknown as typeof fetch
    await expect(fetchJsonOrNull("https://x", { timeoutMs: 50, fetchImpl: ok })).resolves.toEqual({
      a: 1,
    })

    const http = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(
      fetchJsonOrNull("https://x", { timeoutMs: 50, fetchImpl: http }),
    ).resolves.toBeNull()

    const transport = vi.fn(async () => {
      throw new Error("net")
    }) as unknown as typeof fetch
    await expect(
      fetchJsonOrNull("https://x", { timeoutMs: 50, fetchImpl: transport }),
    ).resolves.toBeNull()

    const badBody = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("nope")
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(
      fetchJsonOrNull("https://x", { timeoutMs: 50, fetchImpl: badBody }),
    ).resolves.toBeNull()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
