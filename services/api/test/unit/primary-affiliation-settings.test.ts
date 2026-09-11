import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryUserStore, PRIMARY_ORGANIZATION_NOT_A_MEMBER } from "../../src/auth/stores.js"
import { toUserDTO } from "../../src/auth/auth-services.js"

const ORG_A = "11111111-1111-4111-8111-111111111111"
const ORG_B = "22222222-2222-4222-8222-222222222222"

let store: InMemoryUserStore

beforeEach(() => {
  store = new InMemoryUserStore()
})

async function seeded(): Promise<string> {
  const user = await store.create("ivy@x.org", { displayName: "Ivy" })
  store.seedMembership(user.id, ORG_A)
  return user.id
}

describe("updateSettings: primaryOrganizationId", () => {
  it("starts null, so the affiliation badge falls back to the earliest membership", async () => {
    const id = await seeded()
    const user = await store.findById(id)
    expect(user?.primaryOrganizationId).toBeNull()
  })

  it("pins an organization the user is a member of", async () => {
    const id = await seeded()
    const updated = await store.updateSettings(id, { primaryOrganizationId: ORG_A })
    expect(updated.primaryOrganizationId).toBe(ORG_A)
  })

  it("422s an organization the user does not belong to, and changes nothing", async () => {
    const id = await seeded()
    await expect(
      store.updateSettings(id, { primaryOrganizationId: ORG_B }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { primaryOrganizationId: PRIMARY_ORGANIZATION_NOT_A_MEMBER },
    })
    expect((await store.findById(id))?.primaryOrganizationId).toBeNull()
  })

  it("accepts null as the reset to automatic, with no membership check", async () => {
    const id = await seeded()
    await store.updateSettings(id, { primaryOrganizationId: ORG_A })
    const cleared = await store.updateSettings(id, { primaryOrganizationId: null })
    expect(cleared.primaryOrganizationId).toBeNull()
  })

  it("leaves the pin alone when the patch does not mention it", async () => {
    const id = await seeded()
    await store.updateSettings(id, { primaryOrganizationId: ORG_A })
    const updated = await store.updateSettings(id, { allowDirectMessages: false })
    expect(updated.primaryOrganizationId).toBe(ORG_A)
    expect(updated.allowDirectMessages).toBe(false)
  })

  it("is cleared by account erasure along with the rest of the identity", async () => {
    const id = await seeded()
    await store.updateSettings(id, { primaryOrganizationId: ORG_A })
    const erased = await store.softDeleteAndAnonymize(id)
    expect(erased.primaryOrganizationId).toBeNull()
  })
})

describe("toUserDTO", () => {
  it("echoes the stored pin so the settings picker renders without a second call", async () => {
    const id = await seeded()
    const updated = await store.updateSettings(id, { primaryOrganizationId: ORG_A })
    expect(toUserDTO(updated).primaryOrganizationId).toBe(ORG_A)
  })

  it("echoes null when nothing is pinned", async () => {
    const id = await seeded()
    const user = await store.findById(id)
    expect(toUserDTO(user!).primaryOrganizationId).toBeNull()
  })
})
