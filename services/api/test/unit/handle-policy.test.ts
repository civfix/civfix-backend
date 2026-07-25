/**
 * src/auth/handle-policy.ts — the @handle write policy (auth finding #4 / D33).
 *
 * The module exists ONLY to stop the in-memory and Postgres UserStore.updateProfile impls from carrying
 * near-verbatim copies of the same rules and silently diverging — yet nothing exercised the rules it
 * centralizes: the rolling-30-day rename cooldown, the exact-30-days boundary, the
 * initial-set-leaves-the-clock-null rule, or the unchanged-handle no-op.
 *
 * Two layers are asserted:
 *   1. `handleChanged` + `decideHandleWrite` directly, with an injected clock (the policy itself);
 *   2. `InMemoryUserStore.updateProfile` end-to-end, proving the store really DELEGATES to the policy
 *      (a store that quietly reimplemented it would pass layer 1 and fail layer 2).
 */

import { describe, it, expect } from "vitest"
import { AppError } from "@civfix/shared"
import { decideHandleWrite, handleChanged } from "../../src/auth/handle-policy.js"
import { HANDLE_RENAME_COOLDOWN_MS, InMemoryUserStore } from "../../src/auth/stores.js"

const NOW = new Date("2026-07-24T12:00:00.000Z")

/** decideHandleWrite input with the defaults for a completed profile doing a real rename. */
function input(over: Partial<Parameters<typeof decideHandleWrite>[0]> = {}) {
  return {
    current: "oldname",
    submitted: "newname",
    profileComplete: true,
    handleChangedAt: null as Date | null,
    isTaken: false,
    now: NOW,
    ...over,
  }
}

describe("handleChanged (the unchanged-handle no-op predicate)", () => {
  it("is FALSE for a case-only resubmit, so the name/bio editors never trip the cooldown", () => {
    // Every profile PUT re-sends the current handle; treating a case-only resubmit as a rename would burn
    // the user's 30-day budget for editing their bio.
    expect(handleChanged("Jane_Doe", "jane_doe")).toBe(false)
    expect(handleChanged("jane_doe", "JANE_DOE")).toBe(false)
    expect(handleChanged("jane_doe", "jane_doe")).toBe(false)
  })

  it("is TRUE for a real change, and for the initial set from a legacy null handle", () => {
    expect(handleChanged("jane_doe", "jane_doe2")).toBe(true)
    expect(handleChanged(null, "jane_doe")).toBe(true)
    // Null current + empty submitted is the one null case that is NOT a change.
    expect(handleChanged(null, "")).toBe(false)
  })
})

describe("decideHandleWrite: initial set (first-run completion)", () => {
  it("sets the handle and leaves the cooldown clock NULL, so the first real rename is free", () => {
    expect(decideHandleWrite(input({ current: null, submitted: "jane_doe", profileComplete: false })))
      .toEqual({ handle: "jane_doe", handleChangedAt: null })
  })

  it("does not stamp the clock even when the user already had a handle (placeholder -> chosen)", () => {
    // Registration hands out a `userabc123…` placeholder; replacing it during first-run is still the
    // INITIAL set, not a rename.
    const result = decideHandleWrite(
      input({ current: "userabc123def", submitted: "jane_doe", profileComplete: false }),
    )
    expect(result).toEqual({ handle: "jane_doe", handleChangedAt: null })
  })
})

