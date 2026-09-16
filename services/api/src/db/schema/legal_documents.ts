import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import type { LegalDocumentTypeValue } from "./types-legal.js"

export const legalDocuments = pgTable(
  "legal_documents",
  {
    type: text("type").$type<LegalDocumentTypeValue>().notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.type, t.version] }),
    index("legal_documents_effective_idx").on(t.type, t.effectiveAt.desc()),
  ],
)

export type LegalDocumentRow = typeof legalDocuments.$inferSelect
export type NewLegalDocumentRow = typeof legalDocuments.$inferInsert
