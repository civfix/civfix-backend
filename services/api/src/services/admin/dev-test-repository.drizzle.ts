import type { Sql } from "../../db/client.js"
import { insertAuditRow } from "./audit-repository.drizzle.js"
import type { DevTestRepository } from "./dev-test-repository.js"

export function makeDrizzleDevTestRepository(sql: Sql): DevTestRepository {
  return {
    async findAccountIdByEmail(email: string): Promise<string | null> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL LIMIT 1
      `
      return rows[0]?.id ?? null
    },

    async findEmailById(userId: string): Promise<string | null> {
      const rows = await sql<{ email: string | null }[]>`
        SELECT email FROM users WHERE id = ${userId}
      `
      return rows[0]?.email ?? null
    },

    async countActivePushDevices(userId: string): Promise<number> {
      const rows = await sql<{ devices: number }[]>`
        SELECT count(*)::int AS devices
        FROM push_tokens
        WHERE user_id = ${userId} AND revoked_at IS NULL
      `
      return rows[0]?.devices ?? 0
    },

    async resetFirstRun(input: { userId: string; actorId: string }): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`UPDATE users SET profile_complete = false WHERE id = ${input.userId}`
        await insertAuditRow(tx, {
          actorId: input.actorId,
          action: "dev.reset_first_run",
          target: `user:${input.userId}`,
          meta: null,
        })
      })
    },

    async writeAudit(input): Promise<void> {
      await insertAuditRow(sql, input)
    },
  }
}
