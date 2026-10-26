import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FilingClassificationSchema } from "@civfix/api/filings-worker"
import { afterEach, describe, expect, it, vi } from "vitest"
import { errorResult } from "../helpers/claude-acts.js"
import { filerHarness, type FilerHarness } from "../helpers/filer-harness.js"

let h: FilerHarness

afterEach(async () => {
  await h?.close()
})

const MESSAGE = {
  filingMessageId: "6f0e2c2a-1b7c-4d8e-9a3b-5c4d3e2f1a00",
  subject: "Your service request SR-0042",
  text: "We received your request SR-0042. A crew is scheduled for Tuesday.",
}

const READING = {
  caseId: "SR-0042",
  status: "in_progress",
  summary: "A crew is scheduled for Tuesday.",
  confidence: 0.9,
}

/** Act lines: answer with `body` as the result text. */
const reply = (body: unknown) =>
  `return { type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))} }`

const unread = { caseId: null, status: "other", confidence: 0 }

describe("the filing.classify handler", () => {
  it("T13: a classify job that arrives during a filing run waits for it; the two claude processes never overlap", async () => {
    h = await filerHarness()
    await h.claude(`if (n === 0) {
        while (!fs.existsSync(join(state, "release"))) await new Promise((r) => setTimeout(r, 50))
        return
      }
      ${reply(READING)}`)

    const filing = h.run(h.filings.add().id, 1)
    await vi.waitFor(async () => expect(await h.claudeCalls()).toHaveLength(1), {
      timeout: 20_000,
    })
    const classified = h.classify(MESSAGE)
    await new Promise((r) => setTimeout(r, 1000))
    const whileFiling = (await h.claudeCalls()).length
    await writeFile(join(h.dir, "claude-state", "release"), "")
    await Promise.all([filing, classified])

    expect(whileFiling).toBe(1)
    const calls = await h.claudeCalls()
    expect(calls.map((c) => [c.argv[4], c.overlapped])).toEqual([
      ["test-run-model", false],
      ["test-classify-model", false],
    ])
    expect(h.cityUpdates()).toHaveLength(1)
  })

  it("T14: a valid reading: classify's flags only, the text on stdin and in no argv entry, and filing.city_update enqueued with it", async () => {
    h = await filerHarness()
    await h.claude(reply(READING))

    expect(await h.classify(MESSAGE)).toBe("completed")
    const [call] = await h.claudeCalls()
    expect(call?.argv).toEqual([
      ...["-p", "--output-format", "json", "--model", "test-classify-model"],
      ...["--append-system-prompt-file", "/app/playbook/classify.md"],
      ...["--tools", "", "--strict-mcp-config"],
    ])
    expect(call?.argv).not.toContain("--mcp-config")
    expect(call?.argv).not.toContain("--dangerously-skip-permissions")
    expect(call?.stdin).toContain(MESSAGE.subject)
    expect(call?.stdin).toContain(MESSAGE.text)
    expect(call?.argv.filter((a) => a.includes("SR-0042") || a.includes("crew"))).toEqual([])
    expect(h.cityUpdates()).toEqual([
      {
        data: { filingMessageId: MESSAGE.filingMessageId, classification: READING },
        singletonKey: MESSAGE.filingMessageId,
      },
    ])
  })

  it("T15: an invalid reading, then a valid one: one retry in the job, and the valid one is enqueued", async () => {
    h = await filerHarness()
    await h.claude(`if (n === 0) ${reply("It is about a pothole.")}
      ${reply(READING)}`)

    expect(await h.classify(MESSAGE)).toBe("completed")
    expect(await h.claudeCalls()).toHaveLength(2)
    expect(h.cityUpdates().map((u) => u.data.classification)).toEqual([READING])
  })

  it("T16: two invalid readings enqueue confidence 0; so does ai_unavailable on the job's last try", async () => {
    h = await filerHarness()
    await h.claude(reply("not json"))
    expect(await h.classify(MESSAGE)).toBe("completed")
    expect(await h.claudeCalls()).toHaveLength(2)

    await h.claude(errorResult("usage limit reached"))
    const second = { ...MESSAGE, filingMessageId: "9a1d2c3b-4e5f-4a6b-8c7d-0e1f2a3b4c5d" }
    await h.classifyHandler({ id: "j2", data: second, retryCount: 1, retryLimit: 1 })

    expect(h.cityUpdates().map((u) => [u.data.filingMessageId, u.data.classification])).toEqual([
      [MESSAGE.filingMessageId, expect.objectContaining(unread)],
      [second.filingMessageId, expect.objectContaining(unread)],
    ])
  })

  it("T17: a summary of 300 characters is invalid by the schema, so it is never enqueued", async () => {
    h = await filerHarness()
    const long = { ...READING, summary: "x".repeat(300) }
    await h.claude(reply(long))

    expect(FilingClassificationSchema.safeParse(long).success).toBe(false)
    expect(await h.classify(MESSAGE)).toBe("completed")
    expect(await h.claudeCalls()).toHaveLength(2)
    expect(h.cityUpdates().map((u) => u.data.classification)).toEqual([
      expect.objectContaining(unread),
    ])
  })

  it("T27: ai_unavailable on the job's first try throws, so pg-boss fails it for its one retry; nothing is enqueued", async () => {
    h = await filerHarness()
    await h.claude(errorResult("usage limit reached"))

    await expect(
      h.classifyHandler({ id: "j1", data: MESSAGE, retryCount: 0, retryLimit: 1 }),
    ).rejects.toThrow(/unavailable/)
    expect(await h.classify(MESSAGE)).toBe("failed")
    expect(h.cityUpdates()).toEqual([])
  })
})
