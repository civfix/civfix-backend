import { AppError, MAX_EVENT_ADDRESS_LENGTH, isLocatedPrecision } from "@civfix/shared"
import type { EventAddressSource } from "@civfix/shared"
import type { AddressResolver } from "./address-resolver.js"

/**
 * Floor for a host-confirmed event address. Long enough to reject the accidental keystroke and the
 * lone punctuation mark, short enough to allow a genuinely terse one ("Pier 3").
 */
const MIN_EVENT_ADDRESS_LENGTH = 3

export interface EventAddressWrite {
  address: string | null
  addressSource: EventAddressSource | null
}

const NO_EVENT_ADDRESS: EventAddressWrite = { address: null, addressSource: null }

/**
 * The event address, with its provenance, for a create or an update.
 *
 * `addressSource` is the CLIENT-VERSION discriminator, and it has to be: `address` itself stays
 * optional on the wire so the TestFlight build in someone's pocket keeps working.
 *
 *   addressSource PRESENT  -> a new client. It resolved the pin, showed the line to the host, and the
 *                             host published with it on screen. That is the confirmation, so the
 *                             server only has to refuse a blank one; a client that sends a source
 *                             without an address has a bug, and storing it would produce an event
 *                             whose address is "verified" and empty.
 *   addressSource ABSENT   -> an old client. Whatever it sent in `address` is the host's own "name the
 *                             spot" text, so it is 'manual' (the same call migration 0179 makes for
 *                             existing rows). If it sent nothing, the shim resolves the pin and stores
 *                             'resolved': unverified, but an event with a street line beats an event
 *                             with "Meeting point", and only while old clients are still in the wild.
 *
 * The shim stores NOTHING when the ladder only reached `locality`: "Los Angeles, CA" is not a meeting
 * address, and writing it would dress up a non-answer as a host-provided one.
 *
 * `fromStoredEvent` marks the DUPLICATE path, whose pair did not come off the wire at all: it is this
 * server's own stored row, copied verbatim. The new-client length floor is a check on a client payload
 * and would reject a backfilled one-or-two-character address that the host has been running for
 * months. Slur checks still apply - they run over the whole input before this.
 */
export async function resolveEventAddress(
  input: {
    address?: string | undefined
    addressSource?: EventAddressSource | undefined
    lat: number
    lng: number
  },
  resolveAddress: AddressResolver | undefined,
  opts?: { fromStoredEvent?: boolean },
): Promise<EventAddressWrite> {
  if (input.addressSource !== undefined) {
    if (opts?.fromStoredEvent === true && input.address !== undefined) {
      return { address: input.address, addressSource: input.addressSource }
    }
    return { address: assertConfirmedAddress(input.address), addressSource: input.addressSource }
  }
  const typed = input.address?.trim() ?? ""
  if (typed.length > 0) return { address: typed, addressSource: "manual" }
  if (resolveAddress === undefined) return { ...NO_EVENT_ADDRESS }
  const resolved = await resolveAddress(input.lat, input.lng)
  if (resolved.address === null || !isLocatedPrecision(resolved.precision)) {
    return { ...NO_EVENT_ADDRESS }
  }
  return {
    address: resolved.address.slice(0, MAX_EVENT_ADDRESS_LENGTH),
    addressSource: "resolved",
  }
}

/** A new client that names a source must carry a real line with it. */
function assertConfirmedAddress(address: string | undefined): string {
  const trimmed = address?.trim() ?? ""
  if (trimmed.length < MIN_EVENT_ADDRESS_LENGTH) {
    throw AppError.validation({
      address: `must be at least ${MIN_EVENT_ADDRESS_LENGTH} characters`,
    })
  }
  return trimmed
}

/** The update-path twin of resolveEventAddress: same rules, but every field stays optional. */
export function eventAddressPatch(patch: {
  address?: string | undefined
  addressSource?: EventAddressSource | undefined
}): { address?: string | null; addressSource?: EventAddressSource | null } {
  if (patch.addressSource !== undefined) {
    return { address: assertConfirmedAddress(patch.address), addressSource: patch.addressSource }
  }
  if (patch.address === undefined) return {}
  const trimmed = patch.address.trim()
  return trimmed.length > 0
    ? { address: trimmed, addressSource: "manual" }
    : { ...NO_EVENT_ADDRESS }
}
