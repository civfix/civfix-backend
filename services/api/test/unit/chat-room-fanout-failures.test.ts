import { describe, it, expect, vi } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import { runChatRoomFanout } from "../../src/services/chat-fanout-jobs.js"
import {
  makeRoomFanoutNotifier,
  ROOM_FANOUT_SPEC,
  type RoomFanoutNotifierDeps,
} from "../../src/services/chat-room-fanout-notifier.js"

const ACTOR = "dddddddd-dddd-dddd-dddd-dddddddddddd"
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ROOM = "11111111-1111-1111-1111-111111111111"

function message(): ChatMessageDTO {
  return {
    id: "m-1",
    cleanupId: ROOM,
    roomKind: "group",
    from: { id: ACTOR, name: "Dana", followers: 0, following: 0, isFollowing: false },
    body: "hi",
    kind: "text",
    reactions: [],
    mentions: [],
    createdAt: new Date().toISOString(),
  }
}

function failingDeps(logger?: RoomFanoutNotifierDeps["logger"]): RoomFanoutNotifierDeps {
  return {
    notificationService: {
      createNotifications: () => Promise.reject(new Error("notifications table unavailable")),
    },
    listMemberIds: () => Promise.resolve([ACTOR, A]),
    isMuted: () => Promise.resolve(false),
    roomKey: (id) => `group:${id}`,
    isBlockedEitherWay: () => Promise.resolve(false),
    ...(logger !== undefined ? { logger } : {}),
  }
}

describe("room fan-out bell write failures", () => {
  it("fail the chat.room.fanout job so pg-boss retries it instead of completing with no bells", async () => {
    const deps = failingDeps()

    await expect(
      runChatRoomFanout(
        {
          loadMessage: () => Promise.resolve(message()),
          fanoutDeps: { group: deps, report: deps },
        },
        { kind: "group", roomId: ROOM, messageId: "m-1" },
      ),
    ).rejects.toThrow("notifications table unavailable")
  })

  it("are logged on the inline path, which stays best-effort for the sender", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, failingDeps(logger))

    await expect(notify(ROOM, message())).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "group" }),
      expect.stringMatching(/fan-out failed/),
    )
  })

  it("log a failed mute or block batch lookup before falling back", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const notify = makeRoomFanoutNotifier(ROOM_FANOUT_SPEC.group, {
      ...failingDeps(logger),
      notificationService: { createNotifications: () => Promise.resolve() },
      mutedUserIdsFor: () => Promise.reject(new Error("mutes down")),
      blockedIdsFor: () => Promise.resolve(new Set<string>()),
    })

    await notify(ROOM, message())

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "group" }),
      expect.stringMatching(/mute lookup failed/),
    )
  })
})
