import { REPORT_VOLUNTEER_HOURS, avatarGradient } from "@civfix/shared"
import type { LeaderboardEntryDTO, MyVolunteerHoursDTO } from "@civfix/shared"
import type {
  LeaderboardPage,
  LogEventHoursArgs,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

export interface MemoryLeaderboardUser {
  name: string
  handle: string | null
  avatarUrl: string | null
  verified: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export class InMemoryVolunteerHoursRepository implements VolunteerHoursRepository {
  private readonly reportLedger = new Set<string>()
  private readonly eventLedger = new Map<string, number>()
  private readonly rollup = new Map<string, number>()
  private readonly users = new Map<string, MemoryLeaderboardUser>()
  private readonly jurisdictionNames = new Map<string, string>()

  seedUser(userId: string, user: MemoryLeaderboardUser): void {
    this.users.set(userId, user)
  }

  seedJurisdiction(geoid: string, name: string): void {
    this.jurisdictionNames.set(geoid, name)
  }

  awardReportHours(userId: string, reportId: string, geoid: string | null): Promise<void> {
    if (this.reportLedger.has(reportId)) return Promise.resolve()
    this.reportLedger.add(reportId)
    if (geoid !== null) this.addRollup(userId, geoid, REPORT_VOLUNTEER_HOURS)
    return Promise.resolve()
  }

  logEventHours(args: LogEventHoursArgs): Promise<number> {
    for (const entry of args.entries) {
      const key = `${args.cleanupId}|${entry.userId}`
      const previous = this.eventLedger.get(key) ?? 0
      this.eventLedger.set(key, entry.hours)
      if (args.geoid !== null) this.addRollup(entry.userId, args.geoid, entry.hours - previous)
    }
    return Promise.resolve(args.entries.length)
  }

  totalsFor(userId: string): Promise<MyVolunteerHoursDTO> {
    const byJurisdiction: MyVolunteerHoursDTO["byJurisdiction"] = []
    let totalHours = 0
    for (const [key, total] of this.rollup) {
      const parsed = this.parseKey(key)
      if (parsed.userId !== userId || total <= 0) continue
      totalHours += total
      byJurisdiction.push({
        geoid: parsed.geoid,
        name: this.jurisdictionNames.get(parsed.geoid) ?? null,
        hours: round2(total),
      })
    }
    byJurisdiction.sort((a, b) => b.hours - a.hours || a.geoid.localeCompare(b.geoid))
    return Promise.resolve({ totalHours: round2(totalHours), byJurisdiction })
  }

  totalHoursFor(userId: string): Promise<number> {
    let total = 0
    for (const [key, value] of this.rollup) {
      if (this.parseKey(key).userId === userId && value > 0) total += value
    }
    return Promise.resolve(round2(total))
  }

  leaderboard(geoid: string, limit: number, offset: number): Promise<LeaderboardPage> {
    const ranked: { userId: string; hours: number }[] = []
    for (const [key, total] of this.rollup) {
      const parsed = this.parseKey(key)
      if (parsed.geoid !== geoid || total <= 0) continue
      ranked.push({ userId: parsed.userId, hours: total })
    }
    ranked.sort((a, b) => b.hours - a.hours || a.userId.localeCompare(b.userId))

    const window = ranked.slice(offset, offset + limit + 1)
    const hasMore = window.length > limit
    const page = hasMore ? window.slice(0, limit) : window
    const entries: LeaderboardEntryDTO[] = page.map((row, i) => {
      const user = this.users.get(row.userId)
      return {
        rank: offset + i + 1,
        userId: row.userId,
        name: user?.name ?? "",
        ...(user?.handle != null ? { handle: user.handle } : {}),
        avatar: avatarGradient(row.userId),
        ...(user?.avatarUrl != null ? { avatarUrl: user.avatarUrl } : {}),
        verified: user?.verified ?? false,
        hours: round2(row.hours),
      }
    })

    return Promise.resolve({
      jurisdictionName: this.jurisdictionNames.get(geoid) ?? null,
      entries,
      nextOffset: hasMore ? offset + limit : null,
    })
  }

  private addRollup(userId: string, geoid: string, delta: number): void {
    const key = `${userId}|${geoid}`
    this.rollup.set(key, (this.rollup.get(key) ?? 0) + delta)
  }

  private parseKey(key: string): { userId: string; geoid: string } {
    const sep = key.indexOf("|")
    return { userId: key.slice(0, sep), geoid: key.slice(sep + 1) }
  }
}
