import type { AudiencePageQuery } from "./broadcast-repository.js"

export interface BroadcastAudienceRepository {
  audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }>
}
