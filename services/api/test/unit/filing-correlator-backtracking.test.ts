/**
 * The framing-line scan runs on unauthenticated mail before any trust check, so a long whitespace run
 * after the phrase must not make it backtrack quadratically on the event loop.
 */

import { describe, expect, it } from "vitest"
import { FakeJobs } from "@civfix/seams"
import {
  correlateFilingsInboxMessage,
  type FilingCorrelatorDeps,
} from "../../src/services/filings/filing-correlator.js"

const PHRASE = "Reported by a resident via CivFix"
const MAX_MS = 200

function deps() {
  const calls: string[] = []
  const record =
    <T>(name: string, value: T) =>
    () => {
      calls.push(name)
      return Promise.resolve(value)
    }
  const d = {
    filings: {
      getLatestByMailThread: record("getLatestByMailThread", null),
      getLatestSuccessfulForReport: record("getLatestSuccessfulForReport", null),
      findByCaseIds: record("findByCaseIds", []),
      findRoutes: record("findRoutes", []),
      insertMessageIfAbsent: record("insertMessageIfAbsent", null),
      getMessageByInboundEmailId: record("getMessageByInboundEmailId", null),
      getMessageByMailMessageId: record("getMessageByMailMessageId", null),
      flagMessage: record("flagMessage", undefined),
    },
    ingest: { reportIdByReferenceCode: record("reportIdByReferenceCode", null) },
    mailRepo: { outboundRecipients: record("outboundRecipients", []) },
    jobs: new FakeJobs(),
    automaticFiling: true,
  } satisfies FilingCorrelatorDeps
  return { d, calls }
}

describe("framing-line scan on adversarial whitespace", () => {
  for (const [where, subject, text] of [
    ["subject", `${PHRASE}${" ".repeat(200_000)}x`, ""],
    ["body", "Update", `${PHRASE}${" ".repeat(20_000)}x`],
  ] as const) {
    it(`finishes quickly and links nothing for a long run after the phrase in the ${where}`, async () => {
      const { d, calls } = deps()
      const started = performance.now()

      await correlateFilingsInboxMessage(d, {
        inboundEmailId: "inbox-1",
        from: "a@example.net",
        authVerdict: "fail",
        subject,
        text,
      })

      expect(performance.now() - started).toBeLessThan(MAX_MS)
      expect(calls).not.toContain("reportIdByReferenceCode")
      expect(calls).not.toContain("insertMessageIfAbsent")
    })
  }
})
