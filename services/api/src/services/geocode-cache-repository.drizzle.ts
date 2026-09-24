import type { Queryable } from "../db/client.js"
import type { GeocodeCacheRepository, GeocodeCacheRowSelect } from "./geocode-cache-repository.js"

export function makeDrizzleGeocodeCacheRepository(sql: Queryable): GeocodeCacheRepository {
  return {
    async findByPointKey(pointKey) {
      const rows = await sql<GeocodeCacheRowSelect[]>`
        SELECT address, address_precision, city_state_label, provider, resolved_at
        FROM geocode_cache
        WHERE point_key = ${pointKey}
        LIMIT 1
      `
      return rows[0]
    },

    async upsert(pointKey, entry, now) {
      await sql`
        INSERT INTO geocode_cache (
          point_key, address, address_precision, city_state_label, provider, resolved_at
        ) VALUES (
          ${pointKey},
          ${entry.address},
          ${entry.precision},
          ${entry.cityStateLabel},
          ${entry.provider},
          ${now()}
        )
        ON CONFLICT (point_key) DO UPDATE SET
          address = EXCLUDED.address,
          address_precision = EXCLUDED.address_precision,
          city_state_label = EXCLUDED.city_state_label,
          provider = EXCLUDED.provider,
          resolved_at = EXCLUDED.resolved_at
      `
    },
  }
}
