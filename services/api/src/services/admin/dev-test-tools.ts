import type {
  AdminDevForceUpdateListResponse,
  AdminDevResetFirstRunResponse,
  AdminDevTestEmailResponse,
  AdminDevTestPushRequest,
  AdminDevTestPushResponse,
} from "@civfix/contract"
import type { Mailer, PushSender } from "@civfix/seams"
import type { CacheClient } from "../../auth/cache.js"
import type { DevTestRepository } from "./dev-test-repository.js"

export const FORCE_UPDATE_OVERRIDE_TTL_SECONDS = 24 * 60 * 60
export const FORCE_UPDATE_OVERRIDES_MAX = 20
export const FORCE_UPDATE_INDEX_KEY = "dev:force-update:index"

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

export function makeDevTestTools(_deps: DevTestToolsDeps): DevTestTools {
  const notImplemented = (): never => {
    throw new Error("not implemented")
  }
  return {
    listForceUpdate: notImplemented,
    setForceUpdate: notImplemented,
    hasForceUpdate: notImplemented,
    sendTestPush: notImplemented,
    sendTestEmail: notImplemented,
    resetFirstRun: notImplemented,
  }
}
