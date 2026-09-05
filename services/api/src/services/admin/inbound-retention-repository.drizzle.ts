import type { Sql } from "../../db/client.js"

export const INBOUND_EMAIL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

export const INBOUND_EMAIL_RETENTION_BATCH = 200

export interface ReapedInboundEmail {
  id: string
  attachmentKeys: string[]
}

interface ReapedRow {
  id: string
  attachments: { key?: unknown }[] | null
}

export interface InboundRetentionRepository {
  findArchivedBefore(input: { before: Date; limit: number }): Promise<ReapedInboundEmail[]>
  deleteByIds(ids: string[]): Promise<number>
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
