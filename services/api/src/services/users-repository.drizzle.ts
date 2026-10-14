import type { Sql } from "../db/client.js"
import type { UserRoleAndEmail, UsersRepository } from "./users-repository.js"

export function makeDrizzleUsersRepository(sql: Sql): UsersRepository {
  return {
    async findRoleAndEmail(userId: string): Promise<UserRoleAndEmail | null> {
      const rows = await sql<UserRoleAndEmail[]>`
        SELECT role, email FROM users WHERE id = ${userId} LIMIT 1
      `
      return rows[0] ?? null
    },
  }
}
