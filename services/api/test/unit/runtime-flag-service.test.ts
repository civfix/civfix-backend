import { describe, expect, it } from "vitest"
import { RUNTIME_FLAGS, type RuntimeFlagKey } from "@civfix/contract"
import { loadEnv } from "../../src/env.js"
import {
  makeRuntimeFlagService,
  type RuntimeFlagLogger,
  type RuntimeFlagService,
} from "../../src/services/admin/runtime-flag-service.js"
import { InMemoryRuntimeFlagRepository } from "../helpers/admin/runtime-flag-repository.memory.js"

interface LogCall {
  level: "warn" | "error"
  obj: Record<string, unknown>
  msg: string
}

interface Harness {
  repo: InMemoryRuntimeFlagRepository
  service: RuntimeFlagService
  logs: LogCall[]
  clock: { now: number }
}

function harness(env: NodeJS.ProcessEnv = {}): Harness {
  const repo = new InMemoryRuntimeFlagRepository()
  const logs: LogCall[] = []
  const logger: RuntimeFlagLogger = {
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  }
  const clock = { now: 0 }
  const service = makeRuntimeFlagService({
    repo,
    envFallbacks: loadEnv({ NODE_ENV: "test", ...env }).runtimeFlagEnvFallbacks,
    logger,
    now: () => clock.now,
  })
  return { repo, service, logs, clock }
}

const DEFAULTS: Record<RuntimeFlagKey, unknown> = {
  host_messaging_kill_switch: false,
  outreach_digest_enabled: false,
  report_autoforward_enabled: false,
  min_app_version_ios: null,
  min_app_version_android: null,
  app_store_url_ios: null,
  announcement_text: null,
  announcement_level: "info",
}

const APP_STORE_URL = "https://apps.apple.com/us/app/civfix/id6000000000"

async function resolveAll(service: RuntimeFlagService): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const flag of RUNTIME_FLAGS) out[flag.key] = await service.get(flag.key)
  return out
}

describe("runtime flag service: resolution (D4)", () => {
  it("T21: with no rows and no env, every flag is its default", async () => {
    const { service } = harness()
    expect(await resolveAll(service)).toEqual(DEFAULTS)
  })

  it("T22: a non-empty env fallback applies, parsed as a boolean; an empty one does not", async () => {
    const { service } = harness({
      HOST_MESSAGING_KILL_SWITCH: "true",
      OUTREACH_DIGEST_ENABLED: "false",
      REPORT_AUTOFORWARD_ENABLED: "",
    })
    expect(await service.get("host_messaging_kill_switch")).toBe(true)
    expect(await service.get("outreach_digest_enabled")).toBe(false)
    expect(await service.get("report_autoforward_enabled")).toBe(false)
  })

  it("T23: an override wins over the env fallback", async () => {
    const { service, repo } = harness({ HOST_MESSAGING_KILL_SWITCH: "true" })
    repo.seed("host_messaging_kill_switch", false)
    expect(await service.get("host_messaging_kill_switch")).toBe(false)
  })

  it("T24: each typed override returns its stored value", async () => {
    const { service, repo } = harness()
    repo.seed("min_app_version_ios", "2.1.0")
    repo.seed("app_store_url_ios", APP_STORE_URL)
    repo.seed("announcement_text", "Hi")
    repo.seed("announcement_level", "warning")
    expect(await service.get("min_app_version_ios")).toBe("2.1.0")
    expect(await service.get("app_store_url_ios")).toBe(APP_STORE_URL)
    expect(await service.get("announcement_text")).toBe("Hi")
    expect(await service.get("announcement_level")).toBe("warning")
  })

  it("T25: ignores and logs a row not in the registry and a row failing its schema", async () => {
    const { service, repo, logs } = harness()
    repo.seed("old_flag", true)
    repo.seed("min_app_version_android", "2.1")
    expect(await resolveAll(service)).toEqual(DEFAULTS)
    const warns = logs.filter((l) => l.level === "warn")
    expect(warns).toHaveLength(2)
    expect(warns.some((l) => JSON.stringify(l).includes("old_flag"))).toBe(true)
    expect(warns.some((l) => JSON.stringify(l).includes("min_app_version_android"))).toBe(true)
  })
})

describe("runtime flag service: cache and failure (D4)", () => {
  it("T26: loads once per 5-second window", async () => {
    const { service, repo, clock } = harness()
    await service.get("announcement_text")
    clock.now = 4999
    await service.get("announcement_text")
    clock.now = 5000
    await service.get("announcement_text")
    expect(repo.loadAllCalls).toBe(2)
  })

  it("T27: concurrent cold reads share one load", async () => {
    const { service, repo } = harness()
    const reads = await Promise.all([
      service.get("host_messaging_kill_switch"),
      service.get("announcement_text"),
      service.get("announcement_level"),
      service.get("min_app_version_ios"),
      service.get("outreach_digest_enabled"),
    ])
    expect(reads).toEqual([false, null, "info", null, false])
    expect(repo.loadAllCalls).toBe(1)
  })

  it("T28: a failed refresh keeps the last good snapshot and logs the error", async () => {
    const { service, repo, logs, clock } = harness()
    repo.seed("announcement_text", "Hi")
    expect(await service.get("announcement_text")).toBe("Hi")
    clock.now = 6000
    repo.loadAllError = new Error("connection refused")
    expect(await service.get("announcement_text")).toBe("Hi")
    expect(logs.filter((l) => l.level === "error")).toHaveLength(1)
  })

  it("T29: with no snapshot the kill switch reads as on and the rest use their fallback", async () => {
    const { service, repo, logs } = harness({
      HOST_MESSAGING_KILL_SWITCH: "false",
      OUTREACH_DIGEST_ENABLED: "true",
    })
    repo.loadAllError = new Error("connection refused")
    expect(await service.get("host_messaging_kill_switch")).toBe(true)
    expect(await service.get("outreach_digest_enabled")).toBe(true)
    expect(await service.get("min_app_version_ios")).toBe(null)
    expect(await service.get("announcement_level")).toBe("info")
    expect(logs.some((l) => l.level === "error")).toBe(true)
  })
})
