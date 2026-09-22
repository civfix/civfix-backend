import type { Sql } from "../../db/client.js"
import { writeAudit } from "./audit.js"
import type {
  ForwardTemplateRepository,
  ForwardTemplateSettingsRecord,
  SetForwardTemplateInput,
} from "./forward-template-types.js"

export const FORWARD_TEMPLATE_AUDIT_TARGET = "mail:forward-template"

interface ForwardTemplateRowSelect {
  subject_template: string | null
  body_template: string | null
  updated_at: Date
  updated_by: string | null
}

function toRecord(row: ForwardTemplateRowSelect): ForwardTemplateSettingsRecord {
  return {
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

export function makeDrizzleForwardTemplateRepository(sql: Sql): ForwardTemplateRepository {
  return {
    async get(): Promise<ForwardTemplateSettingsRecord | null> {
      const rows = await sql<ForwardTemplateRowSelect[]>`
        SELECT subject_template, body_template, updated_at, updated_by
        FROM forward_template_settings
        WHERE id = 1
        LIMIT 1
      `
      const row = rows[0]
      return row === undefined ? null : toRecord(row)
    },

    async set(input: SetForwardTemplateInput): Promise<ForwardTemplateSettingsRecord> {
      return sql.begin(async (tx) => {
        const rows = await tx<ForwardTemplateRowSelect[]>`
          INSERT INTO forward_template_settings (id, subject_template, body_template, updated_at, updated_by)
          VALUES (1, ${input.subjectTemplate}, ${input.bodyTemplate}, now(), ${input.actorId})
          ON CONFLICT (id) DO UPDATE SET
            subject_template = EXCLUDED.subject_template,
            body_template = EXCLUDED.body_template,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
          RETURNING subject_template, body_template, updated_at, updated_by
        `
        const row = rows[0]
        if (row === undefined) throw new Error("forward_template_settings upsert returned no row")
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "mail.forward_template_set",
          target: FORWARD_TEMPLATE_AUDIT_TARGET,
          meta: {
            subject: input.subjectTemplate !== null,
            body: input.bodyTemplate !== null,
          },
        })
        return toRecord(row)
      })
    },
  }
}
