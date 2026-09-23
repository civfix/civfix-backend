import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const clientConfigs: Record<string, unknown>[] = []
const sendOptions: ({ abortSignal?: AbortSignal; requestTimeout?: number } | undefined)[] = []

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config)
    }
    send(
      _command: unknown,
      options?: { abortSignal?: AbortSignal; requestTimeout?: number },
    ): Promise<unknown> {
      sendOptions.push(options)
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

const { R2Storage, R2_RESPONSE_TIMEOUT_MS, R2_TRANSFER_OPERATION_TIMEOUT_MS } =
  await import("../../src/adapters/storage.r2.js")

const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const saved: Record<string, string | undefined> = {}

interface HandlerConfig {
  connectionTimeout?: number
  socketTimeout?: number
  requestTimeout?: number
  throwOnRequestTimeout?: boolean
  httpsAgent?: { proxy?: URL }
}

function storage() {
  return new R2Storage({
    accountId: "acct",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "civfix-media",
  })
}

async function resolvedHandlerConfig(): Promise<HandlerConfig | undefined> {
  const handler = clientConfigs[0]?.requestHandler as
    | { configProvider?: Promise<HandlerConfig> }
    | undefined
  return handler?.configProvider
}

beforeEach(() => {
  clientConfigs.length = 0
  sendOptions.length = 0
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

describe("R2 client timeouts", () => {
  it("bounds connect, idle socket and response wait, and makes the response deadline throw", async () => {
    await storage().head("uploads/a")

    const config = await resolvedHandlerConfig()
    expect(config?.connectionTimeout).toBeGreaterThan(0)
    expect(config?.socketTimeout).toBeGreaterThan(0)
    expect(config?.requestTimeout).toBeGreaterThan(0)
    expect(config?.throwOnRequestTimeout).toBe(true)
    expect(clientConfigs[0]!.maxAttempts).toBe(3)
  })

  it("keeps the same timeouts on the proxied handler", async () => {
    process.env.HTTPS_PROXY = "http://media-egress-proxy:8888"

    await storage().head("uploads/a")

    const config = await resolvedHandlerConfig()
    expect(String(config?.httpsAgent?.proxy)).toContain("media-egress-proxy:8888")
    expect(config?.connectionTimeout).toBeGreaterThan(0)
    expect(config?.socketTimeout).toBeGreaterThan(0)
    expect(config?.throwOnRequestTimeout).toBe(true)
  })

  it("gives every network operation an abort deadline that also covers the body read", async () => {
    const r2 = storage()
    await r2.head("uploads/a")
    await r2.delete("uploads/a")
    await r2.put("uploads/a", new Uint8Array([1]))
    await r2.list("uploads/")
    await r2.getObject("uploads/a")

    expect(sendOptions).toHaveLength(5)
    for (const options of sendOptions) {
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
      expect(options?.abortSignal?.aborted).toBe(false)
    }
  })

  it("gives object transfers the transfer budget for the upload itself, not the response wait", async () => {
    const r2 = storage()
    await r2.put("uploads/a", new Uint8Array([1]))
    await r2.getObject("uploads/a")
    await r2.head("uploads/a")

    const [putOptions, getOptions, headOptions] = sendOptions
    expect(putOptions?.requestTimeout).toBe(R2_TRANSFER_OPERATION_TIMEOUT_MS)
    expect(getOptions?.requestTimeout).toBe(R2_TRANSFER_OPERATION_TIMEOUT_MS)
    expect(headOptions?.requestTimeout).toBeUndefined()
    expect((await resolvedHandlerConfig())?.requestTimeout).toBe(R2_RESPONSE_TIMEOUT_MS)
  })
})
