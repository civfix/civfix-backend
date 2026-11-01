import {
  AppError,
  type AdminDevForceUpdateAccount,
  type AdminDevForceUpdateListResponse,
  type AdminDevResetFirstRunResponse,
  type AdminDevTestEmailResponse,
  type AdminDevTestPushRequest,
  type AdminDevTestPushResponse,
} from "@civfix/contract"
import type { Mailer, PushSender } from "@civfix/seams"
import type { CacheClient } from "../../auth/cache.js"
import type { DevTestRepository } from "./dev-test-repository.js"

const FORCE_UPDATE_OVERRIDE_TTL_SECONDS = 24 * 60 * 60
const FORCE_UPDATE_OVERRIDES_MAX = 20
export const FORCE_UPDATE_INDEX_KEY = "dev:force-update:index"

const TEST_PUSH_DEFAULT_TITLE = "Test notification"
const TEST_EMAIL_SUBJECT = "civfix test email"
const TEST_MESSAGE_TEXT = "Sent from the civfix developer console."

interface StoredOverride {
  email: string
  expiresAt: string
}

export function forceUpdateOverrideKey(userId: string): string {
  return `dev:force-update:${userId}`
}

export interface DevTestToolsDeps {
  repo: DevTestRepository
  cache: CacheClient
  pushSender: PushSender
  mailer: Mailer
  mailFrom: string
  /** Trimmed and lowercased by the env loader. */
  testEmails: readonly string[]
  now?: () => number
}

export interface DevTestTools {
  listForceUpdate(): Promise<AdminDevForceUpdateListResponse>
  setForceUpdate(
    actorId: string,
    email: string,
    enabled: boolean,
  ): Promise<AdminDevForceUpdateListResponse>
  hasForceUpdate(userId: string): Promise<boolean>
  sendTestPush(actorId: string, input: AdminDevTestPushRequest): Promise<AdminDevTestPushResponse>
  sendTestEmail(actorId: string): Promise<AdminDevTestEmailResponse>
  resetFirstRun(actorId: string, email: string): Promise<AdminDevResetFirstRunResponse>
}

export function makeDevTestTools(deps: DevTestToolsDeps): DevTestTools {
  const now = deps.now ?? Date.now
  const testEmails: ReadonlySet<string> = new Set(deps.testEmails)

  // Only accounts made for testing: staging holds real testers who get real pushes and email.
  async function testAccount(email: string): Promise<{ userId: string; email: string }> {
    const normalized = email.trim().toLowerCase()
    if (!testEmails.has(normalized)) throw AppError.forbidden("Not a test account.")
    const userId = await deps.repo.findAccountIdByEmail(normalized)
    if (userId === null) throw AppError.notFound("This test account has not signed in yet.")
    return { userId, email: normalized }
  }

  async function listForceUpdate(): Promise<AdminDevForceUpdateListResponse> {
    const userIds = await deps.cache.smembers(FORCE_UPDATE_INDEX_KEY)
    const values = await Promise.all(
      userIds.map((id) => deps.cache.get(forceUpdateOverrideKey(id))),
    )
    const accounts: AdminDevForceUpdateAccount[] = []
    const expired: string[] = []
    for (const [i, userId] of userIds.entries()) {
      const value = values[i] ?? null
      if (value === null) expired.push(userId)
      else accounts.push({ userId, ...(JSON.parse(value) as StoredOverride) })
    }
    if (expired.length > 0) await deps.cache.srem(FORCE_UPDATE_INDEX_KEY, ...expired)
    return { accounts }
  }

  return {
    listForceUpdate,

    async setForceUpdate(actorId, email, enabled) {
      const target = await testAccount(email)
      const key = forceUpdateOverrideKey(target.userId)
      if (enabled) {
        const { accounts } = await listForceUpdate()
        const renewing = accounts.some((a) => a.userId === target.userId)
        if (!renewing && accounts.length >= FORCE_UPDATE_OVERRIDES_MAX) {
          throw AppError.conflict(
            `At most ${FORCE_UPDATE_OVERRIDES_MAX} accounts can be forced to update at once.`,
          )
        }
        const expiresAt = new Date(now() + FORCE_UPDATE_OVERRIDE_TTL_SECONDS * 1000).toISOString()
        const stored: StoredOverride = { email: target.email, expiresAt }
        await deps.cache.set(key, JSON.stringify(stored), FORCE_UPDATE_OVERRIDE_TTL_SECONDS)
        await deps.cache.sadd(FORCE_UPDATE_INDEX_KEY, target.userId)
        // The index expires with its newest override, so it never outlives the overrides it lists.
        await deps.cache.expire(FORCE_UPDATE_INDEX_KEY, FORCE_UPDATE_OVERRIDE_TTL_SECONDS)
      } else {
        await deps.cache.del(key)
        await deps.cache.srem(FORCE_UPDATE_INDEX_KEY, target.userId)
      }
      await deps.repo.writeAudit({
        actorId,
        action: "dev.force_update_set",
        target: `user:${target.userId}`,
        meta: { enabled },
      })
      return listForceUpdate()
    },

    async hasForceUpdate(userId) {
      return (await deps.cache.get(forceUpdateOverrideKey(userId))) !== null
    },

    async sendTestPush(actorId, input) {
      const target = await testAccount(input.email)
      const devices = await deps.repo.countActivePushDevices(target.userId)
      await deps.pushSender.send(target.userId, {
        title: input.title ?? TEST_PUSH_DEFAULT_TITLE,
        body: input.body ?? TEST_MESSAGE_TEXT,
      })
      await deps.repo.writeAudit({
        actorId,
        action: "dev.test_push",
        target: `user:${target.userId}`,
        meta: { devices },
      })
      return { devices }
    },

    // Straight through the mailer seam, so the test never shows up as civfix mail in the mail views.
    async sendTestEmail(actorId) {
      const to = await deps.repo.findEmailById(actorId)
      if (to === null) throw AppError.notFound("Your account has no email address.")
      await deps.mailer.sendOutbound({
        from: deps.mailFrom,
        to,
        subject: TEST_EMAIL_SUBJECT,
        text: TEST_MESSAGE_TEXT,
      })
      await deps.repo.writeAudit({
        actorId,
        action: "dev.test_email",
        target: `user:${actorId}`,
        meta: null,
      })
      return { to }
    },

    async resetFirstRun(actorId, email) {
      const target = await testAccount(email)
      await deps.repo.resetFirstRun({ userId: target.userId, actorId })
      return { userId: target.userId }
    },
  }
}
