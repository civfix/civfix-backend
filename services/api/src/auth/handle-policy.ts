/**
 * @handle write policy shared by the in-memory and Postgres UserStore.updateProfile, so the two cannot
 * drift. The route owns the reserved/slur/jurisdiction gate; the store owns format, uniqueness and the
 * rename cooldown.
 */

import { AppError, HANDLE_REGEX } from "@civfix/shared"
import { handleChangeableAtFrom } from "./stores.js"

export interface DecideHandleWriteInput {
  /** Null only for legacy rows from before migration 0026. */
  current: string | null
  submitted: string
  /** Drives initial set vs real rename. */
  profileComplete: boolean
  /** Null means never renamed. */
  handleChangedAt: Date | null
  /** Taken by a different user; the caller resolves uniqueness. */
  isTaken: boolean
  now: Date
}

/**
 * The name/bio editors re-send the current handle on every PUT, so an unchanged handle must be a no-op:
 * no validation and no clock stamp.
 */
export function handleChanged(current: string | null, submitted: string): boolean {
  return (current ?? "").toLowerCase() !== submitted.toLowerCase()
}

export interface HandleWriteResult {
  handle: string
  handleChangedAt: Date | null
}

/** The caller has already established a real change via {@link handleChanged} and resolved `isTaken`. */
export function decideHandleWrite(input: DecideHandleWriteInput): HandleWriteResult {
  // Trim once and use that value for both the format check and the persisted handle: a store-level source
  // of truth must not depend on the route's zod `.trim()` to keep " bob " from being stored with spaces.
  const submitted = input.submitted.trim()
  if (!HANDLE_REGEX.test(submitted)) {
    throw AppError.validation({ handle: "That username isn't a valid format." })
  }
  if (input.isTaken) {
    throw AppError.conflict("That username is taken.")
  }
  if (input.profileComplete) {
    // Only a real rename is subject to the rolling 30-day cooldown.
    const next = handleChangeableAtFrom(input.handleChangedAt, input.now)
    if (next !== null) {
      throw AppError.rateLimited(`You can change your username again on ${next}.`)
    }
    return { handle: submitted, handleChangedAt: input.now }
  }
  // The initial set during first-run completion leaves the cooldown clock null.
  return { handle: submitted, handleChangedAt: null }
}
