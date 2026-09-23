import type { BroadcastKind, BroadcastSegment } from "@civfix/shared"
import type { BroadcastRepository } from "./broadcast-repository.js"

export const AUDIENCE_PAGE_SIZE = 1000
const AUDIENCE_MAX_PAGES = 100
// Sorts after every real id, so a side that is already exhausted pages to an empty result.
const LAST_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

export interface AudienceScope {
  cleanupId: string
  segment: BroadcastSegment
  kind: BroadcastKind
}

export interface AudiencePage {
  members: string[]
  guests: string[]
}

export async function* audiencePages(
  repo: Pick<BroadcastRepository, "audiencePage">,
  scope: AudienceScope,
): AsyncGenerator<AudiencePage> {
  let afterMember: string | null = null
  let afterGuest: string | null = null
  let memberDone = false
  let guestDone = false
  for (let page = 0; page < AUDIENCE_MAX_PAGES; page += 1) {
    const result: AudiencePage = await repo.audiencePage({
      cleanupId: scope.cleanupId,
      segment: scope.segment,
      kind: scope.kind,
      afterMember: memberDone ? LAST_UUID : afterMember,
      afterGuest: guestDone ? LAST_UUID : afterGuest,
      limit: AUDIENCE_PAGE_SIZE,
    })
    if (result.members.length < AUDIENCE_PAGE_SIZE) memberDone = true
    else afterMember = result.members.at(-1) ?? afterMember
    if (result.guests.length < AUDIENCE_PAGE_SIZE) guestDone = true
    else afterGuest = result.guests.at(-1) ?? afterGuest
    yield result
    if (memberDone && guestDone) return
  }
}
