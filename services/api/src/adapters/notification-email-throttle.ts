export interface EmailThrottleRequest {
  userId: string
  conversation: string | null
}

export interface NotificationEmailThrottle {
  claim(requests: readonly EmailThrottleRequest[]): Promise<boolean[]>
  release(requests: readonly EmailThrottleRequest[]): Promise<void>
}

export class InMemoryNotificationEmailThrottle implements NotificationEmailThrottle {
  constructor(private readonly clock: () => number = () => Date.now()) {}

  claim(_requests: readonly EmailThrottleRequest[]): Promise<boolean[]> {
    void this.clock
    throw new Error("not implemented")
  }

  release(_requests: readonly EmailThrottleRequest[]): Promise<void> {
    throw new Error("not implemented")
  }
}
