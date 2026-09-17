/**
 * Host-verified event addresses (cleanup-service).
 *
 * Events were never reverse-geocoded: `cleanups.address` held whatever the host typed into "name the
 * spot", or nothing. New clients now resolve the pin, show the line to the host and publish with it on
 * screen, and the server records WHICH of those happened. The whole design rests on one discriminator,
 * so it is what these tests pin:
 *
 *   `addressSource` PRESENT  = a new client. The host saw the line; the server only refuses a blank one.
 *   `addressSource` ABSENT   = an old client (the wire keeps `address` optional precisely so the build
 *                              in someone's pocket keeps working). Its text is 'manual'; its silence
 *                              triggers the compat shim.
 *
 * And the shim's own limit: it stores a resolved line only at a LOCATED rung. "Los Angeles, CA" is not
 * a meeting address, and writing it would dress a non-answer up as host-provided.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { makeCleanupService, type CleanupService } from "../../src/services/cleanup-service.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import type { AddressResolver } from "../../src/services/address-resolver.js"
import type { CreateCleanupRequest } from "@civfix/shared"

const HOST = "22222222-2222-2222-2222-222222222222"

let repo: InMemoryCleanupRepository

function baseInput(over: Partial<CreateCleanupRequest> = {}): CreateCleanupRequest {
  return {
    title: "Beach cleanup",
    type: "site",
    eventKind: "cleanup",
    lat: 34.0,
    lng: -118.49,
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    slots: [{ title: "Volunteers" }],
    ...over,
  }
}

/** A resolver that records its calls, so "did the shim even run" is assertable. */
function resolver(
  result: Awaited<ReturnType<AddressResolver>>,
): AddressResolver & { calls: number } {
  const fn = Object.assign(
    async (): Promise<Awaited<ReturnType<AddressResolver>>> => {
      fn.calls += 1
      return result
    },
    { calls: 0 },
  )
  return fn
}

const STREET = {
  address: "123 Imperial Hwy, Inglewood, CA",
  precision: "street",
  cityStateLabel: "Inglewood, CA",
} as const

const LOCALITY_ONLY = {
  address: "Los Angeles, CA",
  precision: "locality",
  cityStateLabel: "Los Angeles, CA",
} as const

function serviceWith(resolveAddress?: AddressResolver): CleanupService {
  return makeCleanupService({
    tickets: TEST_TICKET_SIGNER,
    repo,
    counters: new InMemoryCounterStore(),
    ...(resolveAddress !== undefined ? { resolveAddress } : {}),
  })
}

beforeEach(() => {
  repo = new InMemoryCleanupRepository()
  repo.seedUser({ id: HOST, displayName: "Holly Host", handle: "holly" })
})

