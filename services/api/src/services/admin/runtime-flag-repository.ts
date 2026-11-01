/** A stored override, as read: `value` is the raw jsonb, checked against the registry by the service. */
export interface RuntimeFlagRecord {
  key: string
  value: unknown
  updatedAt: Date
  updatedBy: string | null
  /** The operator's current email; null when that account is gone or has none. */
  updatedByEmail: string | null
}

/** `value: null` clears the override; a clear with no override is not a change and writes nothing. */
export interface SetRuntimeFlagInput {
  key: string
  value: boolean | string | null
  actorId: string
}

export interface RuntimeFlagRepository {
  loadAll(): Promise<RuntimeFlagRecord[]>
  set(input: SetRuntimeFlagInput): Promise<void>
}
