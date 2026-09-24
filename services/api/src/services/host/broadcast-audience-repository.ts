import type { AudienceCountQuery, AudiencePageQuery } from "./broadcast-repository.js"

export interface BroadcastAudienceRepository {
  audiencePage(query: AudiencePageQuery): Promise<{ members: string[]; guests: string[] }>
  /** Distinct members plus guests in the audience, each side counted up to `cap`. */
  audienceCount(query: AudienceCountQuery): Promise<number>
}
