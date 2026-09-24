import type { Sql } from "../db/client.js"
import type { ROLE_VALUES } from "../db/schema/types.js"

export type GlobalRole = (typeof ROLE_VALUES)[number]

export interface UserRoleAndEmail {
  role: GlobalRole
  email: string | null
}

export interface UsersRepository {
  findRoleAndEmail(userId: string): Promise<UserRoleAndEmail | null>
}

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
