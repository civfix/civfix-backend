export interface RegistrationRetentionRepository {
  scrubAnswers(cutoff: Date, now: Date, batchSize: number): Promise<number>
  coarsenCheckins(cutoff: Date, now: Date, batchSize: number): Promise<number>
  clearAttendeeNames(cutoff: Date, batchSize: number): Promise<number>
  clearHostNotes(cutoff: Date, batchSize: number): Promise<number>
}
