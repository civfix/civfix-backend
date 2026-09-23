import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Storage } from "@civfix/shared/interfaces"
import { makeDownloader } from "../../src/download.js"
import { loadHttpsProxy } from "../../src/config.js"

const undiciFetch = vi.fn()
const EnvHttpProxyAgent = vi.fn()

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => undiciFetch(...args),
  EnvHttpProxyAgent: class {
    constructor() {
      EnvHttpProxyAgent()
    }
  },
}))

function fakeStorage(): Storage {
  return {
    presignPut: () => Promise.resolve({ url: "https://r2.example/put", headers: {} }),
    presignGet: () => Promise.resolve("https://account.r2.cloudflarestorage.com/bucket/key"),
    head: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    put: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [] }),
    getObject: () => Promise.resolve(null),
  } as unknown as Storage
}

function okResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-length": "3", etag: '"abc"' },
  })
}

const ORIGINAL_PROXY = process.env.HTTPS_PROXY
let globalFetch: typeof fetch

beforeEach(() => {
  undiciFetch.mockReset()
  EnvHttpProxyAgent.mockReset()
  globalFetch = vi.fn(() => Promise.resolve(okResponse())) as unknown as typeof fetch
  vi.stubGlobal("fetch", globalFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_PROXY === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = ORIGINAL_PROXY
})

describe("worker egress proxy", () => {
  it("uses the plain global fetch when HTTPS_PROXY is unset", async () => {
    delete process.env.HTTPS_PROXY
    expect(loadHttpsProxy()).toBeNull()

    const out = await makeDownloader(fakeStorage())("uploads/2026/09/a", 1024)

    expect(out.bytes.byteLength).toBe(3)
    expect(out.etag).toBe("abc")
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(undiciFetch).not.toHaveBeenCalled()
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled()
  })

  it("routes through an undici proxy dispatcher when HTTPS_PROXY is set", async () => {
    process.env.HTTPS_PROXY = "http://media-egress-proxy:8888"
    undiciFetch.mockResolvedValue(okResponse())

    const out = await makeDownloader(fakeStorage())("uploads/2026/09/a", 1024)

    expect(out.bytes.byteLength).toBe(3)
    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciFetch).toHaveBeenCalledTimes(1)
    expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(1)
    const [, init] = undiciFetch.mock.calls[0] as [string, { dispatcher?: unknown }]
    expect(init.dispatcher).toBeDefined()
  })
})
