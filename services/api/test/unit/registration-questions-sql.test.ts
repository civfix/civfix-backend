import { describe, expect, it } from "vitest"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type { DesiredQuestion } from "../../src/services/host/registration-repository.js"
import { makeSqlRecorder, type ExecutedQuery, type SqlRecorder } from "../helpers/sql-recorder.js"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const KEPT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
const KEPT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"
const TYPE = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
const NOW = new Date("2026-03-04T05:06:07.000Z")
const QUESTION_WRITE = /^(UPDATE cleanup_questions q|INSERT INTO cleanup_questions)/

function question(over: Partial<DesiredQuestion> = {}): DesiredQuestion {
  return {
    id: null,
    ticketTypeId: null,
    kind: "short_text",
    prompt: "T-shirt size?",
    helpText: null,
    required: false,
    options: [],
    maxSelections: null,
    consentText: null,
    showIf: null,
    sortOrder: 0,
    ...over,
  }
}

async function reconcile(desired: DesiredQuestion[]): Promise<SqlRecorder> {
  const rec = makeSqlRecorder()
  rec.on(/^SELECT id FROM cleanups/, [{ id: EVENT }])
  await makeDrizzleHostRegistrationRepository(rec.sql).reconcileQuestions(EVENT, desired, NOW)
  return rec
}

function jsonRows(query: ExecutedQuery | undefined, index: number): unknown {
  return (query?.params[index] as { value: unknown } | undefined)?.value
}

