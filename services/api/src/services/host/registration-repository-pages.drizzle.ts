import type { Queryable, Sql, TransactionSql } from "../../db/client.js"
import { mediaBoundElsewhere, mediaBoundToCleanup, uploadedByClaimant } from "../media-bindings.js"
import { userUploader } from "../media-uploader.js"
import { publicServedKeyExpr } from "../media-served-key.js"
import { isUniqueViolationOn } from "../../db/pg-errors.js"
import { pageColumns, pageJoins, toPageRecord, type PageRowSelect } from "./registration-sql.js"
import {
  eventContextIn,
  loadLiveQuestions,
  loadPage,
  loadTicketTypes,
} from "./registration-repository-load.drizzle.js"
import type {
  HostRegistrationRepository,
  PageRecord,
  PublicPageRecord,
  PublishPageOutcome,
  SavePageArgs,
  SavePageOutcome,
} from "./registration-repository.types.js"

const PAGE_SLUG_CONSTRAINT = "cleanups_page_slug_uidx"

const DEFAULT_THEME_ACCENT = "bloom"

export type PageMethods = Pick<
  HostRegistrationRepository,
  "getPage" | "mediaKeysFor" | "savePage" | "publishPage" | "slugTaken" | "getPublicPage"
>

type PublishPageArgs = Parameters<HostRegistrationRepository["publishPage"]>[0]

async function claimPageMediaInTx(
  tx: Queryable,
  cleanupId: string,
  mediaIds: readonly string[],
  asCover: "event_cover" | null,
  claimantUserId: string,
): Promise<string[]> {
  const wanted = [...new Set(mediaIds)]
  if (wanted.length === 0) return []
  const claimed = await tx<{ id: string }[]>`
    UPDATE media_assets
    SET purpose = ${
      asCover === null
        ? tx`CASE WHEN media_assets.purpose IN ('event_cover', 'event_gallery')
                  THEN media_assets.purpose ELSE 'event_gallery' END`
        : tx`'event_cover'`
    }
    WHERE media_assets.id = ANY(${wanted}::uuid[])
      AND media_assets.purpose <> 'verification'
      AND media_assets.report_id IS NULL
      AND media_assets.post_id IS NULL
      AND media_assets.chat_message_id IS NULL
      AND (
        media_assets.status = 'ready'
        OR (media_assets.status = 'validating' AND media_assets.finalized_at IS NOT NULL)
      )
      AND NOT (${mediaBoundElsewhere(tx, cleanupId)})
      AND (
        (${mediaBoundToCleanup(tx, cleanupId)})
        OR (${uploadedByClaimant(tx, [userUploader(claimantUserId)])})
      )
    RETURNING media_assets.id
  `
  return claimed.map((row) => row.id)
}

async function claimCoverIn(tx: TransactionSql, args: SavePageArgs): Promise<boolean> {
  if (args.coverMediaId === undefined) return true
  if (args.coverMediaId !== null) {
    const claimed = await claimPageMediaInTx(
      tx,
      args.cleanupId,
      [args.coverMediaId],
      "event_cover",
      args.actorUserId,
    )
    if (claimed.length !== 1) return false
  }
  await tx`
    UPDATE cleanups SET cover_media_id = ${args.coverMediaId}
     WHERE id = ${args.cleanupId}
  `
  return true
}

async function syncPageMediaIn(
  tx: TransactionSql,
  cleanupId: string,
  blockIds: readonly string[],
): Promise<void> {
  await tx`
    DELETE FROM cleanup_page_media
     WHERE cleanup_id = ${cleanupId}
       AND NOT (media_id = ANY(${blockIds}::uuid[]))
  `
  if (blockIds.length === 0) return
  await tx`
    INSERT INTO cleanup_page_media (cleanup_id, media_id)
    SELECT ${cleanupId}::uuid, t.id FROM unnest(${blockIds}::uuid[]) AS t(id)
    ON CONFLICT (cleanup_id, media_id) DO NOTHING
  `
}

async function upsertPageRowIn(tx: TransactionSql, args: SavePageArgs): Promise<void> {
  const blocks = tx.json(args.blocks as unknown as Parameters<typeof tx.json>[0])
  const seo =
    args.seo === undefined ? null : tx.json(args.seo as unknown as Parameters<typeof tx.json>[0])
  await tx`
    INSERT INTO cleanup_pages (
      cleanup_id, status, theme_accent, blocks, seo, created_at, updated_at
    ) VALUES (
      ${args.cleanupId}, 'draft', ${args.themeAccent ?? DEFAULT_THEME_ACCENT}, ${blocks},
      COALESCE(${seo}, '{}'::jsonb), ${args.now}, ${args.now}
    )
    ON CONFLICT (cleanup_id) DO UPDATE SET
      theme_accent = COALESCE(${args.themeAccent ?? null}, cleanup_pages.theme_accent),
      blocks = EXCLUDED.blocks,
      seo = COALESCE(${seo}, cleanup_pages.seo),
      updated_at = ${args.now}
  `
}

