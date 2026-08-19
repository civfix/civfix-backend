import { describe, expect, it } from "vitest"
import type { ChatMessageDTO } from "@civfix/shared"
import { neutralizeChatViewerFields } from "../../src/routes/chat-route-helpers.js"

const base: ChatMessageDTO = {
  id: "11111111-1111-1111-1111-111111111111",
  cleanupId: "22222222-2222-2222-2222-222222222222",
  kind: "poll",
  createdAt: "2026-06-01T12:00:00.000Z",
  mine: true,
  reactions: [
    { emoji: "👍", count: 3, mine: true },
    { emoji: "🎉", count: 1, mine: false },
  ],
  mentions: [],
  poll: {
    question: "Which slot?",
    options: [
      { idx: 0, text: "AM", count: 2, mine: true },
      { idx: 1, text: "PM", count: 1, mine: false },
    ],
    allowMultiple: false,
    anonymous: true,
    closed: false,
    totalVoters: 3,
    myVote: [0],
  },
}

describe("F043 neutralizeChatViewerFields — no viewer-scoped state leaks in a room broadcast", () => {
  it("blanks message.mine, reaction.mine, poll.myVote and poll option.mine", () => {
    const out = neutralizeChatViewerFields(base)
    expect(out.mine).toBe(false)
    expect(out.reactions.map((r) => r.mine)).toEqual([false, false])
    expect(out.poll?.myVote).toEqual([])
    expect(out.poll?.options.map((o) => o.mine)).toEqual([false, false])
  })

  it("keeps room-wide fields (counts, labels, body) intact", () => {
    const out = neutralizeChatViewerFields(base)
    expect(out.reactions.map((r) => r.count)).toEqual([3, 1])
    expect(out.poll?.options.map((o) => o.count)).toEqual([2, 1])
    expect(out.poll?.question).toBe("Which slot?")
  })

  it("does not mutate the actor's original DTO", () => {
    neutralizeChatViewerFields(base)
    expect(base.mine).toBe(true)
    expect(base.poll?.myVote).toEqual([0])
    expect(base.reactions[0]!.mine).toBe(true)
  })

  it("handles a poll-less message", () => {
    const { poll: _poll, ...noPoll } = base
    const out = neutralizeChatViewerFields({ ...noPoll, kind: "text" })
    expect(out.poll).toBeUndefined()
    expect(out.mine).toBe(false)
  })
})
