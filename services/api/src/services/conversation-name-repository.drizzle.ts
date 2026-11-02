import type { ReportCategory } from "@civfix/contract"
import type { Sql } from "../db/client.js"
import type { ConversationNameLookups } from "./conversation-names.js"

export function makeConversationNameRepository(sql: Sql): ConversationNameLookups {
  return {
    async groupName(groupId: string): Promise<string | null> {
      const [row] = await sql<{ name: string }[]>`
        SELECT name FROM chat_groups WHERE id = ${groupId}`
      return row?.name ?? null
    },

    async reportCategory(reportId: string): Promise<ReportCategory | null> {
      const [row] = await sql<{ category: ReportCategory }[]>`
        SELECT category FROM reports WHERE id = ${reportId}`
      return row?.category ?? null
    },

    async eventTitle(cleanupId: string): Promise<string | null> {
      const [row] = await sql<{ title: string }[]>`
        SELECT title FROM cleanups WHERE id = ${cleanupId}`
      return row?.title ?? null
    },
  }
}
