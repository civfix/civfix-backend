import type {
  PushSender,
  PushPayload,
  PushPlatform,
  PushItem,
  PushClearTarget,
} from "../interfaces/push-sender.js"

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

export interface CapturedClear {
  userId: string
  target: PushClearTarget
}

/**
 * In-memory PushSender that captures registered tokens, every push and every clear for assertions.
 */
export class FakePushSender implements PushSender {
  readonly tokens: CapturedToken[] = []
  readonly sent: CapturedPush[] = []
  readonly clears: CapturedClear[] = []

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

  sendEach(items: PushItem[]): Promise<void> {
    for (const { userId, payload } of items) this.sent.push({ userId, payload })
    return Promise.resolve()
  }

  clear(userId: string, target: PushClearTarget): Promise<void> {
    this.clears.push({ userId, target })
    return Promise.resolve()
  }

  reset(): void {
    this.tokens.length = 0
    this.sent.length = 0
    this.clears.length = 0
  }
}
