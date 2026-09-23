export interface ReportForwardAuditRepository {
  recordMention(messageId: string, geoid: string): Promise<void>
  markForwarded(messageId: string, geoid: string): Promise<void>
}
