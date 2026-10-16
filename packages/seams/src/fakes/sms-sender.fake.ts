import type { SmsSender, SentSms } from "../interfaces/sms-sender.js"

export interface CapturedSms {
  to: string
  body: string
  id: string
}

export class FakeSmsSender implements SmsSender {
  readonly sent: CapturedSms[] = []
  private n = 0

  send(to: string, body: string): Promise<SentSms> {
    const id = `fake-sms-${++this.n}`
    this.sent.push({ to, body, id })
    return Promise.resolve({ id })
  }

  lastFor(to: string): CapturedSms | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const s = this.sent[i]
      if (s && s.to === to) return s
    }
    return undefined
  }

  reset(): void {
    this.sent.length = 0
    this.n = 0
  }
}
