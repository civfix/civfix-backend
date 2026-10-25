import type {
  RUNTIME_FLAGS,
  RuntimeFlagKey,
  RuntimeFlagStateDTO,
  RuntimeFlagValue,
} from "@civfix/contract"
import type { RuntimeFlagEnvFallbacks } from "../../env/dev-console-env.js"
import type { RuntimeFlagRepository } from "./runtime-flag-repository.js"

interface ValueOfType {
  boolean: boolean
  semver: string | null
  url: string | null
  text: string | null
  choice: string
}

export type RuntimeFlagValueOf<K extends RuntimeFlagKey> =
  ValueOfType[Extract<(typeof RUNTIME_FLAGS)[number], { key: K }>["type"]]

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
  get<K extends RuntimeFlagKey>(key: K): Promise<RuntimeFlagValueOf<K>>
  list(): Promise<RuntimeFlagStateDTO[]>
  set(key: string, value: RuntimeFlagValue, actorId: string): Promise<RuntimeFlagStateDTO>
}

export function makeRuntimeFlagService(_deps: RuntimeFlagServiceDeps): RuntimeFlagService {
  throw new Error("not implemented")
}
