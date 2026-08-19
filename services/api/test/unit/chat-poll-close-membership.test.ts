import { describe, expect, it, vi } from "vitest"
import { AppError } from "@civfix/shared"
import type { ChatMessageDTO } from "@civfix/shared"
import {
  makeChatPollService,
  type ChatPollServiceDeps,
} from "../../src/services/chat-poll-service.js"


const CLEANUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const POLL_MSG = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
const AUTHOR = "cccccccc-cccc-cccc-cccc-cccccccccccc"

const pollDto = (): ChatMessageDTO => ({
  id: POLL_MSG,
  cleanupId: CLEANUP,
  kind: "poll",
  createdAt: "2026-06-01T12:00:00.000Z",
  reactions: [],
  mentions: [],
})

interface Opts {
  isMember?: boolean
  isModerator?: boolean
}

function makeService(opts: Opts) {
  const close = vi.fn(() => Promise.resolve())
  const deps = {
    chat: {
      findMessageMeta: () =>
        Promise.resolve({
          id: POLL_MSG,
          kind: "poll",
          deletedAt: null,
          cleanupId: CLEANUP,
          reportId: null,
          groupId: null,
        }),
      findMessage: () => Promise.resolve(pollDto()),
    },
    chatPolls: {
      findPollMeta: () => Promise.resolve({ createdBy: AUTHOR, closedAt: null }),
      close,
    },
    canSend: () => Promise.resolve(true),
    isMember: () => Promise.resolve(opts.isMember ?? false),
    isModerator: () => Promise.resolve(opts.isModerator ?? false),
    newId: () => POLL_MSG,
    broadcastMessage: () => {},
    broadcastUpdate: () => {},
    notifyRoom: () => {},
  } as unknown as ChatPollServiceDeps
  return { svc: makeChatPollService(deps), close }
}

async function statusOf(run: () => Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await run()
    return { status: 200 }
  } catch (err) {
    if (err instanceof AppError) return { status: err.httpStatus, code: err.fields?.["code"] as string }
    throw err
  }
}

describe("F047 — closePoll requires room membership on the author branch", () => {
  it("an author who is NOT a member and NOT a moderator is refused (403 poll_close_forbidden)", async () => {
    const { svc, close } = makeService({ isMember: false, isModerator: false })
    const res = await statusOf(() => svc.closePoll({ messageId: POLL_MSG, userId: AUTHOR }))
    expect(res).toEqual({ status: 403, code: "poll_close_forbidden" })
    expect(close).not.toHaveBeenCalled()
  })

  it("an author who is still a member may close", async () => {
    const { svc, close } = makeService({ isMember: true })
    await svc.closePoll({ messageId: POLL_MSG, userId: AUTHOR })
    expect(close).toHaveBeenCalledWith(POLL_MSG)
  })

  it("a moderator (non-member, e.g. report operator) may still close", async () => {
    const { svc, close } = makeService({ isMember: false, isModerator: true })
    await svc.closePoll({ messageId: POLL_MSG, userId: "ffffffff-ffff-ffff-ffff-ffffffffffff" })
    expect(close).toHaveBeenCalledWith(POLL_MSG)
  })
})
