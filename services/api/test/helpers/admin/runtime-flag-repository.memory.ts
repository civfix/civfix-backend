import type {
  RuntimeFlagRecord,
  RuntimeFlagRepository,
  SetRuntimeFlagInput,
} from "../../../src/services/admin/runtime-flag-repository.js"
import type { WriteAuditInput } from "../../../src/services/admin/audit.js"

interface StoredFlag {
  value: unknown
  updatedAt: Date
  updatedBy: string | null
}

export class InMemoryRuntimeFlagRepository implements RuntimeFlagRepository {
  readonly rows = new Map<string, StoredFlag>()
  /** userId -> email: the accounts `updatedBy` resolves against. */
  readonly emails = new Map<string, string>()
  readonly audits: WriteAuditInput[] = []
  loadAllCalls = 0
  /** When set, every loadAll rejects with it. */
  loadAllError: Error | null = null
  now = new Date(Date.UTC(2026, 9, 25, 12, 0, 0, 0))

  seed(key: string, value: unknown, updatedBy: string | null = null): void {
    this.rows.set(key, { value, updatedAt: this.now, updatedBy })
  }

  loadAll(): Promise<RuntimeFlagRecord[]> {
    this.loadAllCalls += 1
    if (this.loadAllError !== null) return Promise.reject(this.loadAllError)
    return Promise.resolve(
      [...this.rows].map(([key, row]) => ({
        key,
        value: row.value,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        updatedByEmail: row.updatedBy === null ? null : (this.emails.get(row.updatedBy) ?? null),
      })),
    )
  }

  set(input: SetRuntimeFlagInput): Promise<void> {
    const previous = this.rows.get(input.key)
    if (input.value === null) {
      if (previous === undefined) return Promise.resolve()
      this.rows.delete(input.key)
    } else {
      this.rows.set(input.key, { value: input.value, updatedAt: this.now, updatedBy: input.actorId })
    }
    this.audits.push({
      actorId: input.actorId,
      action: "dev.flag_set",
      target: `flag:${input.key}`,
      meta: { from: previous?.value ?? null, to: input.value },
    })
    return Promise.resolve()
  }
}
