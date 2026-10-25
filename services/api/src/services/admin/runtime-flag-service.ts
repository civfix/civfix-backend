import {
  AppError,
  RUNTIME_FLAGS,
  runtimeFlagValueSchema,
  type RuntimeFlagDef,
  type RuntimeFlagKey,
  type RuntimeFlagStateDTO,
  type RuntimeFlagValue,
} from "@civfix/contract"
import type { RuntimeFlagEnvFallbacks } from "../../env/dev-console-env.js"
import type { RuntimeFlagRecord, RuntimeFlagRepository } from "./runtime-flag-repository.js"

type FlagOf<K extends RuntimeFlagKey> = Extract<(typeof RUNTIME_FLAGS)[number], { key: K }>

/** What `get` returns for a key: a choice flag narrows to its choices' values. */
export type RuntimeFlagValueOf<K extends RuntimeFlagKey> =
  FlagOf<K> extends { type: "choice"; choices: readonly { value: infer V }[] }
    ? V
    : FlagOf<K> extends { type: "boolean" }
      ? boolean
      : string | null

export interface RuntimeFlagLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export interface RuntimeFlagServiceDeps {
  repo: RuntimeFlagRepository
  envFallbacks: RuntimeFlagEnvFallbacks
  logger: RuntimeFlagLogger
  now?: () => number
}

export interface RuntimeFlagService {
  /** The effective value, from a snapshot at most 5 seconds old in this process. */
  get<K extends RuntimeFlagKey>(key: K): Promise<RuntimeFlagValueOf<K>>
  /** Every flag in registry order, read fresh from the store. */
  list(): Promise<RuntimeFlagStateDTO[]>
  /** `value: null` clears the override; any other value must pass the flag's schema. */
  set(key: RuntimeFlagKey, value: RuntimeFlagValue, actorId: string): Promise<RuntimeFlagStateDTO>
}

const RUNTIME_FLAG_CACHE_MS = 5_000

const FLAGS = RUNTIME_FLAGS as readonly RuntimeFlagDef[]
const FLAG_BY_KEY: ReadonlyMap<string, RuntimeFlagDef> = new Map(FLAGS.map((f) => [f.key, f]))
const KILL_SWITCH: RuntimeFlagKey = "host_messaging_kill_switch"

export function isRuntimeFlagKey(key: string): key is RuntimeFlagKey {
  return FLAG_BY_KEY.has(key)
}

interface Override {
  value: boolean | string
  updatedAt: Date
  updatedBy: RuntimeFlagStateDTO["updatedBy"]
}

type Snapshot = ReadonlyMap<string, Override>

