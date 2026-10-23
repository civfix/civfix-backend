import type { PushSenderConfig, PushLogger, PlatformDispatcher } from "./push-sender.js"

const APNS_GONE_STATUS = "410"

const APNS_PRUNE_REASONS: ReadonlySet<string> = new Set(["Unregistered", "BadDeviceToken"])

export function isApnsPruneFailure(status: string, reason: string): boolean {
  return status === APNS_GONE_STATUS || APNS_PRUNE_REASONS.has(reason)
}

export function makeApnsDispatcher(
  _apns: NonNullable<PushSenderConfig["apns"]>,
  _logger: PushLogger,
): PlatformDispatcher {
  const dispatch: PlatformDispatcher = async () => {
    throw new Error("not implemented")
  }
  dispatch.close = async () => {}
  return dispatch
}