describe("createCleanup: a NEW client's confirmed address", () => {
  it("stores the host-confirmed line with its source and serves both on the DTO", async () => {
    const resolve = resolver(STREET)
    const dto = await serviceWith(resolve).createCleanup(
      baseInput({ address: "123 Imperial Hwy, Inglewood, CA", addressSource: "resolved" }),
      HOST,
    )

    expect(dto.address).toBe("123 Imperial Hwy, Inglewood, CA")
    expect(dto.addressSource).toBe("resolved")
    // The host already confirmed it; the server has nothing to resolve.
    expect(resolve.calls).toBe(0)
  })

  it("keeps 'edited' and 'manual' verbatim - the server never re-judges a host's own wording", async () => {
    const edited = await serviceWith().createCleanup(
      baseInput({ address: "Boathouse dock, 123 Imperial Hwy", addressSource: "edited" }),
      HOST,
    )
    expect(edited.addressSource).toBe("edited")

    const manual = await serviceWith().createCleanup(
      baseInput({ address: "North gate, by the flagpole", addressSource: "manual" }),
      HOST,
    )
    expect(manual.addressSource).toBe("manual")
  })

  it("trims before storing", async () => {
    const dto = await serviceWith().createCleanup(
      baseInput({ address: "   North gate   ", addressSource: "manual" }),
      HOST,
    )
    expect(dto.address).toBe("North gate")
  })

  it("REFUSES a source with a blank or too-short address - that combination is a client bug", async () => {
    const service = serviceWith()
    await expect(
      service.createCleanup(baseInput({ address: "   ", addressSource: "manual" }), HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await expect(
      service.createCleanup(baseInput({ address: "NW", addressSource: "manual" }), HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await expect(
      service.createCleanup(baseInput({ addressSource: "resolved" }), HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    expect(repo.cleanups.size).toBe(0)
  })
})

describe("createCleanup: the OLD-client compat shim", () => {
  it("treats an old client's text as the host's own, so it is 'manual'", async () => {
    const resolve = resolver(STREET)
    const dto = await serviceWith(resolve).createCleanup(baseInput({ address: "Boathouse dock" }), HOST)

    expect(dto.address).toBe("Boathouse dock")
    expect(dto.addressSource).toBe("manual")
    expect(resolve.calls).toBe(0)
  })

  it("resolves the pin when an old client sent nothing at all, and marks it 'resolved'", async () => {
    const resolve = resolver(STREET)
    const dto = await serviceWith(resolve).createCleanup(baseInput(), HOST)

    expect(resolve.calls).toBe(1)
    expect(dto.address).toBe("123 Imperial Hwy, Inglewood, CA")
    expect(dto.addressSource).toBe("resolved")
  })

  it("stores NOTHING when the ladder only reached locality - a city is not a meeting address", async () => {
    const dto = await serviceWith(resolver(LOCALITY_ONLY)).createCleanup(baseInput(), HOST)

    expect(dto.address).toBeNull()
    expect(dto.addressSource).toBeNull()
  })

  it("stores nothing when the resolve came up empty, and still creates the event", async () => {
    const dto = await serviceWith(
      resolver({ address: null, precision: null, cityStateLabel: "" }),
    ).createCleanup(baseInput(), HOST)

    expect(dto.address).toBeNull()
    expect(dto.addressSource).toBeNull()
    expect(repo.cleanups.has(dto.id)).toBe(true)
  })

  it("is a no-op with no resolver wired (the pre-0.51.0 behavior, unchanged)", async () => {
    const dto = await serviceWith().createCleanup(baseInput(), HOST)
    expect(dto.address).toBeNull()
    expect(dto.addressSource).toBeNull()
  })
})

describe("updateCleanup: the same rules on the edit path", () => {
  it("persists a new client's amended line and flips the source to 'edited'", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "123 Imperial Hwy, Inglewood, CA", addressSource: "resolved" }),
      HOST,
    )

    const updated = await service.updateCleanup(
      created.id,
      { address: "Boathouse dock, 123 Imperial Hwy", addressSource: "edited" },
      HOST,
    )

    expect(updated.address).toBe("Boathouse dock, 123 Imperial Hwy")
    expect(updated.addressSource).toBe("edited")
  })

  it("REFUSES to blank out an address that arrives with a source", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "North gate", addressSource: "manual" }),
      HOST,
    )

    await expect(
      service.updateCleanup(created.id, { address: "", addressSource: "manual" }, HOST),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("demotes an old client's edit to 'manual' - it typed the text itself", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "123 Imperial Hwy, Inglewood, CA", addressSource: "resolved" }),
      HOST,
    )

    const updated = await service.updateCleanup(created.id, { address: "Boathouse dock" }, HOST)

    expect(updated.address).toBe("Boathouse dock")
    expect(updated.addressSource).toBe("manual")
  })

  it("an old client clearing the field clears the source with it", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "North gate", addressSource: "manual" }),
      HOST,
    )

    const updated = await service.updateCleanup(created.id, { address: "" }, HOST)

    expect(updated.address).toBeNull()
    expect(updated.addressSource).toBeNull()
  })

  it("leaves both alone when the patch does not mention the address", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "North gate", addressSource: "manual" }),
      HOST,
    )

    const updated = await service.updateCleanup(created.id, { title: "Renamed sweep" }, HOST)

    expect(updated.address).toBe("North gate")
    expect(updated.addressSource).toBe("manual")
  })
})

describe("duplicateCleanup", () => {
  it("carries the verified address and its provenance over as a pair", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "123 Imperial Hwy, Inglewood, CA", addressSource: "edited" }),
      HOST,
    )

    const copy = await service.duplicateCleanup(HOST, {
      id: created.id,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 3_600_000).toISOString(),
      includeTicketTypes: false,
      includeQuestions: false,
      includePage: false,
    })

    expect(copy.id).not.toBe(created.id)
    expect(copy.address).toBe("123 Imperial Hwy, Inglewood, CA")
    // NOT demoted to 'manual': a duplicate is the same place at a new time.
    expect(copy.addressSource).toBe("edited")
  })

  it("copies a stored address that is SHORTER than the new-client floor, instead of refusing it", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(
      baseInput({ address: "North gate", addressSource: "manual" }),
      HOST,
    )
    // What 0175's backfill leaves on a legacy event whose host typed two characters.
    repo.cleanups.get(created.id)!.address = "NW"

    const copy = await service.duplicateCleanup(HOST, {
      id: created.id,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 3_600_000).toISOString(),
      includeTicketTypes: false,
      includeQuestions: false,
      includePage: false,
    })

    expect(copy.address).toBe("NW")
    expect(copy.addressSource).toBe("manual")
  })

  it("duplicating an addressless legacy event stays addressless", async () => {
    const service = serviceWith()
    const created = await service.createCleanup(baseInput(), HOST)

    const copy = await service.duplicateCleanup(HOST, {
      id: created.id,
      scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 3_600_000).toISOString(),
      includeTicketTypes: false,
      includeQuestions: false,
      includePage: false,
    })

    expect(copy.address).toBeNull()
    expect(copy.addressSource).toBeNull()
  })
})
