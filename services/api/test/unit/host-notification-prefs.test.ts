import { describe, expect, it } from "vitest"
import { NotificationPrefsDTOSchema } from "@civfix/contract"
import { DEFAULT_PREFS, toPrefsDTO } from "../../src/services/notification-helpers.js"

describe("hostBroadcasts preference", () => {
  it("defaults to on", () => {
    expect(DEFAULT_PREFS.hostBroadcasts).toBe(true)
    expect(toPrefsDTO(DEFAULT_PREFS).hostBroadcasts).toBe(true)
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
