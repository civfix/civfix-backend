import { describe, expect, it } from "vitest"
import type { UserStatus } from "@civfix/shared"
import { CIVFIX_OFFICIAL_USER_ID, impersonatesOfficialName } from "../../src/auth/official-account.js"
import { InMemoryAdminUserRepository } from "../../src/services/admin/admin-user-repository.memory.js"
import { makeAdminUserService } from "../../src/services/admin/admin-user-service.js"
import { InMemoryModerationRepository } from "../../src/services/admin/moderation-repository.memory.js"
import { makeModerationService } from "../../src/services/admin/moderation-service.js"

const OFFICIAL = CIVFIX_OFFICIAL_USER_ID
const NOW = new Date("2026-09-22T00:00:00.000Z")

describe("display names that read as the official account", () => {
  it.each([
    "CivFix",
    "civfix",
    "CIV FIX",
    "Civ-Fix",
    "C1vF!x",
    "Civ.Fix ",
    "\u0421iv\u0192i\u0445",
    "\uff23\uff49\uff56\uff26\uff49\uff58",
    "C\u00edvF\u00efx",
  ])("reserves %s", (name) => {
    expect(impersonatesOfficialName(name)).toBe(true)
  })

  it.each(["Civic Fix", "CivFix Fan", "Fix Civ", "Civfixer", "Cindy Fix"])("allows %s", (name) => {
    expect(impersonatesOfficialName(name)).toBe(false)
  })
})

describe("console account actions refuse the official account", () => {
  function harness() {
    const repo = new InMemoryAdminUserRepository()
    repo.seedUser({ id: OFFICIAL, role: "citizen", accountStatus: "active" })
    const touched: string[] = []
    const svc = makeAdminUserService({
      repo,
      sessions: {
        applyStatus: (userId: string, _status: UserStatus) => {
          touched.push(userId)
          return Promise.resolve(0)
        },
        revokeAll: (userId: string) => {
          touched.push(userId)
          return Promise.resolve(0)
        },
      },
      now: () => NOW,
    })
    return { repo, svc, touched }
  }

  it("refuses flag, status, role and verify, in any letter case, and writes nothing", async () => {
    const { repo, svc, touched } = harness()
    const before = { ...repo.users.get(OFFICIAL) }
    const attempts = [
      () => svc.flag(OFFICIAL, { reason: "spam", actorId: "op-1" }),
      () => svc.flag(OFFICIAL.toUpperCase(), { reason: "spam", actorId: "op-1" }),
      () => svc.setStatus(OFFICIAL, { status: "banned", reason: null, actorId: "op-1" }),
      () => svc.setRole(OFFICIAL, { role: "gov_admin", actorId: "op-1" }),
      () => svc.setReportVerified(OFFICIAL, { value: true, actorId: "op-1" }),
    ]

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ httpStatus: 403 })
    }
    expect(repo.users.get(OFFICIAL)).toEqual(before)
    expect(repo.audits).toEqual([])
    expect(touched).toEqual([])
  })
})

describe("moderation remove refuses the official account as a user subject", () => {
  function harness() {
    const repo = new InMemoryModerationRepository()
    repo.now = NOW
    repo.userRoles.set(OFFICIAL, "citizen")
    const applied: string[] = []
    const svc = makeModerationService({
      repo,
      now: () => NOW,
      sessions: {
        applyStatus: (userId: string) => {
          applied.push(userId)
          return Promise.resolve(1)
        },
      },
    })
    return { repo, svc, applied }
  }

  it.each(["user", "profile"] as const)("leaves a %s item open with no suspension", async (subjectType) => {
    const { repo, svc, applied } = harness()
    repo.seedItem({ id: "MOD-1", subjectType, subjectId: OFFICIAL, status: "open" })

    await expect(svc.remove("MOD-1", { actorId: "op-1", reason: "abuse" })).rejects.toMatchObject({
      httpStatus: 403,
    })
    expect(repo.accountStatus.get(OFFICIAL)).toBeUndefined()
    expect(repo.items.get("MOD-1")?.status).toBe("open")
    expect(applied).toEqual([])
  })

  it("still removes a chat post the official account authored", async () => {
    const { repo, svc } = harness()
    repo.seedItem({ id: "MOD-2", subjectType: "chat", subjectId: "CHAT-1", status: "open" })

    await svc.remove("MOD-2", { actorId: "op-1", reason: "typo" })

    expect(repo.tombstoned.has("CHAT-1")).toBe(true)
  })
})
