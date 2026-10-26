import type { Sql } from "../../db/client.js"
import { insertAuditRow } from "./audit-repository.drizzle.js"
import type {
  RuntimeFlagRecord,
  RuntimeFlagRepository,
  SetRuntimeFlagInput,
} from "./runtime-flag-repository.js"

// The registry holds a handful of flags; the bound only matters if stale keys ever pile up.
const RUNTIME_FLAG_ROWS_MAX = 500

interface RuntimeFlagRowSelect {
  key: string
  value: unknown
  updated_at: Date
  updated_by: string | null
  updated_by_email: string | null
}

export function makeDrizzleRuntimeFlagRepository(sql: Sql): RuntimeFlagRepository {
  return {
    async loadAll(): Promise<RuntimeFlagRecord[]> {
      const rows = await sql<RuntimeFlagRowSelect[]>`
        SELECT f.key, f.value, f.updated_at, f.updated_by, u.email AS updated_by_email
        FROM runtime_flags f
        LEFT JOIN users u ON u.id = f.updated_by
        ORDER BY f.key
        LIMIT ${RUNTIME_FLAG_ROWS_MAX}
      `
      return rows.map((row) => ({
        key: row.key,
        value: row.value,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        updatedByEmail: row.updated_by_email,
      }))
    },

    async set(input: SetRuntimeFlagInput): Promise<void> {
      await sql.begin(async (tx) => {
        // The row lock makes the audited "from" the value this write actually replaced.
        const previous = await tx<{ value: unknown }[]>`
          SELECT value FROM runtime_flags WHERE key = ${input.key} FOR UPDATE
        `
        const from = previous[0]?.value ?? null
        if (input.value === null) {
          if (previous.length === 0) return
          await tx`DELETE FROM runtime_flags WHERE key = ${input.key}`
        } else {
          await tx`
            INSERT INTO runtime_flags (key, value, updated_at, updated_by)
            VALUES (${input.key}, ${tx.json(input.value)}, now(), ${input.actorId})
            ON CONFLICT (key) DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = EXCLUDED.updated_at,
              updated_by = EXCLUDED.updated_by
          `
        }
        await insertAuditRow(tx, {
          actorId: input.actorId,
          action: "dev.flag_set",
          target: `flag:${input.key}`,
          meta: { from, to: input.value },
        })
      })
    },
  }
}
