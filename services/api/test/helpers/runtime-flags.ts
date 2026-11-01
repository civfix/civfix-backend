import { FakeJobs, type JobHandler } from "@civfix/seams"
import { loadEnv, type Env } from "../../src/env.js"
import {
  makeRuntimeFlagService,
  type RuntimeFlagService,
} from "../../src/services/admin/runtime-flag-service.js"
import { InMemoryRuntimeFlagRepository } from "./admin/runtime-flag-repository.memory.js"

export const OPERATOR_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"

/** Every env value a switch must read as `parseBool(raw, false)` did, with what that gives. */
export const ENV_SWITCH_VALUES: ReadonlyArray<{ raw: string | undefined; on: boolean }> = [
  { raw: undefined, on: false },
  { raw: "", on: false },
  { raw: "  ", on: false },
  { raw: "0", on: false },
  { raw: "false", on: false },
  { raw: "no", on: false },
  { raw: "off", on: false },
  { raw: "maybe", on: false },
  { raw: "1", on: true },
  { raw: "true", on: true },
  { raw: "TRUE", on: true },
  { raw: " yes ", on: true },
  { raw: "on", on: true },
]

export function envWith(name: string, raw: string | undefined): NodeJS.ProcessEnv {
  return raw === undefined ? {} : { [name]: raw }
}

export interface FlagHarness {
  env: Env
  repo: InMemoryRuntimeFlagRepository
  flags: RuntimeFlagService
  clock: { now: number }
}

/** A flag service over an in-memory store, falling back to what `source` sets, as di.ts wires it. */
export function flagHarness(source: NodeJS.ProcessEnv = {}): FlagHarness {
  const env = loadEnv({ NODE_ENV: "test", ...source })
  const repo = new InMemoryRuntimeFlagRepository()
  const clock = { now: 0 }
  const flags = makeRuntimeFlagService({
    repo,
    envFallbacks: env.runtimeFlagEnvFallbacks,
    logger: { warn: () => undefined, error: () => undefined },
    now: () => clock.now,
  })
  return { env, repo, flags, clock }
}

/** FakeJobs that keeps each registered handler for the test to run, instead of running it on enqueue. */
export class HandlerJobs extends FakeJobs {
  readonly workers = new Map<string, JobHandler>()

  override work(name: string, handler: JobHandler): Promise<void> {
    this.workers.set(name, handler)
    return Promise.resolve()
  }

  handler(name: string): JobHandler {
    const handler = this.workers.get(name)
    if (handler === undefined) throw new Error(`no worker registered for ${name}`)
    return handler
  }
}
