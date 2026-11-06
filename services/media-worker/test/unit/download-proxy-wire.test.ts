import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createNetServer, connect, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { Storage } from "@civfix/seams"
import { makeDownloader, StorageUnavailableError } from "../../src/download.js"

// The worker's egress is only allowed through the proxy, so these drive the real undici client against a
// fake proxy on the wire. The downloader caches its dispatcher, which reads the proxy env once, so the
// whole file shares one proxy whose behaviour each test picks.

type ProxyMode = { kind: "refuse" } | { kind: "tunnel"; port: number }

const connectLines: string[] = []
let mode: ProxyMode = { kind: "refuse" }
let proxy: Server
let proxyPort: number
// Both ends of every tunnel, so a test can close its servers without waiting on a piped socket.
const proxySockets = new Set<Socket>()

function track(socket: Socket): void {
  proxySockets.add(socket)
  socket.on("close", () => proxySockets.delete(socket))
  socket.on("error", () => {})
}

function listen(server: Server | TlsServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address !== null ? address.port : 0)
    })
  })
}

function close(server: Server | TlsServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function handleProxyClient(socket: Socket): void {
  track(socket)
  let head = ""
  const onData = (chunk: Buffer): void => {
    head += chunk.toString("latin1")
    const end = head.indexOf("\r\n\r\n")
    if (end === -1) return
    socket.off("data", onData)
    connectLines.push(head.slice(0, head.indexOf("\r\n")))
    if (mode.kind === "refuse") {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      return
    }
    const upstream = connect(mode.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      const rest = Buffer.from(head.slice(end + 4), "latin1")
      if (rest.length > 0) upstream.write(rest)
      socket.pipe(upstream).pipe(socket)
    })
    track(upstream)
    upstream.on("close", () => socket.destroy())
  }
  socket.on("data", onData)
}

function storageAt(url: string): Storage {
  return {
    presignPut: () => Promise.resolve({ url: "https://r2.example/put", headers: {} }),
    presignGet: () => Promise.resolve(url),
    head: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    put: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [] }),
    getObject: () => Promise.resolve(null),
  }
}

beforeAll(async () => {
  proxy = createNetServer(handleProxyClient)
  proxyPort = await listen(proxy)
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    vi.stubEnv(key, undefined)
  }
  vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxyPort}`)
})

afterEach(() => {
  connectLines.length = 0
  mode = { kind: "refuse" }
})

afterAll(async () => {
  vi.unstubAllEnvs()
  for (const socket of proxySockets) socket.destroy()
  await close(proxy)
})

describe("worker download through the egress proxy", () => {
  it("T20: tunnels the presigned host through the proxy with one CONNECT", async () => {
    const download = makeDownloader(storageAt("https://r2-test.invalid/bucket/key"))

    await expect(download("uploads/2026/11/a", 1024)).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
    expect(connectLines).toEqual(["CONNECT r2-test.invalid:443 HTTP/1.1"])
  })

  it("T21: offers only HTTP/1.1 to the origin through the tunnel", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "download-proxy-tls-"))
    const offers: string[][] = []
    let tls: TlsServer | undefined
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          join(certDir, "key.pem"),
          "-out",
          join(certDir, "cert.pem"),
          "-subj",
          "/CN=localhost",
          "-days",
          "1",
        ],
        { stdio: "ignore" },
      )
      tls = createTlsServer({
        key: readFileSync(join(certDir, "key.pem")),
        cert: readFileSync(join(certDir, "cert.pem")),
        ALPNCallback: ({ protocols }) => {
          offers.push([...protocols])
          return protocols.includes("http/1.1") ? "http/1.1" : undefined
        },
      })
      tls.on("tlsClientError", () => {})
      const tlsPort = await listen(tls)
      mode = { kind: "tunnel", port: tlsPort }
      const download = makeDownloader(storageAt(`https://localhost:${tlsPort}/bucket/key`))

      await expect(download("uploads/2026/11/a", 1024)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      )
      expect(connectLines).toEqual([`CONNECT localhost:${tlsPort} HTTP/1.1`])
      expect(offers).toEqual([["http/1.1"]])
    } finally {
      for (const socket of proxySockets) socket.destroy()
      if (tls !== undefined) await close(tls)
      rmSync(certDir, { recursive: true, force: true })
    }
  })
})
