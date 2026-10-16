export interface SentSms {
  id: string
}

export interface SmsSender {
  send(to: string, body: string): Promise<SentSms>
}
