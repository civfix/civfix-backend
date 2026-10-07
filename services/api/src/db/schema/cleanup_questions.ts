import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { cleanupRegistrations } from "./cleanup_registrations.js"
import { cleanupTicketTypes } from "./cleanup_ticket_types.js"
import type { EventQuestionKindValue } from "./types-registration.js"

export const cleanupQuestions = pgTable(
  "cleanup_questions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id"),
    kind: text("kind").$type<EventQuestionKindValue>().notNull(),
    prompt: text("prompt").notNull(),
    helpText: text("help_text"),
    required: boolean("required").notNull().default(false),
    options: jsonb("options")
      .notNull()
      .default(sql`'[]'::jsonb`),
    maxSelections: smallint("max_selections"),
    consentText: text("consent_text"),
    showIf: jsonb("show_if"),
    sortOrder: smallint("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.ticketTypeId, t.cleanupId],
      foreignColumns: [cleanupTicketTypes.id, cleanupTicketTypes.cleanupId],
    }).onDelete("cascade"),
    check(
      "cleanup_questions_kind_check",
      sql`${t.kind} IN ('short_text', 'long_text', 'single_select', 'multi_select', 'checkbox', 'consent')`,
    ),
    check(
      "cleanup_questions_options_shape",
      sql`jsonb_typeof(${t.options}) = 'array' AND jsonb_array_length(${t.options}) <= 30`,
    ),
    check(
      "cleanup_questions_kind_payload",
      sql`(${t.kind} NOT IN ('single_select', 'multi_select') OR jsonb_array_length(${t.options}) > 0) AND (${t.kind} <> 'consent' OR ${t.consentText} IS NOT NULL)`,
    ),
    uniqueIndex("cleanup_questions_id_cleanup_uidx").on(t.id, t.cleanupId),
    index("cleanup_questions_live_idx")
      .on(t.cleanupId, t.sortOrder, t.id)
      .where(sql`archived_at IS NULL`),
    index("cleanup_questions_type_idx")
      .on(t.ticketTypeId)
      .where(sql`ticket_type_id IS NOT NULL`),
  ],
)

export const cleanupAnswers = pgTable(
  "cleanup_answers",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => cleanupRegistrations.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => cleanupQuestions.id, { onDelete: "cascade" }),
    valueText: text("value_text"),
    valueJson: jsonb("value_json"),
    scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.questionId, t.cleanupId],
      foreignColumns: [cleanupQuestions.id, cleanupQuestions.cleanupId],
    }).onDelete("cascade"),
    check("cleanup_answers_value_exclusive", sql`${t.valueText} IS NULL OR ${t.valueJson} IS NULL`),
    uniqueIndex("cleanup_answers_registration_question_uidx").on(t.registrationId, t.questionId),
    index("cleanup_answers_unscrubbed_idx")
      .on(t.cleanupId)
      .where(sql`scrubbed_at IS NULL`),
    index("cleanup_answers_question_idx").on(t.questionId),
  ],
)

export type CleanupQuestionRow = typeof cleanupQuestions.$inferSelect
export type NewCleanupQuestionRow = typeof cleanupQuestions.$inferInsert
export type CleanupAnswerRow = typeof cleanupAnswers.$inferSelect
export type NewCleanupAnswerRow = typeof cleanupAnswers.$inferInsert
