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

async function upsertQuestion(
  tx: TransactionSql,
  cleanupId: string,
  q: DesiredQuestion,
  now: Date,
): Promise<void> {
  const options = tx.json(q.options as Parameters<typeof tx.json>[0])
  const showIf = q.showIf === null ? null : tx.json(q.showIf as Parameters<typeof tx.json>[0])
  if (q.id !== null) {
    await tx`
      UPDATE cleanup_questions SET
        ticket_type_id = ${q.ticketTypeId},
        kind           = ${q.kind},
        prompt         = ${q.prompt},
        help_text      = ${q.helpText},
        required       = ${q.required},
        options        = ${options},
        max_selections = ${q.maxSelections},
        consent_text   = ${q.consentText},
        show_if        = ${showIf},
        sort_order     = ${q.sortOrder},
        archived_at    = NULL,
        updated_at     = ${now}
      WHERE id = ${q.id} AND cleanup_id = ${cleanupId}
    `
    return
  }
  await tx`
    INSERT INTO cleanup_questions (
      cleanup_id, ticket_type_id, kind, prompt, help_text, required,
      options, max_selections, consent_text, show_if, sort_order, created_at, updated_at
    ) VALUES (
      ${cleanupId}, ${q.ticketTypeId}, ${q.kind}, ${q.prompt}, ${q.helpText},
      ${q.required}, ${options}, ${q.maxSelections}, ${q.consentText}, ${showIf},
      ${q.sortOrder}, ${now}, ${now}
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
        for (const q of desired) await upsertQuestion(tx, cleanupId, q, now)
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
