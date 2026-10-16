import type { PushSender, PushPayload, PushPlatform } from "../interfaces/push-sender.js"

export interface CapturedToken {
  userId: string
  token: string
  platform: PushPlatform
  deviceId?: string
}

export interface CapturedPush {
  userId: string
  payload: PushPayload
}

/**
 * In-memory PushSender that captures registered tokens and every push for assertions.
 */
export class FakePushSender implements PushSender {
  readonly tokens: CapturedToken[] = []
  readonly sent: CapturedPush[] = []

  registerToken(
    userId: string,
    token: string,
    platform: PushPlatform,
    deviceId?: string,
  ): Promise<void> {
    this.tokens.push({
      userId,
      token,
      platform,
      ...(deviceId !== undefined ? { deviceId } : {}),
    })
    return Promise.resolve()
  }

  send(userId: string, payload: PushPayload): Promise<void> {
    this.sent.push({ userId, payload })
    return Promise.resolve()
  }

  sendMany(userIds: string[], payload: PushPayload): Promise<void> {
    for (const userId of userIds) this.sent.push({ userId, payload })
    return Promise.resolve()
  }

  reset(): void {
    this.tokens.length = 0
    this.sent.length = 0
  }
}