describe("decideHandleWrite: the rolling 30-day rename cooldown", () => {
  it("STAMPS the clock on a first real rename (profileComplete, no prior clock)", () => {
    const result = decideHandleWrite(input({ handleChangedAt: null }))
    expect(result.handle).toBe("newname")
    expect(result.handleChangedAt).toEqual(NOW)
  })

  it("throws RATE_LIMITED naming the ISO unlock date for a rename INSIDE the 30-day window", () => {
    const lastRename = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000)
    const unlockAt = new Date(lastRename.getTime() + HANDLE_RENAME_COOLDOWN_MS).toISOString()
    let thrown: unknown
    try {
      decideHandleWrite(input({ handleChangedAt: lastRename }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect(thrown).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429 })
    expect((thrown as AppError).message).toBe(`You can change your username again on ${unlockAt}.`)
    // The date the user is told is the real unlock instant: 30 days after the last rename
    // (2026-06-25T12:00Z), i.e. one day out from "now" — not 30 days out from now.
    expect(unlockAt).toBe("2026-07-25T12:00:00.000Z")
  })

  it("throws one millisecond BEFORE the boundary and passes AT the boundary (>, not >=)", () => {
    const atBoundary = new Date(NOW.getTime() - HANDLE_RENAME_COOLDOWN_MS)
    const oneMsShort = new Date(atBoundary.getTime() + 1)

    expect(() => decideHandleWrite(input({ handleChangedAt: oneMsShort }))).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED" }),
    )
    // Exactly 30 days later the rename is allowed and re-stamps the clock to now.
    expect(decideHandleWrite(input({ handleChangedAt: atBoundary }))).toEqual({
      handle: "newname",
      handleChangedAt: NOW,
    })
  })

  it("passes AFTER the boundary and re-stamps the clock to now (not to the old value)", () => {
    const longAgo = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000)
    expect(decideHandleWrite(input({ handleChangedAt: longAgo }))).toEqual({
      handle: "newname",
      handleChangedAt: NOW,
    })
  })

  it("does NOT apply the cooldown to an incomplete profile, even with a stamped clock", () => {
    // The gate is profileComplete; a half-registered account cannot be locked out of picking a handle.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
    expect(
      decideHandleWrite(input({ profileComplete: false, handleChangedAt: yesterday })),
    ).toEqual({ handle: "newname", handleChangedAt: null })
  })
})

describe("decideHandleWrite: format + uniqueness gates run BEFORE the cooldown", () => {
  it("throws VALIDATION with a `handle` field for a format violation", () => {
    for (const bad of ["ab", "a".repeat(21), "has spaces", "dash-not-allowed", "dots.no", ""]) {
      let thrown: unknown
      try {
        decideHandleWrite(input({ submitted: bad }))
      } catch (err) {
        thrown = err
      }
      expect(thrown, bad).toMatchObject({
        code: "VALIDATION",
        httpStatus: 422,
        fields: { handle: "That username isn't a valid format." },
      })
    }
  })

  it("throws CONFLICT 409 when the handle is taken by a different user", () => {
    expect(() => decideHandleWrite(input({ isTaken: true }))).toThrowError(
      expect.objectContaining({ code: "CONFLICT", httpStatus: 409 }),
    )
  })

  it("reports the FORMAT error (not the cooldown) when both would fail", () => {
    // Ordering matters for the message the user sees: telling a coach "wait until August" for a handle
    // that could never be accepted is a dead end.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
    expect(() =>
      decideHandleWrite(input({ submitted: "!!", handleChangedAt: yesterday })),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION" }))
  })

  it("reports the CONFLICT (not the cooldown) when both would fail", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
    expect(() =>
      decideHandleWrite(input({ isTaken: true, handleChangedAt: yesterday })),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }))
  })
})

