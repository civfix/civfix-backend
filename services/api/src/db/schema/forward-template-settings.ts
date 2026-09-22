import { sql } from "drizzle-orm"
import { check, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const forwardTemplateSettings = pgTable(
  "forward_template_settings",
  {
    id: smallint("id").primaryKey(),
    subjectTemplate: text("subject_template"),
    bodyTemplate: text("body_template"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [check("forward_template_settings_id_check", sql`${t.id} = 1`)],
)

export type ForwardTemplateSettingsRow = typeof forwardTemplateSettings.$inferSelect
export type NewForwardTemplateSettingsRow = typeof forwardTemplateSettings.$inferInsert
