import type { Db } from "../db/client.js"

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0]

export interface TransferredEvent extends Record<string, unknown> {
  cleanup_id: string
  new_organizer: string
  title: string
}

export interface ErasureRepository {
  transferHostedEvents(tx: DbTransaction, userId: string): Promise<TransferredEvent[]>
  releaseOrganizations(tx: DbTransaction, userId: string): Promise<void>
  scrubAttendeeContributions(tx: DbTransaction, userId: string): Promise<string[]>
  scrubModerationSnapshots(tx: DbTransaction, userId: string): Promise<void>
  purgeVerificationDocuments(tx: DbTransaction, userId: string): Promise<string[]>
}