export function makeRuntimeFlagService(deps: RuntimeFlagServiceDeps): RuntimeFlagService {
  const now = deps.now ?? Date.now
  let snapshot: Snapshot | null = null
  let attemptedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | null = null
  let started = 0
  let applied = 0
  const warned = new Set<string>()

  function warnOnce(record: RuntimeFlagRecord, msg: string): void {
    const seen = `${record.key}\u0000${JSON.stringify(record.value)}`
    if (warned.has(seen)) return
    warned.add(seen)
    deps.logger.warn({ key: record.key }, msg)
  }

  function toSnapshot(records: RuntimeFlagRecord[]): Snapshot {
    const overrides = new Map<string, Override>()
    for (const record of records) {
      if (!isRuntimeFlagKey(record.key)) {
        warnOnce(
          record,
          "runtime flags: ignoring a stored override whose key is not in the registry",
        )
        continue
      }
      const parsed = runtimeFlagValueSchema(record.key).safeParse(record.value)
      // A clear deletes the row, so a stored null is as invalid as a malformed value.
      if (!parsed.success || parsed.data === null) {
        warnOnce(record, "runtime flags: ignoring a stored override that fails its flag's schema")
        continue
      }
      overrides.set(record.key, {
        value: parsed.data,
        updatedAt: record.updatedAt,
        updatedBy:
          record.updatedBy !== null && record.updatedByEmail !== null
            ? { id: record.updatedBy, email: record.updatedByEmail }
            : null,
      })
    }
    return overrides
  }

  // Each load is numbered so a slow one that started before a write cannot overwrite what the write's
  // own refresh read.
  function load(): Promise<void> {
    attemptedAt = now()
    const generation = ++started
    const pending = Promise.resolve()
      .then(() => deps.repo.loadAll())
      .then(
        (records) => {
          const next = toSnapshot(records)
          if (generation > applied) {
            snapshot = next
            applied = generation
          }
        },
        (err: unknown) => {
          deps.logger.error({ err }, "runtime flags: refresh failed; keeping the last good values")
          throw err
        },
      )
    inflight = pending
    const settle = (): void => {
      if (inflight === pending) inflight = null
    }
    void pending.then(settle, settle)
    return pending
  }

  // A failed load also waits out the window, so an outage costs one query per window, not one per read.
  async function cached(): Promise<Snapshot | null> {
    const pending = inflight ?? (now() - attemptedAt >= RUNTIME_FLAG_CACHE_MS ? load() : null)
    if (pending !== null) {
      try {
        await pending
      } catch {
        // Logged by load(); readers keep the last good snapshot.
      }
    }
    return snapshot
  }

  async function fresh(): Promise<Snapshot> {
    await load()
    return snapshot ?? new Map()
  }

  function fallbackOf(flag: RuntimeFlagDef): { value: RuntimeFlagValue; fromEnv: boolean } {
    const fromEnv = Object.hasOwn(deps.envFallbacks, flag.key)
    const value = fromEnv ? deps.envFallbacks[flag.key as RuntimeFlagKey] : flag.default
    return { value: value ?? null, fromEnv }
  }

  function stateOf(flag: RuntimeFlagDef, overrides: Snapshot): RuntimeFlagStateDTO {
    const fallback = fallbackOf(flag)
    const override = overrides.get(flag.key)
    return {
      key: flag.key,
      value: override === undefined ? fallback.value : override.value,
      override: override?.value ?? null,
      fallback: fallback.value,
      fallbackSource: fallback.fromEnv ? "env" : "default",
      updatedAt: override?.updatedAt.toISOString() ?? null,
      updatedBy: override?.updatedBy ?? null,
    }
  }

  function parseValue(key: RuntimeFlagKey, value: boolean | string): RuntimeFlagValue {
    const parsed = runtimeFlagValueSchema(key).safeParse(value)
    if (!parsed.success) {
      throw AppError.validation({ value: parsed.error.issues[0]?.message ?? "invalid" })
    }
    return parsed.data
  }

  function flagOf(key: string): RuntimeFlagDef {
    const flag = FLAG_BY_KEY.get(key)
    if (flag === undefined) throw AppError.notFound()
    return flag
  }

  return {
    async get<K extends RuntimeFlagKey>(key: K): Promise<RuntimeFlagValueOf<K>> {
      const flag = flagOf(key)
      const overrides = await cached()
      // A database outage before the first load must never silently release the kill switch.
      if (overrides === null && key === KILL_SWITCH) return true as RuntimeFlagValueOf<K>
      const override = overrides?.get(key)
      return (
        override === undefined ? fallbackOf(flag).value : override.value
      ) as RuntimeFlagValueOf<K>
    },

    async list(): Promise<RuntimeFlagStateDTO[]> {
      const overrides = await fresh()
      return FLAGS.map((flag) => stateOf(flag, overrides))
    },

    async set(
      key: RuntimeFlagKey,
      value: RuntimeFlagValue,
      actorId: string,
    ): Promise<RuntimeFlagStateDTO> {
      const flag = flagOf(key)
      const stored = value === null ? null : parseValue(key, value)
      await deps.repo.set({ key, value: stored, actorId })
      return stateOf(flag, await fresh())
    },
  }
}
