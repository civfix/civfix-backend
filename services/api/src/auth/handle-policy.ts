/**
 * @handle write policy, shared by the in-memory and Postgres UserStore.updateProfile impls.
 *
 * The two stores enforce the SAME rules (format, uniqueness, rolling-30-day rename cooldown,
 * initial-set-leaves-the-clock-null) and used to carry near-verbatim copies that could silently
 * diverge. This is the single source of truth for that decision.
 *
 * Responsibility split: the ROUTE owns the reserved/slur/jurisdiction gate; the STORE owns format +
 * uniqueness + cooldown (this module).
 */

import { AppError, HANDLE_REGEX } from "@civfix/shared"
import { handleChangeableAtFrom } from "./stores.js"

export interface DecideHandleWriteInput {
  /** The user's current stored handle (null only for legacy rows pre-0026). */
  current: string | null
  /** The submitted handle from the profile PUT. */
  submitted: string
  /** Whether the user has finished first-run registration (drives initial-set vs real-rename). */
  profileComplete: boolean
  /** The user's current handle_changed_at clock (null = never renamed). */
  handleChangedAt: Date | null
  /** Whether the submitted handle is already taken by a DIFFERENT user (caller resolves uniqueness). */
  isTaken: boolean
  /** Current time, injectable for deterministic cooldown tests. */
  now: Date
}

/**
 * Whether the submitted handle changes the current one (case-insensitive). The name/bio editors re-send
 * the CURRENT handle every PUT, so an unchanged handle must be a no-op (no validation / no clock stamp).
 */
export function handleChanged(current: string | null, submitted: string): boolean {
  return (current ?? "").toLowerCase() !== submitted.toLowerCase()
}

export interface HandleWriteResult {
  /** The handle to persist. */
  handle: string
  /** The handle_changed_at to persist. */
  handleChangedAt: Date | null
}

/**
 * Decide the (handle, handleChangedAt) to write, or throw the appropriate AppError. Assumes the caller
 * already determined the write is a real change via {@link handleChanged} and resolved `isTaken`.
 */
export function decideHandleWrite(input: DecideHandleWriteInput): HandleWriteResult {
  // Trim ONCE and use that value for both the format check and the persisted handle: validating the
  // trimmed form while returning the raw one made " bob " pass and store the spaces, and that only
  // happened to be safe because the shared HandleSchema (.trim()) sanitizes upstream — a store-level
  // source of truth must not depend on route-level zod behavior.
  const submitted = input.submitted.trim()
  if (!HANDLE_REGEX.test(submitted)) {
    throw AppError.validation({ handle: "That username isn't a valid format." })
  }
  if (input.isTaken) {
    throw AppError.conflict("That username is taken.")
  }
  if (input.profileComplete) {
    // A real rename: enforce the rolling-30-day cooldown, then stamp the clock.
    const next = handleChangeableAtFrom(input.handleChangedAt, input.now)
    if (next !== null) {
      throw AppError.rateLimited(`You can change your username again on ${next}.`)
    }
    return { handle: submitted, handleChangedAt: input.now }
  }
  // Initial set during first-run completion: set the handle, leave the cooldown clock null.
  return { handle: submitted, handleChangedAt: null }
}
