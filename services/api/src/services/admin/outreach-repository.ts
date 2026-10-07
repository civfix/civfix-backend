import type { ReportCategory } from "@civfix/shared"

export interface OutreachDigest {
  geoid: string
  org: string | null
  toAddr: string
  perCategory: Partial<Record<ReportCategory, number>>
  total: number
  oldestWaitingAt: Date | null
}

export interface OutreachRepository {
  loadDigest(geoid: string): Promise<OutreachDigest | null>
  listCandidateGeoids(limit?: number): Promise<string[]>
  claimOutreachWindow?(geoid: string, window: { at: Date; windowStart: Date }): Promise<boolean>
}
