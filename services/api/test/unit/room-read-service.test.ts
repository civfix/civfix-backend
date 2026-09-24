import { describe, it, expect, vi } from "vitest"
import { makeMarkRoomRead } from "../../src/services/room-read-service.js"
import type { ConversationBellKind } from "../../src/services/conversation-bell.js"

const ROOM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const USER = "11111111-1111-1111-1111-111111111111"
const AT = new Date("2026-06-01T12:00:00.000Z")

function harness() {
  const cleanup = vi.fn(() => Promise.resolve())
  const dm = vi.fn(() => Promise.resolve())
  const report = vi.fn(() => Promise.resolve())
  const group = vi.fn(() => Promise.resolve())
  const bells: Array<[ConversationBellKind, string, string]> = []
  const markRoomRead = makeMarkRoomRead({
    cleanup,
    dm,
    report,
    group,
    clearBell: (kind, roomId, userId) => {
      bells.push([kind, roomId, userId])
      return Promise.resolve()
    },
    now: () => AT,
  })
  return { markRoomRead, stores: { cleanup, dm, report, group }, bells }
}

describe("makeMarkRoomRead", () => {
  it("advances ONLY the addressed family's watermark, stamping the injected clock", async () => {
    for (const kind of ["cleanup", "dm", "report", "group"] as const) {
      const { markRoomRead, stores } = harness()
      await markRoomRead(kind, ROOM, USER)
      expect(stores[kind]).toHaveBeenCalledTimes(1)
      expect(stores[kind]).toHaveBeenCalledWith(ROOM, USER, AT)
      for (const other of ["cleanup", "dm", "report", "group"] as const) {
        if (other !== kind) expect(stores[other]).not.toHaveBeenCalled()
      }
    }
  })

  it("clears the room's bells for the reader, on every kind", async () => {
    for (const kind of ["cleanup", "dm", "report", "group"] as const) {
      const { markRoomRead, bells } = harness()
      await markRoomRead(kind, ROOM, USER)
      expect(bells).toEqual([[kind, ROOM, USER]])
    }
  })

  it("is a no-op (never a throw) for a family with no store wired, and still clears its bells", async () => {
    const bells: Array<[ConversationBellKind, string, string]> = []
    const markRoomRead = makeMarkRoomRead({
      clearBell: (kind, roomId, userId) => {
        bells.push([kind, roomId, userId])
        return Promise.resolve()
      },
    })
    await expect(markRoomRead("group", ROOM, USER)).resolves.toBeUndefined()
    expect(bells).toEqual([["group", ROOM, USER]])
  })

  it("works with no bell clearer at all (a lane wired without notifications)", async () => {
    const cleanup = vi.fn(() => Promise.resolve())
    const markRoomRead = makeMarkRoomRead({ cleanup, now: () => AT })
    await markRoomRead("cleanup", ROOM, USER)
    expect(cleanup).toHaveBeenCalledWith(ROOM, USER, AT)
  })
})
