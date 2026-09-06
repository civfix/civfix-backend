import { describe, expect, it } from "vitest"
import { NotificationPrefsDTOSchema } from "@civfix/shared"
import {
  DEFAULT_PREFS,
  toPrefsDTO,
  typeAllowedByPrefs,
} from "../../src/services/notification-helpers.js"

describe("hostBroadcasts preference", () => {
  it("defaults to on", () => {
    expect(DEFAULT_PREFS.hostBroadcasts).toBe(true)
    expect(toPrefsDTO(DEFAULT_PREFS).hostBroadcasts).toBe(true)
  })

  it("gates the event_broadcast push type", () => {
    expect(typeAllowedByPrefs("event_broadcast", DEFAULT_PREFS)).toBe(true)
    expect(typeAllowedByPrefs("event_broadcast", { ...DEFAULT_PREFS, hostBroadcasts: false })).toBe(
      false,
    )
  })

  it("does not gate any other type", () => {
    const off = { ...DEFAULT_PREFS, hostBroadcasts: false }
    expect(typeAllowedByPrefs("cleanup_cancelled", off)).toBe(true)
    expect(typeAllowedByPrefs("system", off)).toBe(true)
    expect(typeAllowedByPrefs("report_update", off)).toBe(true)
  })

  it("still respects the master push switch", () => {
    expect(typeAllowedByPrefs("event_broadcast", { ...DEFAULT_PREFS, push: false })).toBe(false)
  })

  it("produces a DTO the contract accepts", () => {
    expect(NotificationPrefsDTOSchema.parse(toPrefsDTO(DEFAULT_PREFS)).hostBroadcasts).toBe(true)
  })

  it("defaults hostBroadcasts when an older stored prefs shape is parsed", () => {
    const parsed = NotificationPrefsDTOSchema.parse({
      push: true,
      cleanupChat: true,
      reportUpdates: true,
      follows: true,
      mentions: true,
      postInteractions: true,
    })
    expect(parsed.hostBroadcasts).toBe(true)
  })
})
