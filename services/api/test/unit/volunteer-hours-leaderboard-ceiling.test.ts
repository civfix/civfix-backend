import { describe, expect, it } from "vitest"
import {
  LEADERBOARD_MAX_LIMIT,
  LEADERBOARD_MAX_OFFSET,
  makeVolunteerHoursService,
  type CleanupHoursLookup,
} from "../../src/services/volunteer-hours-service.js"
import { InMemoryVolunteerHoursRepository } from "../helpers/volunteer-hours-repository.memory.js"

const GEOID = "0667000"

/** A jurisdiction deeper than the offset ceiling: the repository always reports another page. */
function bottomlessRepo(): InMemoryVolunteerHoursRepository {
  const repo = new InMemoryVolunteerHoursRepository()
  repo.leaderboard = (_geoid, limit, offset) =>
    Promise.resolve({
      jurisdictionName: "San Francisco",
      entries: [],
      nextOffset: offset + limit,
      participantCount: null,
      viewerRank: null,
      viewerHours: null,
    })
  return repo
}

describe("leaderboard paging at the offset ceiling", () => {
  it("ends the chain instead of handing back an offset that clamps onto the same page", async () => {
    const service = makeVolunteerHoursService({
      repo: bottomlessRepo(),
      cleanups: {} as CleanupHoursLookup,
    })

    const last = await service.leaderboard(GEOID, {
      geoid: GEOID,
      limit: LEADERBOARD_MAX_LIMIT,
      offset: LEADERBOARD_MAX_OFFSET,
    })
    expect(last.nextOffset).toBeNull()

    const beyond = await service.leaderboard(GEOID, {
      geoid: GEOID,
      limit: LEADERBOARD_MAX_LIMIT,
      offset: LEADERBOARD_MAX_OFFSET + 20,
    })
    expect(beyond.nextOffset).toBeNull()
  })

  it("keeps paging while the next offset is still reachable", async () => {
    const service = makeVolunteerHoursService({
      repo: bottomlessRepo(),
      cleanups: {} as CleanupHoursLookup,
    })

    const page = await service.leaderboard(GEOID, {
      geoid: GEOID,
      limit: LEADERBOARD_MAX_LIMIT,
      offset: LEADERBOARD_MAX_OFFSET - LEADERBOARD_MAX_LIMIT,
    })
    expect(page.nextOffset).toBe(LEADERBOARD_MAX_OFFSET)
  })
})