async function savePageIn(tx: TransactionSql, args: SavePageArgs): Promise<SavePageOutcome> {
  const locked = await tx<{ id: string }[]>`
    SELECT id FROM cleanups WHERE id = ${args.cleanupId} LIMIT 1 FOR SHARE
  `
  if (locked[0] === undefined) return { kind: "not_found" }

  const blockIds = [...new Set(args.blockMediaIds)]
  if (blockIds.length > 0) {
    const claimed = await claimPageMediaInTx(tx, args.cleanupId, blockIds, null, args.actorUserId)
    if (claimed.length !== blockIds.length) return { kind: "block_media_not_found" }
  }

  if (!(await claimCoverIn(tx, args))) return { kind: "cover_not_found" }
  await syncPageMediaIn(tx, args.cleanupId, blockIds)

  if (args.slug !== undefined) {
    await tx`
      UPDATE cleanups SET page_slug = ${args.slug} WHERE id = ${args.cleanupId}
    `
  }

  await upsertPageRowIn(tx, args)

  const record = await loadPage(tx, args.cleanupId)
  if (record === null) return { kind: "not_found" }
  return { kind: "saved", record }
}

async function pageRefusalAfterNoUpdate(
  sql: Sql,
  args: PublishPageArgs,
): Promise<PublishPageOutcome> {
  if (!args.published) return { kind: "not_found" }
  const flagged = await sql<{ flagged_at: Date | null }[]>`
    SELECT flagged_at FROM cleanup_pages WHERE cleanup_id = ${args.cleanupId} LIMIT 1
  `
  const row = flagged[0]
  return row !== undefined && row.flagged_at !== null ? { kind: "flagged" } : { kind: "not_found" }
}

export function makePageMethods(sql: Sql): PageMethods {
  return {
    async getPage(cleanupId: string): Promise<PageRecord | null> {
      return loadPage(sql, cleanupId)
    },

    async mediaKeysFor(
      cleanupId: string,
      mediaIds: readonly string[],
    ): Promise<Map<string, string>> {
      const out = new Map<string, string>()
      if (mediaIds.length === 0) return out
      const rows = await sql<{ id: string; served_key: string }[]>`
        SELECT media_assets.id, ${publicServedKeyExpr(sql, "media_assets")} AS served_key
          FROM media_assets
         WHERE media_assets.id = ANY(${[...new Set(mediaIds)]}::uuid[])
           AND media_assets.status = 'ready'
           AND media_assets.served_key IS NOT NULL
           AND (${mediaBoundToCleanup(sql, cleanupId)})
      `
      for (const row of rows) out.set(row.id, row.served_key)
      return out
    },

    async savePage(args: SavePageArgs): Promise<SavePageOutcome> {
      try {
        return await sql.begin((tx) => savePageIn(tx, args))
      } catch (err) {
        if (isUniqueViolationOn(err, PAGE_SLUG_CONSTRAINT)) return { kind: "slug_taken" }
        throw err
      }
    },

    async publishPage(args: PublishPageArgs): Promise<PublishPageOutcome> {
      // The flag is re-checked in the write: an operator may flag the page after the service read it.
      const rows = await sql<{ cleanup_id: string }[]>`
        UPDATE cleanup_pages
           SET status = ${args.published ? "published" : "unpublished"},
               published_at = ${args.published ? args.now : sql`published_at`},
               published_by = ${args.published ? args.actorId : sql`published_by`},
               updated_at = ${args.now}
         WHERE cleanup_id = ${args.cleanupId}
           AND (NOT ${args.published} OR flagged_at IS NULL)
        RETURNING cleanup_id
      `
      if (rows.length === 0) return pageRefusalAfterNoUpdate(sql, args)
      const record = await loadPage(sql, args.cleanupId)
      return record === null ? { kind: "not_found" } : { kind: "published", record }
    },

    async slugTaken(cleanupId: string, slug: string): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM cleanups
         WHERE page_slug = ${slug} AND id <> ${cleanupId}
         LIMIT 1
      `
      return rows.length > 0
    },

    async getPublicPage(slug: string): Promise<PublicPageRecord | null> {
      const rows = await sql<
        (PageRowSelect & { donation_url: string | null; logo_key: string | null })[]
      >`
        SELECT ${pageColumns(sql)},
               c.donation_url,
               ${publicServedKeyExpr(sql, "lm")} AS logo_key
          FROM cleanups c
          ${pageJoins(sql)}
          LEFT JOIN organizations o ON o.id = c.organization_id AND o.deleted_at IS NULL
          LEFT JOIN media_assets lm ON lm.id = o.logo_media_id AND lm.status = 'ready'
         WHERE c.page_slug = ${slug}
         LIMIT 1
      `
      const row = rows[0]
      if (row === undefined) return null
      const event = await eventContextIn(sql, row.cleanup_id)
      if (event === null) return null
      return {
        page: toPageRecord(row),
        event,
        ticketTypes: await loadTicketTypes(sql, [row.cleanup_id]),
        questions: await loadLiveQuestions(sql, row.cleanup_id),
        organizationId: event.organizationId,
        donationUrl: row.donation_url,
        logoKey: row.logo_key,
      }
    },
  }
}
