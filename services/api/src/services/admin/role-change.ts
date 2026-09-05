
import type { Role } from "@civfix/shared"

export type RevokeAllSessions = (userId: string) => Promise<number>

export interface ApplyRoleChangeDeps {
  write: (userId: string, role: Role) => Promise<void>
  revokeAll: RevokeAllSessions
}

export async function applyRoleChange(
  deps: ApplyRoleChangeDeps,
  userId: string,
  role: Role,
): Promise<number> {
  await deps.write(userId, role)
  return deps.revokeAll(userId)
}
