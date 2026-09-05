import { describe, it, expect } from "vitest"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import { makeModerationService } from "../../src/services/admin/moderation-service.js"
import type { UserStatus } from "@civfix/shared"

const NOW = new Date("2026-09-03T00:00:00.000Z")

function harness() {
  const repo = new InMemoryModerationRepository()
  repo.now = NOW
  const applied: Array<{ userId: string; status: UserStatus }> = []
  const svc = makeModerationService({
    repo,
    now: () => NOW,
    sessions: {
      applyStatus: (userId: string, status: UserStatus) => {
        applied.push({ userId, status })
        return Promise.resolve(1)
      },
    },
  })
  return { repo, svc, applied }
}

describe("B1: moderation 'remove' can never suspend an operator account", () => {
  it("refuses a user subject whose target is an operator, leaving the item open and every session live", async () => {
    const { repo, svc, applied } = harness()
    repo.userRoles.set("OP-1", "operator")
    repo.seedItem({ id: "MOD-OP", subjectType: "user", subjectId: "OP-1", status: "open" })

    await expect(svc.remove("MOD-OP", { actorId: "op-2", reason: "abuse" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(repo.accountStatus.get("OP-1")).toBeUndefined()
    expect(applied).toEqual([])
    expect(repo.items.get("MOD-OP")?.status).toBe("open")
  })

  it("refuses a PROFILE subject for an operator too", async () => {
    const { repo, svc, applied } = harness()
    repo.userRoles.set("OP-1", "operator")
    repo.seedItem({ id: "MOD-OP2", subjectType: "profile", subjectId: "OP-1", status: "open" })

    await expect(svc.remove("MOD-OP2", { actorId: "op-2", reason: "abuse" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(repo.accountStatus.get("OP-1")).toBeUndefined()
    expect(applied).toEqual([])
  })

  it("still suspends and revokes a NON-operator user subject (the guard is not a blanket refusal)", async () => {
    const { repo, svc, applied } = harness()
    repo.userRoles.set("U-9", "citizen")
    repo.seedItem({ id: "MOD-U", subjectType: "user", subjectId: "U-9", status: "open" })

    await svc.remove("MOD-U", { actorId: "op-2", reason: "abuse" })
    expect(repo.accountStatus.get("U-9")).toBe("suspended")
    expect(applied).toEqual([{ userId: "U-9", status: "suspended" }])
  })

  it("never blocks removing an operator's CONTENT, only their account status", async () => {
    const { repo, svc, applied } = harness()
    repo.userRoles.set("OP-1", "operator")
    repo.seedItem({ id: "MOD-C", subjectType: "chat", subjectId: "CHAT-1", status: "open" })

    await svc.remove("MOD-C", { actorId: "op-2", reason: "abuse" })
    expect(repo.tombstoned.has("CHAT-1")).toBe(true)
    expect(applied).toEqual([])
  })
})
