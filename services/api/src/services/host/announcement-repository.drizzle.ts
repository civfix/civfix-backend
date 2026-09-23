import type { OrganizationRefDTO, PersonDTO } from "@civfix/shared"
import type { Sql } from "../../db/client.js"
import { PRESIGN_CONCURRENCY, mapWithLimit } from "../media-presign.js"
import { presentIds } from "../present-ids.js"
import { publicAuthorIdentity } from "../public-author.js"
import { publicServedKeyExpr } from "../media-served-key.js"

export type AnnouncementImagePresigner = (r2Key: string) => Promise<string>

export interface AnnouncementIdentityRepository {
  authorsFor(userIds: readonly (string | null)[]): Promise<Map<string, PersonDTO>>
  organizationFor(cleanupId: string): Promise<OrganizationRefDTO | null>
}

interface AuthorRowSelect {
  id: string
  display_name: string | null
  handle: string | null
  bio: string | null
  avatar_r2_key: string | null
  avatar_url: string | null
  deleted_at: Date | null
}

interface OrganizationRowSelect {
  id: string
  slug: string
  name: string
  verified_status: string
  verified_kind: OrganizationRefDTO["verifiedKind"]
  logo_key: string | null
}

export function makeDrizzleAnnouncementIdentityRepository(
  sql: Sql,
  presign: AnnouncementImagePresigner,
): AnnouncementIdentityRepository {
  return {
    async authorsFor(userIds) {
      const out = new Map<string, PersonDTO>()
      const ids = presentIds(userIds)
      if (ids.length === 0) return out
      const rows = await sql<AuthorRowSelect[]>`
        SELECT u.id, u.display_name, u.handle, u.bio,
               ${publicServedKeyExpr(sql, "am")} AS avatar_r2_key,
               u.avatar_url, u.deleted_at
          FROM users u
          LEFT JOIN media_assets am ON am.id = u.avatar_media_id
         WHERE u.id = ANY(${ids}::uuid[])
      `
      const resolved = await mapWithLimit(rows, PRESIGN_CONCURRENCY, async (row) => {
        const avatarUrl =
          row.deleted_at === null && row.avatar_r2_key !== null
            ? await presign(row.avatar_r2_key)
            : row.avatar_url
        const identity = publicAuthorIdentity({
          id: row.id,
          displayName: row.display_name,
          handle: row.handle,
          avatarUrl,
          deletedAt: row.deleted_at,
        })
        const person: PersonDTO = {
          id: row.id,
          name: identity.name,
          handle: identity.handle,
          bio: identity.deleted ? null : row.bio,
          avatar: identity.avatar,
          ...(identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
          followers: 0,
          following: 0,
          isFollowing: false,
          ...(identity.deleted ? { deleted: true } : {}),
        }
        return person
      })
      for (const person of resolved) out.set(person.id, person)
      return out
    },

    async organizationFor(cleanupId) {
      const rows = await sql<OrganizationRowSelect[]>`
        SELECT o.id, o.slug, o.name, o.verified_status, o.verified_kind,
               ${publicServedKeyExpr(sql, "am")} AS logo_key
          FROM cleanups c
          JOIN organizations o ON o.id = c.organization_id
          LEFT JOIN media_assets am ON am.id = o.logo_media_id
         WHERE c.id = ${cleanupId}
           AND o.deleted_at IS NULL
         LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      const logoUrl = row.logo_key === null ? null : await presign(row.logo_key)
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        logoUrl,
        verified: row.verified_status === "verified",
        verifiedKind: row.verified_kind,
      }
    },
  }
}
