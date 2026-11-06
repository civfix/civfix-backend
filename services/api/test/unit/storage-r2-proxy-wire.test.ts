import dns from "node:dns"
import { createServer, type Server, type Socket } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { R2Storage } from "../../src/adapters/storage.r2.js"

// The worker and the filer reach R2 only through the egress proxy, so these drive the real S3 client and
// https-proxy-agent against a fake proxy on the wire (storage-r2-proxy.test.ts checks the wiring with a
// mocked SDK).

const ACCOUNT_ID = "acct-test"
const R2_HOST = `${ACCOUNT_ID}.r2.cloudflarestorage.com`
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]

const connectLines: string[] = []
const sockets = new Set<Socket>()
let proxy: Server
let proxyPort: number

function storage(): R2Storage {
  return new R2Storage({
    accountId: ACCOUNT_ID,
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "civfix-media",
  })
}

beforeAll(async () => {
  proxy = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let head = ""
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1")
      if (!head.includes("\r\n\r\n")) return
      connectLines.push(head.slice(0, head.indexOf("\r\n")))
      head = ""
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const address = proxy.address()
  proxyPort = typeof address === "object" && address !== null ? address.port : 0
})

beforeEach(() => {
  connectLines.length = 0
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined)
  vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxyPort}`)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
})

describe("R2 egress on the wire", () => {
  it("T22: tunnels every attempt to the account's R2 host through the proxy", async () => {
    await expect(storage().head("k")).rejects.toThrow()

    expect(connectLines.length).toBeGreaterThanOrEqual(1)
    for (const line of connectLines) {
      expect(line).toBe(`CONNECT ${R2_HOST}:443 HTTP/1.1`)
    }
  })

  it("T23: a host listed in NO_PROXY never reaches the proxy", async () => {
    vi.stubEnv("NO_PROXY", R2_HOST)
    // The direct path would resolve the real R2 host; point it at a closed local port instead so the test
    // never leaves the machine.
    const lookup = dns.lookup
    let resolvedDirect = false
    vi.spyOn(dns, "lookup").mockImplementation(((
      hostname: string,
      options: unknown,
      callback: (...args: unknown[]) => void,
    ) => {
      if (hostname !== R2_HOST) {
        return (lookup as (...args: unknown[]) => void)(hostname, options, callback)
      }
      resolvedDirect = true
      const all = typeof options === "object" && (options as { all?: boolean }).all === true
      if (all) callback(null, [{ address: "127.0.0.1", family: 4 }])
      else callback(null, "127.0.0.1", 4)
    }) as typeof dns.lookup)

    await expect(storage().head("k")).rejects.toThrow()

    expect(resolvedDirect).toBe(true)
    expect(connectLines).toEqual([])
  })
})
