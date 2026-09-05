
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Storage } from "@civfix/shared/interfaces"
import { makeDownloader, DownloadTooLargeError, StorageUnavailableError } from "../../src/download.js"

type Route = (res: ServerResponse) => void

const routes = new Map<string, Route>()

let server: Server
let origin = ""

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("error", () => {})
    res.on("error", () => {})
    const route = routes.get(new URL(req.url ?? "/", "http://localhost").pathname)
    if (!route) {
      res.statusCode = 404
      res.end()
      return
    }
    try {
      route(res)
    } catch (ignored) {
      void ignored
    }
  })
  server.on("clientError", () => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address() as AddressInfo
  origin = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function stubStorage(presignGet: (key: string, ttlSec: number) => Promise<string>): Storage {
  return { presignGet } as unknown as Storage
}

function servedAt(path: string): Storage {
  return stubStorage((_key, _ttl) => Promise.resolve(`${origin}${path}`))
}

describe("download: key allowlist", () => {
  const cases = [
    { name: "absolute path", key: "/uploads/a" },
    { name: "parent traversal", key: "uploads/../../etc/passwd" },
    { name: "backslash", key: "uploads\\a" },
    { name: "empty", key: "" },
    { name: "disallowed character", key: "uploads/a?b" },
    { name: "over 512 chars", key: `uploads/${"a".repeat(600)}` },
  ]

  it("rejects an unsafe r2 key WITHOUT presigning it", async () => {
    for (const c of cases) {
      let presigned = false
      const download = makeDownloader(
        stubStorage(() => {
          presigned = true
          return Promise.resolve(`${origin}/ok`)
        }),
      )
      await expect(download(c.key, 1024), c.name).rejects.toBeInstanceOf(StorageUnavailableError)
      expect(presigned, c.name).toBe(false)
    }
  })
})

describe("download: presign failures", () => {
  it("maps a presign throw to StorageUnavailableError (retryable infra)", async () => {
    const download = makeDownloader(
      stubStorage(() => Promise.reject(new Error("R2 presignGet failed"))),
    )
    await expect(download("uploads/2026/06/a", 1024)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
  })

  it("maps an unreachable URL to StorageUnavailableError", async () => {
    const download = makeDownloader(stubStorage(() => Promise.resolve("http://127.0.0.1:1/nope")))
    await expect(download("uploads/2026/06/a", 1024)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
  })
})

describe("download: responses", () => {
  it("returns the object bytes on 200", async () => {
    const body = Buffer.from("hello-bytes")
    routes.set("/ok", (res) => {
      res.statusCode = 200
      res.end(body)
    })
    const download = makeDownloader(servedAt("/ok"))
    const out = await download("uploads/2026/06/ok", 1024)
    expect(Buffer.from(out.bytes).toString()).toBe("hello-bytes")
  })

  it("maps a 503 to StorageUnavailableError naming the status", async () => {
    routes.set("/unavailable", (res) => {
      res.statusCode = 503
      res.end("slow down")
    })
    const download = makeDownloader(servedAt("/unavailable"))
    await expect(download("uploads/2026/06/x", 1024)).rejects.toThrow(/HTTP 503/)
  })

  it("rejects on the declared content-length BEFORE reading the body", async () => {
    routes.set("/declared-big", (res) => {
      res.statusCode = 200
      res.end(Buffer.alloc(4096, 1))
    })
    const download = makeDownloader(servedAt("/declared-big"))
    await expect(download("uploads/2026/06/big", 64)).rejects.toBeInstanceOf(DownloadTooLargeError)
  })

  it("SECURITY: aborts mid-stream when a chunked body grows past the cap", async () => {
    routes.set("/chunked-big", (res) => {
      res.statusCode = 200
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(4096, 2))
      res.end()
    })
    const download = makeDownloader(servedAt("/chunked-big"))
    await expect(download("uploads/2026/06/stream", 1024)).rejects.toBeInstanceOf(
      DownloadTooLargeError,
    )
  })

  it("accepts a body of EXACTLY maxBytes (the cap is inclusive)", async () => {
    routes.set("/exact", (res) => {
      res.statusCode = 200
      res.end(Buffer.alloc(64, 7))
    })
    const download = makeDownloader(servedAt("/exact"))
    const out = await download("uploads/2026/06/exact", 64)
    expect(out.bytes.byteLength).toBe(64)
  })

  it("falls back to arrayBuffer() when the response carries NO body stream (204)", async () => {
    routes.set("/empty", (res) => {
      res.statusCode = 204
      res.end()
    })
    const download = makeDownloader(servedAt("/empty"))
    const out = await download("uploads/2026/06/empty", 1024)
    expect(out.bytes.byteLength).toBe(0)
  })

  it("streams a body that stays under the cap", async () => {
    routes.set("/chunked-small", (res) => {
      res.statusCode = 200
      res.write(Buffer.alloc(16, 3))
      res.write(Buffer.alloc(16, 4))
      res.end()
    })
    const download = makeDownloader(servedAt("/chunked-small"))
    const out = await download("uploads/2026/06/small", 1024)
    expect(out.bytes.byteLength).toBe(32)
  })
})

describe("download: abort propagation", () => {
  it("an ALREADY-aborted caller signal cancels the request (job timeout path)", async () => {
    routes.set("/slow", (res) => {
      res.statusCode = 200
      setTimeout(() => res.end(Buffer.from("late")), 5_000).unref?.()
    })
    const download = makeDownloader(servedAt("/slow"))
    const ac = new AbortController()
    ac.abort()
    await expect(download("uploads/2026/06/slow", 1024, ac.signal)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
  })

  it("aborting DURING the request rejects instead of hanging", async () => {
    routes.set("/slow2", (res) => {
      res.statusCode = 200
      res.write(Buffer.alloc(8, 5))
      setTimeout(() => res.end(Buffer.from("late")), 5_000).unref?.()
    })
    const download = makeDownloader(servedAt("/slow2"))
    const ac = new AbortController()
    const pending = download("uploads/2026/06/slow2", 1024, ac.signal)
    setTimeout(() => ac.abort(), 50).unref?.()
    await expect(pending).rejects.toBeInstanceOf(StorageUnavailableError)
  })
})