describe("decideHandleWrite: trim normalization (LOW/readability finding)", () => {
  it("PERSISTS the trimmed handle, not the submitted one", () => {
    // The old code validated `submitted.trim()` but returned `submitted` verbatim, so " bob " passed the
    // format check and stored the spaces. It only happened to be safe because the shared HandleSchema
    // (.trim()) sanitizes upstream — a store-level source of truth must not depend on route-level zod.
    expect(decideHandleWrite(input({ submitted: "  bob  " })).handle).toBe("bob")
    expect(decideHandleWrite(input({ submitted: "\tjane_doe\n" })).handle).toBe("jane_doe")
  })

  it("still rejects a handle that is invalid AFTER trimming", () => {
    expect(() => decideHandleWrite(input({ submitted: "  ab  " }))).toThrowError(
      expect.objectContaining({ code: "VALIDATION" }),
    )
    expect(() => decideHandleWrite(input({ submitted: "   " }))).toThrowError(
      expect.objectContaining({ code: "VALIDATION" }),
    )
  })

  it("trims on the initial-set path too", () => {
    expect(
      decideHandleWrite(input({ current: null, submitted: " jane_doe ", profileComplete: false })),
    ).toEqual({ handle: "jane_doe", handleChangedAt: null })
  })
})

describe("InMemoryUserStore.updateProfile DELEGATES to the policy (no divergent copy)", () => {
  /** A store on a mutable clock, plus a user mid-registration (profileComplete: false). */
  async function seed() {
    const clock = { value: NOW }
    const store = new InMemoryUserStore({ now: () => clock.value })
    const user = await store.create("coach@example.org", {
      displayName: "Coach",
      handle: "userplaceholder",
      emailVerified: true,
    })
    return { clock, store, user }
  }

  it("initial set leaves handle_changed_at null; the next rename stamps it; a second rename 429s", async () => {
    const { clock, store, user } = await seed()

    const initial = await store.updateProfile(user.id, { handle: "coach_alex", displayName: "Coach" })
    expect(initial.handle).toBe("coach_alex")
    expect(initial.handleChangedAt).toBeNull()
    expect(initial.profileComplete).toBe(true)

    const renamed = await store.updateProfile(user.id, { handle: "coach_ax", displayName: "Coach" })
    expect(renamed.handle).toBe("coach_ax")
    expect(renamed.handleChangedAt).toEqual(NOW)

    clock.value = new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000)
    await expect(
      store.updateProfile(user.id, { handle: "coach_a", displayName: "Coach" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", httpStatus: 429 })
    // The rejected write changed nothing.
    expect((await store.findById(user.id))!.handle).toBe("coach_ax")

    clock.value = new Date(renamed.handleChangedAt!.getTime() + HANDLE_RENAME_COOLDOWN_MS)
    const again = await store.updateProfile(user.id, { handle: "coach_a", displayName: "Coach" })
    expect(again.handle).toBe("coach_a")
    expect(again.handleChangedAt).toEqual(clock.value)
  })

  it("a case-only resubmit inside the cooldown is a NO-OP (bio edits are not renames)", async () => {
    const { clock, store, user } = await seed()
    await store.updateProfile(user.id, { handle: "coach_alex", displayName: "Coach" })
    const renamed = await store.updateProfile(user.id, { handle: "coach_ax", displayName: "Coach" })

    clock.value = new Date(NOW.getTime() + 60 * 1000)
    // Same handle, different case, new display name: must succeed and must NOT re-stamp the clock.
    const edited = await store.updateProfile(user.id, {
      handle: "Coach_AX",
      displayName: "Coach Alex Rivera",
    })
    expect(edited.displayName).toBe("Coach Alex Rivera")
    expect(edited.handle).toBe("coach_ax") // the stored casing is preserved, not overwritten
    expect(edited.handleChangedAt).toEqual(renamed.handleChangedAt)
  })

  it("409s when another user already holds the handle, and leaves the caller's handle intact", async () => {
    const { store, user } = await seed()
    await store.updateProfile(user.id, { handle: "coach_alex", displayName: "Coach" })
    const other = await store.create("other@example.org", {
      displayName: "Other",
      handle: "taken_name",
    })
    expect(other.handle).toBe("taken_name")

    await expect(
      store.updateProfile(user.id, { handle: "taken_name", displayName: "Coach" }),
    ).rejects.toMatchObject({ code: "CONFLICT", httpStatus: 409 })
    expect((await store.findById(user.id))!.handle).toBe("coach_alex")
  })
})
