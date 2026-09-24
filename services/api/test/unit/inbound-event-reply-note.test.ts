import { describe, expect, it } from "vitest"
import { InMemoryMailRepository } from "../helpers/admin/mail-repository.memory.js"
import { onEventReply } from "../../src/services/admin/inbound-thread-correlation.js"
import { MESSAGE_BODY_MAX } from "@civfix/shared"
import type { CleanupRepository } from "../../src/services/cleanup-service.js"
import type { Container } from "../../src/di.js"

const REPLY_DOMAIN = "civfix.org"

async function timelineNoteFor(body: string | null): Promise<string | null | undefined> {
  const notes: (string | null | undefined)[] = []
  const cleanupRepo = {
    appendCleanupTimeline: (_id: string, entry: { note?: string | null }) => {
      notes.push(entry.note)
      return Promise.resolve()
    },
  } as unknown as CleanupRepository
  const mailRepo = new InMemoryMailRepository()
  const thread = mailRepo.seedThread({ cleanupId: "cleanup-1" })
  const message = await mailRepo.insertMessage({
    threadId: thread.id,
    direction: "in",
    fromAddr: "clerk@lacity.gov",
    body,
  })
  const container = { env: { MAIL_REPLY_DOMAIN: REPLY_DOMAIN } } as unknown as Container
  await onEventReply(container, cleanupRepo, mailRepo, thread, message!, 0)
  return notes[0]
}

describe("event reply timeline note", () => {
  it("keeps the city's own words and drops the quoted history", async () => {
    const note = await timelineNoteFor(
      [
        "Thanks, a crew will be there Saturday.",
        "",
        "On Mon, Jan 5, 2026 at 9:00 AM civfix <event-abcdefgh12@civfix.org> wrote:",
        "> Hello, residents are organizing a cleanup at the park.",
      ].join("\n"),
    )
    expect(note).toBe("Thanks, a crew will be there Saturday.")
  })

  it("clips a long reply to the message body limit", async () => {
    const note = await timelineNoteFor("x".repeat(MESSAGE_BODY_MAX + 500))
    expect(note?.length).toBe(MESSAGE_BODY_MAX)
  })

  it("falls back to a fixed note when the reply has no text of its own", async () => {
    expect(await timelineNoteFor(null)).toBe("Jurisdiction replied")
    expect(await timelineNoteFor("> only quoted text")).toBe("Jurisdiction replied")
  })
})
