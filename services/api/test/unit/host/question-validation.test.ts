import { describe, expect, it } from "vitest"
import { validateAnswers } from "../../../src/services/host/question-validation.js"
import type { QuestionRecord } from "../../../src/services/host/registration-repository.types.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function question(over: Partial<QuestionRecord> & { id: string }): QuestionRecord {
  return {
    cleanupId: EVENT,
    ticketTypeId: null,
    kind: "short_text",
    prompt: "Prompt",
    helpText: null,
    required: false,
    options: [],
    maxSelections: null,
    consentText: null,
    showIf: null,
    sortOrder: 0,
    archivedAt: null,
    ...over,
  }
}

describe("answer validation", () => {
  it("accepts a trimmed short text answer", () => {
    const result = validateAnswers(
      [question({ id: "q1", required: true })],
      [{ questionId: "q1", value: "  Medium  " }],
    )
    expect(result).toEqual({
      ok: true,
      writes: [{ questionId: "q1", valueText: "Medium", valueJson: null }],
    })
  })

  it("requires an answer for a required question", () => {
    const result = validateAnswers([question({ id: "q1", required: true })], [])
    expect(result).toEqual({ ok: false, fields: { q1: "required" } })
  })

  it("rejects an unknown question id", () => {
    const result = validateAnswers([], [{ questionId: "nope", value: "x" }])
    expect(result).toEqual({ ok: false, fields: { nope: "unknown question" } })
  })

  it("rejects an answer to an archived question", () => {
    const result = validateAnswers(
      [question({ id: "q1", archivedAt: new Date() })],
      [{ questionId: "q1", value: "x" }],
    )
    expect(result).toEqual({ ok: false, fields: { q1: "unknown question" } })
  })

  it("bounds a long text answer", () => {
    const result = validateAnswers(
      [question({ id: "q1", kind: "long_text" })],
      [{ questionId: "q1", value: "x".repeat(2001) }],
    )
    expect(result.ok).toBe(false)
  })

  it("only accepts offered options for a select", () => {
    const q = question({
      id: "q1",
      kind: "single_select",
      options: [{ value: "s", label: "Small" }],
    })
    expect(validateAnswers([q], [{ questionId: "q1", value: "s" }]).ok).toBe(true)
    expect(validateAnswers([q], [{ questionId: "q1", value: "xxl" }]).ok).toBe(false)
  })

  it("enforces maxSelections and rejects duplicates on a multi select", () => {
    const q = question({
      id: "q1",
      kind: "multi_select",
      maxSelections: 2,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    })
    expect(validateAnswers([q], [{ questionId: "q1", value: ["a", "b"] }]).ok).toBe(true)
    expect(validateAnswers([q], [{ questionId: "q1", value: ["a", "b", "c"] }]).ok).toBe(false)
    expect(validateAnswers([q], [{ questionId: "q1", value: ["a", "a"] }]).ok).toBe(false)
  })

  it("treats a required consent as unmet when it is false", () => {
    const q = question({ id: "q1", kind: "consent", required: true, consentText: "I agree" })
    expect(validateAnswers([q], [{ questionId: "q1", value: false }])).toEqual({
      ok: false,
      fields: { q1: "required" },
    })
    expect(validateAnswers([q], [{ questionId: "q1", value: true }]).ok).toBe(true)
  })

  it("skips a conditional question whose condition is unmet, and rejects an answer to it", () => {
    const parent = question({
      id: "q1",
      kind: "single_select",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    })
    const child = question({
      id: "q2",
      required: true,
      showIf: { questionId: "q1", equals: "yes" },
    })

    expect(validateAnswers([parent, child], [{ questionId: "q1", value: "no" }]).ok).toBe(true)
    expect(
      validateAnswers(
        [parent, child],
        [
          { questionId: "q1", value: "no" },
          { questionId: "q2", value: "anything" },
        ],
      ).ok,
    ).toBe(false)
    expect(
      validateAnswers(
        [parent, child],
        [
          { questionId: "q1", value: "yes" },
          { questionId: "q2", value: "detail" },
        ],
      ).ok,
    ).toBe(true)
  })

  it("rejects the same question answered twice", () => {
    const result = validateAnswers(
      [question({ id: "q1" })],
      [
        { questionId: "q1", value: "a" },
        { questionId: "q1", value: "b" },
      ],
    )
    expect(result).toEqual({ ok: false, fields: { q1: "answered more than once" } })
  })
})
