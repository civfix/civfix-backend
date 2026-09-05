
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const clientConfigs: Record<string, unknown>[] = []

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config)
    }
    send(): Promise<unknown> {
      return Promise.resolve({})
    }
  }
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client,
    GetObjectCommand: Command,
    PutObjectCommand: Command,
    HeadObjectCommand: Command,
    DeleteObjectCommand: Command,
    ListObjectsV2Command: Command,
  }
})

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: () => Promise.resolve("https://signed.example/object"),
}))

const { R2Storage } = await import("../../src/adapters/storage.r2.js")
const { readProxySettings, shouldProxyHost } = await import("../../src/adapters/proxy-egress.js")

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const saved: Record<string, string | undefined> = {}

function storage() {
  return new R2Storage({
    accountId: "acct",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "civfix-media",
  })
}

beforeEach(() => {
  clientConfigs.length = 0
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("R2 client egress", () => {
  it("builds no requestHandler when HTTPS_PROXY is unset (the API container)", async () => {
    await storage().presignGet("uploads/a", 60, { forceSigned: true })

    expect(clientConfigs).toHaveLength(1)
    expect(clientConfigs[0]!.requestHandler).toBeUndefined()
  })

  it("builds a proxy-bearing requestHandler when HTTPS_PROXY is set (the worker)", async () => {
    process.env.HTTPS_PROXY = "http://media-egress-proxy:8888"

    await storage().presignGet("uploads/a", 60, { forceSigned: true })

    expect(clientConfigs).toHaveLength(1)
    const handler = clientConfigs[0]!.requestHandler as {
      configProvider?: Promise<{ httpsAgent?: { proxy?: URL } }>
    }
    expect(handler).toBeDefined()
    const resolved = await handler.configProvider
    expect(resolved?.httpsAgent).toBeDefined()
    expect(String(resolved?.httpsAgent?.proxy)).toContain("media-egress-proxy:8888")
  })

  it("stays direct for a host listed in NO_PROXY", async () => {
    process.env.HTTPS_PROXY = "http://media-egress-proxy:8888"
    process.env.NO_PROXY = "postgres,redis,localhost,.r2.cloudflarestorage.com"

    await storage().presignGet("uploads/a", 60, { forceSigned: true })

    expect(clientConfigs[0]!.requestHandler).toBeUndefined()
  })
})

describe("proxy settings parsing", () => {
  it("reports no proxy when the variable is absent or blank", () => {
    expect(readProxySettings({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readProxySettings({ HTTPS_PROXY: "   " } as NodeJS.ProcessEnv)).toBeNull()
  })

  it("honors exact, suffix, wildcard and host:port NO_PROXY entries", () => {
    const settings = readProxySettings({
      HTTPS_PROXY: "http://p:8888",
      NO_PROXY: "postgres, .internal, redis:6379",
    } as NodeJS.ProcessEnv)!
    expect(shouldProxyHost("postgres", settings)).toBe(false)
    expect(shouldProxyHost("db.internal", settings)).toBe(false)
    expect(shouldProxyHost("redis", settings)).toBe(false)
    expect(shouldProxyHost("acct.r2.cloudflarestorage.com", settings)).toBe(true)

    const all = readProxySettings({
      HTTPS_PROXY: "http://p:8888",
      NO_PROXY: "*",
    } as NodeJS.ProcessEnv)!
    expect(shouldProxyHost("anything", all)).toBe(false)
  })
})
