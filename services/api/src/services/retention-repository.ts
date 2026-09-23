export interface RetentionRepository {
  deleteExpiredOtps(cutoff: Date, limit: number): Promise<{ id: string }[]>
  deleteExpiredAnonTokens(cutoff: Date, limit: number): Promise<{ id: string }[]>
  deleteExpiredSessions(cutoff: Date, limit: number): Promise<{ id: string }[]>
  deleteOldIdempotencyKeys(cutoff: Date, limit: number): Promise<{ key: string }[]>
  deleteOldNotifications(cutoff: Date, limit: number): Promise<{ id: string }[]>
  deleteStaleGeocodeCache(cutoff: Date, limit: number): Promise<{ point_key: string }[]>
}
