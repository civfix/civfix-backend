import { describe, it, expect } from "vitest"
import {
  InMemoryUserStore,
  generateTombstoneHandle,
  generatePlaceholderHandle,
} from "../../src/auth/stores.js"
import { isReservedHandle } from "../../src/auth/reserved-handles.js"

describe("generateTombstoneHandle (F031)", () => {
  it("emits a handle that is UNCLAIMABLE via the reserved-handle gate", () => {
    for (let i = 0; i < 50; i++) {
      const handle = generateTombstoneHandle()
      expect(handle).toMatch(/^deleted_[0-9a-f]{12}$/)
      expect(isReservedHandle(handle)).toBe(true)
      expect(isReservedHandle(handle.toUpperCase())).toBe(true)
    }
  })

  it("is independent of any user id (unlike the deterministic placeholder)", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    const a = generateTombstoneHandle()
    const b = generateTombstoneHandle()
    expect(a).not.toBe(b)
    expect(a).not.toBe(generatePlaceholderHandle(id))
  })
})

describe("InMemoryUserStore erasure + account status (F031, F005)", () => {
  it("softDeleteAndAnonymize writes a tombstone handle, not the guessable placeholder", async () => {
    const users = new InMemoryUserStore()
    const created = await users.create("jane@example.com", { displayName: "Jane" })
    const tombstoned = await users.softDeleteAndAnonymize(created.id)
    expect(tombstoned.handle).toMatch(/^deleted_/)
    expect(tombstoned.handle).not.toBe(generatePlaceholderHandle(created.id))
    expect(tombstoned.deletedAt).not.toBeNull()
    expect(tombstoned.email).toBeNull()
  })

  it("accountStatus defaults to active and reflects a set ban", async () => {
    const users = new InMemoryUserStore()
    const created = await users.create("banme@example.com", { displayName: "Ban" })
    expect(await users.accountStatus(created.id)).toBe("active")
    users.setAccountStatus(created.id, "banned")
    expect(await users.accountStatus(created.id)).toBe("banned")
    expect(await users.accountStatus("unknown-id")).toBe("active")
  })
})
