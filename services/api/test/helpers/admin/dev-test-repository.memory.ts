import type { InMemoryUserStore } from "../../../src/auth/stores.js"
import type { DevTestRepository } from "../../../src/services/admin/dev-test-repository.js"
import type { WriteAuditInput } from "../../../src/services/admin/audit.js"

interface PushToken {
  userId: string
  revoked: boolean
}

/** Reads and writes the accounts of the auth harness's user store, so sessions and targets agree. */
export class InMemoryDevTestRepository implements DevTestRepository {
  readonly audits: WriteAuditInput[] = []
  readonly pushTokens: PushToken[] = []
  constructor(private readonly users: InMemoryUserStore) {}

  async findAccountIdByEmail(email: string): Promise<string | null> {
    return (await this.users.findByEmail(email))?.id ?? null
  }

  async findEmailById(userId: string): Promise<string | null> {
    return (await this.users.findById(userId))?.email ?? null
  }

  countActivePushDevices(userId: string): Promise<number> {
    return Promise.resolve(this.pushTokens.filter((t) => t.userId === userId && !t.revoked).length)
  }

  async resetFirstRun(input: { userId: string; actorId: string }): Promise<void> {
    const user = await this.users.findById(input.userId)
    if (user === null) throw new Error(`no user ${input.userId}`)
    this.users.seed(user.email, { ...user, profileComplete: false })
    this.audits.push({
      actorId: input.actorId,
      action: "dev.reset_first_run",
      target: `user:${input.userId}`,
      meta: null,
    })
  }

  writeAudit(input: WriteAuditInput): Promise<void> {
    this.audits.push(input)
    return Promise.resolve()
  }
}
