import type { WriteAuditInput } from "./audit.js"

export interface DevTestRepository {
  /** The live account holding this lowercased address, or null. */
  findAccountIdByEmail(email: string): Promise<string | null>
  findEmailById(userId: string): Promise<string | null>
  /** Push tokens not revoked, counted on their own: the send never reports how many devices it reached. */
  countActivePushDevices(userId: string): Promise<number>
  /** Sets `profile_complete` to false and writes `dev.reset_first_run` in the same transaction. */
  resetFirstRun(input: { userId: string; actorId: string }): Promise<void>
  writeAudit(input: WriteAuditInput): Promise<void>
}