describe("saving an event's questions", () => {
  const mixed = [
    question({
      id: KEPT_A,
      kind: "multi_select",
      prompt: "Which shifts?",
      options: [
        { value: "am", label: "Morning" },
        { value: "pm", label: "Afternoon" },
      ],
      maxSelections: 2,
      sortOrder: 0,
    }),
    question({ prompt: "Dietary needs?", helpText: "Optional", sortOrder: 1 }),
    question({
      id: KEPT_B,
      ticketTypeId: TYPE,
      kind: "checkbox",
      prompt: "Bringing gloves?",
      showIf: { questionId: KEPT_A, equals: "am" },
      sortOrder: 2,
    }),
    question({
      kind: "consent",
      prompt: "Photo release",
      required: true,
      consentText: "I agree to be photographed.",
      sortOrder: 3,
    }),
  ]

  it("writes the kept questions in one UPDATE, then the new ones in one INSERT", async () => {
    const rec = await reconcile(mixed)

    const writes = rec.queries.filter((q) => QUESTION_WRITE.test(q.text))
    expect(writes.map((q) => q.text.split(" ")[0])).toEqual(["UPDATE", "INSERT"])
    expect(writes.every((q) => q.scope === "tx1")).toBe(true)

    const [update, insert] = writes
    expect(update?.text).toContain("FROM jsonb_to_recordset($2) AS u(")
    expect(update?.text).toContain(
      "id uuid, ticket_type_id uuid, kind text, prompt text, help_text text, required boolean, " +
        "options jsonb, max_selections smallint, consent_text text, show_if jsonb, sort_order smallint",
    )
    expect(update?.text).toContain("archived_at = NULL, updated_at = $1")
    expect(update?.text).toMatch(/WHERE q\.id = u\.id AND q\.cleanup_id = \$3$/)
    expect(update?.params[0]).toEqual(NOW)
    expect(update?.params[2]).toBe(EVENT)
    expect(jsonRows(update, 1)).toEqual([
      {
        id: KEPT_A,
        ticket_type_id: null,
        kind: "multi_select",
        prompt: "Which shifts?",
        help_text: null,
        required: false,
        options: [
          { value: "am", label: "Morning" },
          { value: "pm", label: "Afternoon" },
        ],
        max_selections: 2,
        consent_text: null,
        show_if: null,
        sort_order: 0,
      },
      {
        id: KEPT_B,
        ticket_type_id: TYPE,
        kind: "checkbox",
        prompt: "Bringing gloves?",
        help_text: null,
        required: false,
        options: [],
        max_selections: null,
        consent_text: null,
        show_if: { questionId: KEPT_A, equals: "am" },
        sort_order: 2,
      },
    ])

    expect(insert?.text).toContain(
      "SELECT $1, u.ticket_type_id, u.kind, u.prompt, u.help_text, u.required, u.options, " +
        "u.max_selections, u.consent_text, u.show_if, u.sort_order, $2, $3 FROM jsonb_to_recordset($4) AS u(",
    )
    expect(insert?.params.slice(0, 3)).toEqual([EVENT, NOW, NOW])
    expect(jsonRows(insert, 3)).toEqual([
      {
        ticket_type_id: null,
        kind: "short_text",
        prompt: "Dietary needs?",
        help_text: "Optional",
        required: false,
        options: [],
        max_selections: null,
        consent_text: null,
        show_if: null,
        sort_order: 1,
      },
      {
        ticket_type_id: null,
        kind: "consent",
        prompt: "Photo release",
        help_text: null,
        required: true,
        options: [],
        max_selections: null,
        consent_text: "I agree to be photographed.",
        show_if: null,
        sort_order: 3,
      },
    ])
  })

  it("archives the questions left out before writing the rest", async () => {
    const rec = await reconcile(mixed)

    const texts = rec.queries.map((q) => q.text.split(" ").slice(0, 2).join(" "))
    expect(texts).toEqual([
      "SELECT id",
      "UPDATE cleanup_questions",
      "UPDATE cleanup_questions",
      "INSERT INTO",
      "SELECT id,",
    ])
    expect(rec.queries[1]?.params).toEqual([NOW, NOW, EVENT, [KEPT_A, KEPT_B]])
  })

  it("sends no INSERT when every question is kept, and no UPDATE when every one is new", async () => {
    const keptOnly = await reconcile([question({ id: KEPT_A })])
    const newOnly = await reconcile([question()])

    expect(
      keptOnly.queries.filter((q) => QUESTION_WRITE.test(q.text)).map((q) => q.text.split(" ")[0]),
    ).toEqual(["UPDATE"])
    expect(
      newOnly.queries.filter((q) => QUESTION_WRITE.test(q.text)).map((q) => q.text.split(" ")[0]),
    ).toEqual(["INSERT"])
  })

  it("keeps the last of two kept entries whose ids differ only in letter case", async () => {
    const rec = await reconcile([
      question({ id: KEPT_A.toUpperCase(), prompt: "One", sortOrder: 0 }),
      question({ id: KEPT_A, prompt: "Two", sortOrder: 1 }),
    ])
    const update = rec.queries.find((q) => q.text.startsWith("UPDATE cleanup_questions q"))

    expect(jsonRows(update, 1)).toEqual([
      expect.objectContaining({ id: KEPT_A, prompt: "Two", sort_order: 1 }),
    ])
  })

  it("stores a lone surrogate as U+FFFD, as the text parameters did", async () => {
    const rec = await reconcile([
      question({
        id: KEPT_A,
        prompt: "Bring gloves\ud800",
        helpText: "\udc00",
        consentText: "ok\ud800",
      }),
    ])
    const update = rec.queries.find((q) => q.text.startsWith("UPDATE cleanup_questions q"))

    expect(jsonRows(update, 1)).toEqual([
      expect.objectContaining({
        prompt: "Bring gloves\ufffd",
        help_text: "\ufffd",
        consent_text: "ok\ufffd",
      }),
    ])
  })

  it("writes nothing for an event that is gone", async () => {
    const rec = makeSqlRecorder()

    const saved = await makeDrizzleHostRegistrationRepository(rec.sql).reconcileQuestions(
      EVENT,
      mixed,
      NOW,
    )

    expect(saved).toEqual([])
    expect(rec.queries).toHaveLength(1)
  })
})
