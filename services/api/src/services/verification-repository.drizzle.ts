/**
 * Postgres-backed VerificationRepository (the production impl of the verification persistence seam).
 *
 * Written against the raw postgres-js tag (`Sql`) like the rest of the backend. The "verified" mark is the
 * presence of a `user_verification` row with status='verified'; the table is otherwise untouched (a row is
 * written/removed by the admin set-verified action — see admin-user-repository.drizzle.ts).
 */

import type { Sql } from "../db/client.js"
import type { VerificationRepository } from "./verification-service.js"

export function makeDrizzleVerificationRepository(sql: Sql): VerificationRepository {
  return {
    async isVerified(userId: string): Promise<boolean> {
      const rows = await sql<{ verified: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM user_verification
          WHERE user_id = ${userId} AND status = 'verified'
        ) AS verified
      `
      return rows[0]?.verified ?? false
    },
  }
}
