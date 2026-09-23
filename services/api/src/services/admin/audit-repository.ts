export interface ListAuditArgs {
  actor: string | null
  action: string | null
  target: string | null
  cursor: string | null
  limit: number
}

export interface AuditRecord {
  id: string
  actorId: string | null
  /** Null for a system action or an unknown actor. */
  actorName: string | null
  action: string
  target: string | null
  meta: Record<string, unknown> | null
  createdAt: Date
}

export interface AuditRepository {
  list(args: ListAuditArgs): Promise<{ records: AuditRecord[]; nextCursor: string | null }>
}
