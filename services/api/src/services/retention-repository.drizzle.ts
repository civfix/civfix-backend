import type { Sql } from "../db/client.js"
import type { RetentionRepository } from "./retention-repository.js"

export function makeDrizzleRetentionRepository(sql: Sql): RetentionRepository {
  return {
    deleteExpiredOtps(cutoff: Date, limit: number): Promise<{ id: string }[]> {
      return sql<{ id: string }[]>`
        DELETE FROM email_otps
        WHERE id IN (
          SELECT id FROM email_otps
          WHERE consumed_at IS NOT NULL OR expires_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING id
      `
    },

    deleteExpiredAnonTokens(cutoff: Date, limit: number): Promise<{ id: string }[]> {
      return sql<{ id: string }[]>`
        DELETE FROM anon_tokens
        WHERE id IN (
          SELECT id FROM anon_tokens
          WHERE expires_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING id
      `
    },

    deleteExpiredSessions(cutoff: Date, limit: number): Promise<{ id: string }[]> {
      return sql<{ id: string }[]>`
        DELETE FROM sessions
        WHERE id IN (
          SELECT id FROM sessions
          WHERE expires_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING id
      `
    },

    deleteOldIdempotencyKeys(cutoff: Date, limit: number): Promise<{ key: string }[]> {
      return sql<{ key: string }[]>`
        DELETE FROM idempotency_keys
        WHERE ctid IN (
          SELECT ctid FROM idempotency_keys
          WHERE created_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING key
      `
    },

    deleteOldNotifications(cutoff: Date, limit: number): Promise<{ id: string }[]> {
      return sql<{ id: string }[]>`
        DELETE FROM notifications
        WHERE id IN (
          SELECT id FROM notifications
          WHERE created_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING id
      `
    },

    deleteStaleGeocodeCache(cutoff: Date, limit: number): Promise<{ point_key: string }[]> {
      return sql<{ point_key: string }[]>`
        DELETE FROM geocode_cache
        WHERE point_key IN (
          SELECT point_key FROM geocode_cache
          WHERE resolved_at < ${cutoff}
          LIMIT ${limit}
        )
        RETURNING point_key
      `
    },
  }
}
