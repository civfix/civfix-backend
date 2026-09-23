import { AppError, MAX_EVENT_SLOTS, MIN_SLOT_DURATION_MINUTES } from "@civfix/shared"
import type { EventSlotInput } from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import type { DesiredSlot, EventSlotView } from "./cleanup-repository.types.js"
import type { EventWindow } from "./cleanup-rules.js"

const MS_PER_MINUTE = 60_000

const MIN_SLOT_DURATION_MS = MIN_SLOT_DURATION_MINUTES * MS_PER_MINUTE

interface SlotWindow {
  startsAt: Date | null
  endsAt: Date | null
}

function slotWindowOf(slot: EventSlotInput): SlotWindow {
  const startsAt = slot.startsAt != null ? new Date(slot.startsAt) : null
  const endsAt = slot.endsAt != null ? new Date(slot.endsAt) : null
  return { startsAt, endsAt }
}

function assertSlotInsideEvent(
  title: string,
  window: { startsAt: Date; endsAt: Date },
  event: EventWindow,
): void {
  if (event.endsAt === null) {
    throw AppError.validation({
      slots: "set an end time for the event before adding timed slots",
    })
  }
  if (window.startsAt < event.scheduledAt || window.endsAt > event.endsAt) {
    throw AppError.validation({
      slots: `slot "${title}" falls outside the event's start and end`,
    })
  }
  if (window.endsAt.getTime() - window.startsAt.getTime() < MIN_SLOT_DURATION_MS) {
    throw AppError.validation({
      slots: `slot "${title}" must last at least ${MIN_SLOT_DURATION_MINUTES} minutes`,
    })
  }
}

function slotIdentityKey(title: string, window: SlotWindow): string {
  return `${title.trim().toLowerCase()}|${window.startsAt?.getTime() ?? ""}|${window.endsAt?.getTime() ?? ""}`
}

export function toDesiredSlots(
  slots: EventSlotInput[],
  opts: { keepIds: boolean },
  window: EventWindow,
): DesiredSlot[] {
  if (slots.length > MAX_EVENT_SLOTS) {
    throw AppError.validation({ slots: `at most ${MAX_EVENT_SLOTS} slots may be listed` })
  }
  const seen = new Set<string>()
  for (const slot of slots) {
    const slotWindow = slotWindowOf(slot)
    const { startsAt, endsAt } = slotWindow
    if (startsAt !== null && endsAt !== null) {
      assertSlotInsideEvent(slot.title, { startsAt, endsAt }, window)
    }
    const key = slotIdentityKey(slot.title, slotWindow)
    if (seen.has(key)) {
      throw AppError.validation({ slots: `duplicate slot title: ${slot.title}` })
    }
    seen.add(key)
    assertNoSlur(slot.title, "slots")
    assertNoSlur(slot.description ?? null, "slots")
  }
  return slots.map((slot, index) => ({
    ...(opts.keepIds && slot.id !== undefined ? { id: slot.id } : {}),
    title: slot.title,
    description: slot.description ?? null,
    capacity: slot.capacity ?? null,
    ...slotWindowOf(slot),
    sortOrder: slot.sortOrder ?? index,
  }))
}

/** Stored timed slots must still fit when an edit moves the event window without resending them. */
export function assertTimedSlotsFitWindow(stored: EventSlotView[], window: EventWindow): void {
  const outside = stored.some(
    (slot) =>
      slot.startsAt !== null &&
      slot.endsAt !== null &&
      (window.endsAt === null || slot.startsAt < window.scheduledAt || slot.endsAt > window.endsAt),
  )
  if (outside) {
    throw AppError.validation({
      scheduledAt:
        "timed slots would fall outside the new start and end; update the slots in the same save",
    })
  }
}

export function assertKnownSlotIds(desired: DesiredSlot[], stored: EventSlotView[]): void {
  const existingSlotIds = new Set(stored.map((s) => s.id))
  for (const slot of desired) {
    if (slot.id !== undefined && !existingSlotIds.has(slot.id)) {
      throw AppError.validation({ slots: `unknown slot: ${slot.id}` })
    }
  }
}
