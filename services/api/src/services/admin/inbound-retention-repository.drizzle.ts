import type { Sql } from "../../db/client.js"
import { MS_PER_DAY } from "../../lib/time.js"
import type {
  InboundRetentionRepository,
  ReapedInboundEmail,
} from "./inbound-retention-repository.js"

const INBOUND_EMAIL_RETENTION_DAYS = 180

export const INBOUND_EMAIL_RETENTION_MS = INBOUND_EMAIL_RETENTION_DAYS * MS_PER_DAY

export const INBOUND_EMAIL_RETENTION_BATCH = 200

interface ReapedRow {
  id: string
  attachments: { key?: unknown }[] | null
}

export function makeDrizzleInboundRetentionRepository(sql: Sql): InboundRetentionRepository {
  return {
    async findArchivedBefore(input: {
      before: Date
      limit: number
    }): Promise<ReapedInboundEmail[]> {
      const rows = await sql<ReapedRow[]>`
        SELECT id, attachments
        FROM inbound_emails
        WHERE archived_at IS NOT NULL AND archived_at < ${input.before}
        ORDER BY archived_at ASC
        LIMIT ${input.limit}
      `
      return rows.map(toReaped)
    },

    async deleteByIds(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0
      const rows = await sql<{ id: string }[]>`
        DELETE FROM inbound_emails WHERE id = ANY(${ids}::uuid[]) RETURNING id
      `
      return rows.length
    },
  }
}

export function toReaped(row: ReapedRow): ReapedInboundEmail {
  const attachmentKeys: string[] = []
  for (const att of row.attachments ?? []) {
    if (typeof att?.key === "string" && att.key.length > 0) attachmentKeys.push(att.key)
  }
  return { id: row.id, attachmentKeys }
}
