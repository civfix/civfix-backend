import type { ROLE_VALUES } from "../db/schema/types.js"

export type GlobalRole = (typeof ROLE_VALUES)[number]

export interface UserRoleAndEmail {
  role: GlobalRole
  email: string | null
}

export interface UsersRepository {
  findRoleAndEmail(userId: string): Promise<UserRoleAndEmail | null>
}
