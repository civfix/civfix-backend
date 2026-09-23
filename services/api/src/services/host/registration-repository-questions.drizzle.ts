import type { Sql, TransactionSql } from "../../db/client.js"
import {
  questionColumns,
  toAnswerRecord,
  toQuestionRecord,
  type AnswerRowSelect,
  type QuestionRowSelect,
} from "./registration-sql.js"
import { loadLiveQuestions } from "./registration-repository-load.drizzle.js"
import type {
  AnswerRecord,
  DesiredQuestion,
  HostRegistrationRepository,
  QuestionRecord,
} from "./registration-repository.js"

export type QuestionMethods = Pick<
  HostRegistrationRepository,
  "listQuestions" | "reconcileQuestions" | "listAnswers"
>

interface QuestionColumns {
  ticket_type_id: string | null
  kind: string
  prompt: string
  help_text: string | null
  required: boolean
  options: DesiredQuestion["options"]
  max_selections: number | null
  consent_text: string | null
  show_if: DesiredQuestion["showIf"]
  sort_order: number
}

// As a text parameter a lone UTF-16 surrogate reached Postgres as UTF-8 U+FFFD; inside jsonb it is an
// escaped \ud800 that jsonb input rejects, so the text columns are re-encoded the way the wire did.
function asWireText(value: string): string {
  return Buffer.from(value, "utf8").toString("utf8")
}

function questionColumnsOf(q: DesiredQuestion): QuestionColumns {
  return {
    ticket_type_id: q.ticketTypeId,
    kind: q.kind,
    prompt: asWireText(q.prompt),
    help_text: q.helpText === null ? null : asWireText(q.helpText),
    required: q.required,
    options: q.options,
    max_selections: q.maxSelections,
    consent_text: q.consentText === null ? null : asWireText(q.consentText),
    show_if: q.showIf,
    sort_order: q.sortOrder,
  }
}

// jsonb_to_recordset turns a JSON null into SQL NULL for every column type, so a question without a
// condition stores show_if NULL, never the jsonb 'null'; the AS u(...) types must match the
// cleanup_questions DDL. UPDATE ... FROM applies an arbitrary one of several source rows for a target,
// and the service's duplicate check compares ids as strings while uuid compares case-insensitively, so
// rows are collapsed per lowercased id with the last one winning, as the old per-row updates did.
async function updateKeptQuestions(
  tx: TransactionSql,
  cleanupId: string,
  kept: readonly (DesiredQuestion & { id: string })[],
  now: Date,
): Promise<void> {
  if (kept.length === 0) return
  const byId = new Map<string, QuestionColumns & { id: string }>()
  for (const q of kept) byId.set(q.id.toLowerCase(), { id: q.id, ...questionColumnsOf(q) })
  const rows = [...byId.values()]
  await tx`
    UPDATE cleanup_questions q SET
      ticket_type_id = u.ticket_type_id,
      kind           = u.kind,
      prompt         = u.prompt,
      help_text      = u.help_text,
      required       = u.required,
      options        = u.options,
      max_selections = u.max_selections,
      consent_text   = u.consent_text,
      show_if        = u.show_if,
      sort_order     = u.sort_order,
      archived_at    = NULL,
      updated_at     = ${now}
    FROM jsonb_to_recordset(${tx.json(rows as unknown as Parameters<typeof tx.json>[0])}) AS u(
      id uuid, ticket_type_id uuid, kind text, prompt text, help_text text, required boolean,
      options jsonb, max_selections smallint, consent_text text, show_if jsonb, sort_order smallint
    )
    WHERE q.id = u.id AND q.cleanup_id = ${cleanupId}
  `
}

async function insertNewQuestions(
  tx: TransactionSql,
  cleanupId: string,
  added: readonly DesiredQuestion[],
  now: Date,
): Promise<void> {
  if (added.length === 0) return
  const rows = added.map(questionColumnsOf)
  await tx`
    INSERT INTO cleanup_questions (
      cleanup_id, ticket_type_id, kind, prompt, help_text, required,
      options, max_selections, consent_text, show_if, sort_order, created_at, updated_at
    )
    SELECT ${cleanupId}, u.ticket_type_id, u.kind, u.prompt, u.help_text, u.required,
           u.options, u.max_selections, u.consent_text, u.show_if, u.sort_order, ${now}, ${now}
      FROM jsonb_to_recordset(${tx.json(rows as unknown as Parameters<typeof tx.json>[0])}) AS u(
        ticket_type_id uuid, kind text, prompt text, help_text text, required boolean,
        options jsonb, max_selections smallint, consent_text text, show_if jsonb, sort_order smallint
      )
  `
}

export function makeQuestionMethods(sql: Sql): QuestionMethods {
  return {
    async listQuestions(
      cleanupId: string,
      opts?: { ticketTypeId?: string | null; includeArchived?: boolean },
    ): Promise<QuestionRecord[]> {
      const archivedFilter = opts?.includeArchived === true ? sql`` : sql`AND archived_at IS NULL`
      const scoped = opts !== undefined && "ticketTypeId" in opts
      const ticketTypeId = opts?.ticketTypeId ?? null
      const typeFilter = !scoped
        ? sql``
        : ticketTypeId === null
          ? sql`AND ticket_type_id IS NULL`
          : sql`AND (ticket_type_id IS NULL OR ticket_type_id = ${ticketTypeId})`
      const rows = await sql<QuestionRowSelect[]>`
        SELECT ${questionColumns(sql)}
          FROM cleanup_questions
         WHERE cleanup_id = ${cleanupId}
           ${archivedFilter}
           ${typeFilter}
         ORDER BY sort_order, id
      `
      return rows.map(toQuestionRecord)
    },

    async reconcileQuestions(
      cleanupId: string,
      desired: readonly DesiredQuestion[],
      now: Date,
    ): Promise<QuestionRecord[]> {
      return sql.begin(async (tx) => {
        const locked = await tx<{ id: string }[]>`
          SELECT id FROM cleanups WHERE id = ${cleanupId} LIMIT 1 FOR SHARE
        `
        if (locked[0] === undefined) return []

        const keep = desired.map((q) => q.id).filter((id): id is string => id !== null)
        await tx`
          UPDATE cleanup_questions
             SET archived_at = ${now}, updated_at = ${now}
           WHERE cleanup_id = ${cleanupId}
             AND archived_at IS NULL
             AND NOT (id = ANY(${keep}::uuid[]))
        `
        await updateKeptQuestions(
          tx,
          cleanupId,
          desired.filter((q): q is DesiredQuestion & { id: string } => q.id !== null),
          now,
        )
        await insertNewQuestions(
          tx,
          cleanupId,
          desired.filter((q) => q.id === null),
          now,
        )
        return loadLiveQuestions(tx, cleanupId)
      })
    },

    async listAnswers(cleanupId: string, registrationId: string): Promise<AnswerRecord[]> {
      const rows = await sql<AnswerRowSelect[]>`
        SELECT a.question_id, q.prompt, a.value_text, a.value_json, a.scrubbed_at
          FROM cleanup_answers a
          JOIN cleanup_questions q ON q.id = a.question_id
         WHERE a.cleanup_id = ${cleanupId} AND a.registration_id = ${registrationId}
         ORDER BY q.sort_order, q.id
      `
      return rows.map(toAnswerRecord)
    },
  }
}
