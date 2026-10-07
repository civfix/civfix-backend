import { describe, expect, it } from "vitest"
import { makeSocialService } from "../../src/services/social-service.js"
import { InMemorySocialRepository } from "../helpers/social.js"

const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"

describe("a failed new-follower notification is logged, not silently dropped", () => {
  it("keeps the follow and records the failure with who followed whom", async () => {
    const repo = new InMemorySocialRepository()
    repo.seedUser({ id: A, displayName: "Alice" })
    repo.seedUser({ id: B, displayName: "Bob" })
    const failure = new Error("notifier down")
    const warnings: Array<{ obj: unknown; msg: string }> = []
    const service = makeSocialService({
      repo,
      notifier: { onNewFollower: () => Promise.reject(failure) },
      logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    })

    await expect(service.followPerson(A, B)).resolves.toEqual({ isFollowing: true, followers: 1 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.obj).toEqual({ err: failure, viewerId: A, targetId: B })
  })
})
