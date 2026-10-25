import type { RuntimeFlagKey, RuntimeFlagValue } from "@civfix/contract"

/** The env value each runtime flag falls back to, present only for a flag whose env var is set non-empty. */
export type RuntimeFlagEnvFallbacks = Partial<Record<RuntimeFlagKey, RuntimeFlagValue>>
