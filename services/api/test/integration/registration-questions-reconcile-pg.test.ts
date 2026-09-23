import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleHostRegistrationRepository } from "../../src/services/host/registration-repository.drizzle.js"
import type {
  DesiredQuestion,
  HostRegistrationRepository,
  QuestionRecord,
} from "../../src/services/host/registration-repository.js"

const pg = await withPg()
const FUTURE = new Date(Date.now() + 7 * 86_400_000)

describe.skipIf(!pg)("event question save (integration)", () => {
  let h: PgHarness
  let repo: HostRegistrationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleHostRegistrationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newCleanup(): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Organizer') RETURNING id
    `
    return await seedCleanup(h.sql, {
      organizerUserId: u!.id,
      title: "Question sweep",
      lng: -118.25,
      lat: 34.05,
      scheduledAt: FUTURE,
    })
  }

  async function newTicketType(cleanupId: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_ticket_types (cleanup_id, name, capacity, max_party_size, waitlist_enabled)
      VALUES (${cleanupId}, ${`Type ${randomUUID().slice(0, 8)}`}, 5, 4, false)
      RETURNING id
    `
    return row!.id
  }

  function question(over: Partial<DesiredQuestion>): DesiredQuestion {
    return {
      id: null,
      ticketTypeId: null,
      kind: "short_text",
      prompt: "Anything else?",
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

  function byPrompt(records: QuestionRecord[], prompt: string): QuestionRecord {
    const found = records.find((r) => r.prompt === prompt)
    if (!found) throw new Error(`no question "${prompt}"`)
    return found
  }

  const SHIFTS = [
    { value: "am", label: "Morning" },
    { value: "pm", label: "Afternoon" },
  ]

  it("adds, edits, archives and restores questions with every column intact", async () => {
    const cleanupId = await newCleanup()
    const ticketTypeId = await newTicketType(cleanupId)
    const now = new Date()

    const first = await repo.reconcileQuestions(
      cleanupId,
      [
        question({
          kind: "multi_select",
          prompt: "Which shifts?",
          options: SHIFTS,
          maxSelections: 2,
          required: true,
          sortOrder: 0,
        }),
        question({
          kind: "consent",
          prompt: "Photo release",
          consentText: "I agree to be photographed.",
          sortOrder: 1,
        }),
        question({ prompt: "Dietary needs?", helpText: "Optional", sortOrder: 2 }),
      ],
      now,
    )
    expect(first.map((q) => q.prompt)).toEqual(["Which shifts?", "Photo release", "Dietary needs?"])
    const shifts = byPrompt(first, "Which shifts?")
    const photo = byPrompt(first, "Photo release")
    const dietary = byPrompt(first, "Dietary needs?")
    expect(shifts).toMatchObject({
      kind: "multi_select",
      options: SHIFTS,
      maxSelections: 2,
      required: true,
      showIf: null,
      archivedAt: null,
    })
    expect(photo).toMatchObject({ consentText: "I agree to be photographed.", sortOrder: 1 })
    expect(dietary).toMatchObject({ helpText: "Optional", ticketTypeId: null })

    const second = await repo.reconcileQuestions(
      cleanupId,
      [
        question({
          id: dietary.id,
          ticketTypeId,
          prompt: "Dietary needs (lunch)?",
          showIf: { questionId: shifts.id, equals: "am" },
          sortOrder: 0,
        }),
        question({
          id: shifts.id,
          kind: "multi_select",
          prompt: "Which shifts?",
          options: SHIFTS,
          maxSelections: null,
          sortOrder: 1,
        }),
        question({ kind: "checkbox", prompt: "Bringing gloves?", sortOrder: 2 }),
      ],
      now,
    )
    expect(second.map((q) => q.prompt)).toEqual([
      "Dietary needs (lunch)?",
      "Which shifts?",
      "Bringing gloves?",
    ])
    expect(byPrompt(second, "Dietary needs (lunch)?")).toMatchObject({
      id: dietary.id,
      ticketTypeId,
      helpText: null,
      showIf: { questionId: shifts.id, equals: "am" },
    })
    expect(byPrompt(second, "Which shifts?")).toMatchObject({
      id: shifts.id,
      maxSelections: null,
      required: false,
    })
    const [archived] = await h.sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM cleanup_questions WHERE id = ${photo.id}
    `
    expect(archived?.archived_at).not.toBeNull()
    const [shiftsRow] = await h.sql<{ show_if_is_sql_null: boolean }[]>`
      SELECT show_if IS NULL AS show_if_is_sql_null FROM cleanup_questions WHERE id = ${shifts.id}
    `
    expect(shiftsRow?.show_if_is_sql_null).toBe(true)

    const third = await repo.reconcileQuestions(
      cleanupId,
      [
        question({
          id: photo.id,
          kind: "consent",
          prompt: "Photo release",
          consentText: "I agree to be photographed.",
          sortOrder: 0,
        }),
      ],
      now,
    )
    expect(third.map((q) => [q.id, q.archivedAt])).toEqual([[photo.id, null]])
  })

  it("ignores a kept id that belongs to another event", async () => {
    const mine = await newCleanup()
    const theirs = await newCleanup()
    const [foreign] = await repo.reconcileQuestions(
      theirs,
      [question({ prompt: "Theirs" })],
      new Date(),
    )

    const saved = await repo.reconcileQuestions(
      mine,
      [question({ id: foreign!.id, prompt: "Hijacked" })],
      new Date(),
    )

    expect(saved).toEqual([])
    const [row] = await h.sql<{ prompt: string; cleanup_id: string }[]>`
      SELECT prompt, cleanup_id FROM cleanup_questions WHERE id = ${foreign!.id}
    `
    expect(row).toEqual({ prompt: "Theirs", cleanup_id: theirs })
  })
})
