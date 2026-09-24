/**
 * One UNION ALL over audit_log, reports, cleanups and mail_events.
 *
 * Reports use `visibility = 'public' AND deleted_at IS NULL` only, not the publicReportFilter status set:
 * the operator feed reports the pin drop, so a `submitted` or `held` report is exactly what the operator
 * needs to see. The two terms applied are the owner's opt-out and the delete.
 *
 * Each branch carries the same search predicate, keyset predicate, ORDER BY and `limit + 1` cut as the
 * outer query, which bounds the per-source scan. A per-branch `limit` would make the outer has-more probe
 * row unreachable whenever one branch dominates the window, so nextCursor would always be null.
 *
 * Keyset: (ts, id) with `id` compared as text in both the branch predicate and the outer ORDER BY. Every
 * source's pk is a uuid, so text and uuid order coincide and one text tuple gives the four sources a
 * single total order. The cursor carries ts at microsecond precision (`cursor_at`) because a millisecond
 * anchor would re-include the previous page's last row on `oldest` and skip same-millisecond rows on
 * `newest`.
 *
 * `filter` is a service-side classification, so the branch set comes from `sourcesForKind` and the audit
 * predicate is built from `AUDIT_ACTION_RULES` rather than re-typing prefixes in SQL: a chip can never
 * filter out a row it also labels.
 */

import type { Sql } from "../../db/client.js"
import {
  clampLimit,
  decodeCursor,
  keysetInstant,
  keysetPredicate,
  paginateKeyset,
  type KeysetAnchor,
} from "./pagination.js"
import { AUDIT_READ_ACTIONS } from "./audit.js"
import { likePrefix } from "./like.js"
import { anyOf, ilikeAnyOf, type SqlFragment } from "./sql-fragments.js"
import {
  AUDIT_ACTION_RULES,
  AUDIT_FALLBACK_KIND,
  MAIL_BOUNCE_EVENT_TYPES,
  auditRulesForKind,
  sourcesForKind,
  type ActivityRepository,
  type AuditActionRule,
  type ActivitySource,
  type ActivitySourceRecord,
  type ListActivityArgs,
} from "./activity-service.js"

interface ActivityRowSelect {
  source: ActivitySource
  id: string
  ts: Date
  cursor_at: string
  who: string | null
  actorless: boolean
  where_label: string | null
  action: string | null
  event_type: string | null
  subject: string | null
}

function toRecord(r: ActivityRowSelect): ActivitySourceRecord {
  return {
    source: r.source,
    id: r.id,
    ts: r.ts,
    who: r.who ?? "",
    actorless: r.actorless,
    where: r.where_label ?? "",
    action: r.action,
    eventType: r.event_type,
    subject: r.subject,
  }
}

interface PageSpec {
  anchor: KeysetAnchor | null
  desc: boolean
  limit: number
}

type BranchBuilder = (sql: Sql, args: ListActivityArgs, page: PageSpec) => SqlFragment

// The catch-all kind matches none of the rules; it must stay derived from the one rule table or the chip
// drifts from the label.
function auditKindFilter(sql: Sql, args: ListActivityArgs): SqlFragment {
  if (args.filter === "all") return sql``
  const own = auditRulesForKind(args.filter)
  if (own.length > 0) return sql`AND ${anyRule(sql, own)}`
  if (args.filter === AUDIT_FALLBACK_KIND) return sql`AND NOT ${anyRule(sql, AUDIT_ACTION_RULES)}`
  // The kind cannot come from the audit branch at all; sourcesForKind already pruned it, so this is
  // unreachable defense rather than a filter.
  return sql`AND false`
}

function anyRule(sql: Sql, rules: readonly AuditActionRule[]): SqlFragment {
  // The prefixes contain `_` (gov_claim.), a LIKE wildcard, so they are escaped to match literally, as
  // the service classifier's startsWith does.
  return anyOf(
    sql,
    rules.map((rule) =>
      rule.exact !== undefined
        ? sql`a.action = ${rule.exact}`
        : sql`a.action LIKE ${likePrefix(rule.prefix)} ESCAPE '\\'`,
    ),
  )
}

function mailKindFilter(sql: Sql, args: ListActivityArgs): SqlFragment {
  const types = [...MAIL_BOUNCE_EVENT_TYPES]
  if (args.filter === "outreach_bounce") return sql`AND e.type = ANY(${types}::text[])`
  if (args.filter === "outreach_open") return sql`AND e.type <> ALL(${types}::text[])`
  return sql``
}

function pageWindow(
  sql: Sql,
  page: PageSpec,
  tsCol: SqlFragment,
  idText: SqlFragment,
): SqlFragment {
  const keyset =
    page.anchor === null
      ? sql``
      : sql`AND ${keysetPredicate(sql, tsCol, idText, page.anchor, {
          direction: page.desc ? "desc" : "asc",
          idType: "text",
        })}`
  const order = page.desc
    ? sql`ORDER BY ${tsCol} DESC, ${idText} DESC`
    : sql`ORDER BY ${tsCol} ASC, ${idText} ASC`
  return sql`${keyset} ${order} LIMIT ${page.limit + 1}`
}

function searchFilter(sql: Sql, q: string | null, columns: readonly SqlFragment[]): SqlFragment {
  return q === null ? sql`` : sql`AND ${ilikeAnyOf(sql, columns, q)}`
}

function auditBranch(sql: Sql, args: ListActivityArgs, page: PageSpec): SqlFragment {
  return sql`(
          SELECT 'audit'::text AS source, a.id::text AS id, a.created_at AS ts,
                 ${keysetInstant(sql, sql`a.created_at`)} AS cursor_at,
                 u.display_name AS who, a.actor_id IS NULL AS actorless, a.target AS where_label,
                 a.action AS action, NULL::text AS event_type, a.target AS subject
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_id
          -- Read audits (one row per sensitive page view) are navigation, not activity: unfiltered they
          -- fill this branch's whole per-source window and evict every real action from the feed. They
          -- remain in the audit-log view.
          WHERE a.action <> ALL(${[...AUDIT_READ_ACTIONS]})
          ${auditKindFilter(sql, args)}
          ${searchFilter(sql, args.q, [sql`a.action`, sql`u.display_name`, sql`a.target`])}
          ${pageWindow(sql, page, sql`a.created_at`, sql`a.id::text`)}
        )`
}

function reportBranch(sql: Sql, args: ListActivityArgs, page: PageSpec): SqlFragment {
  return sql`(
          SELECT 'report'::text AS source, r.id::text AS id, r.created_at AS ts,
                 ${keysetInstant(sql, sql`r.created_at`)} AS cursor_at,
                 ru.display_name AS who, false AS actorless, j.name AS where_label,
                 NULL::text AS action, NULL::text AS event_type, r.category AS subject
          FROM reports r
          LEFT JOIN users ru ON ru.id = r.reporter_user_id
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          WHERE r.deleted_at IS NULL AND r.visibility = 'public'
          ${searchFilter(sql, args.q, [sql`r.category`, sql`ru.display_name`, sql`j.name`])}
          -- reports.created_at is DEFAULT now() (effectively non-null on every row), so ordering on the
          -- bare column lets the (created_at) index serve the sort instead of a seq-scan+top-N heap sort.
          ${pageWindow(sql, page, sql`r.created_at`, sql`r.id::text`)}
        )`
}

function cleanupBranch(sql: Sql, args: ListActivityArgs, page: PageSpec): SqlFragment {
  return sql`(
          SELECT 'cleanup'::text AS source, c.id::text AS id, c.created_at AS ts,
                 ${keysetInstant(sql, sql`c.created_at`)} AS cursor_at,
                 cu.display_name AS who, false AS actorless, c.address AS where_label,
                 NULL::text AS action, NULL::text AS event_type, c.title AS subject
          FROM cleanups c
          LEFT JOIN users cu ON cu.id = c.organizer_user_id
          WHERE true
          ${searchFilter(sql, args.q, [sql`c.title`, sql`cu.display_name`, sql`c.address`])}
          -- cleanups.created_at is DEFAULT now() (set on insert, effectively non-null), so ordering on the
          -- bare column lets the (created_at) index serve the sort.
          ${pageWindow(sql, page, sql`c.created_at`, sql`c.id::text`)}
        )`
}

function mailEventBranch(sql: Sql, args: ListActivityArgs, page: PageSpec): SqlFragment {
  return sql`(
          SELECT 'mail_event'::text AS source, e.id::text AS id, e.created_at AS ts,
                 ${keysetInstant(sql, sql`e.created_at`)} AS cursor_at,
                 t.org AS who, false AS actorless, COALESCE(t.org, t.jurisdiction_geoid) AS where_label,
                 NULL::text AS action, e.type AS event_type, t.subject AS subject
          FROM mail_events e
          LEFT JOIN mail_threads t ON t.id = e.thread_id
          WHERE true
          ${mailKindFilter(sql, args)}
          ${searchFilter(sql, args.q, [sql`e.type`, sql`t.org`, sql`t.jurisdiction_geoid`, sql`t.subject`])}
          ${pageWindow(sql, page, sql`e.created_at`, sql`e.id::text`)}
        )`
}

// Union order is fixed so the statement text is the same for every request that selects the same sources.
const SOURCE_BRANCHES: readonly (readonly [ActivitySource, BranchBuilder])[] = [
  ["audit", auditBranch],
  ["report", reportBranch],
  ["cleanup", cleanupBranch],
  ["mail_event", mailEventBranch],
]

export function makeDrizzleActivityRepository(sql: Sql): ActivityRepository {
  return {
    async list(
      args: ListActivityArgs,
    ): Promise<{ records: ActivitySourceRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      // requireUuid is false: the keyset compares `id::text`, never `${id}::uuid`, so a non-uuid id in a
      // hand-made cursor cannot raise a 22P02; it simply anchors past every real row.
      const page: PageSpec = {
        anchor: decodeCursor(args.cursor),
        desc: args.sort === "newest",
        limit,
      }
      const sources = args.filter === "all" ? null : new Set(sourcesForKind(args.filter))
      const branches = SOURCE_BRANCHES.filter(
        ([source]) => sources === null || sources.has(source),
      ).map(([, build]) => build(sql, args, page))

      const first = branches[0]
      // No branch can produce the requested kind (today: filter=claim). An empty union is not valid SQL, so
      // the page ends here rather than issuing a query that cannot match.
      if (first === undefined) return { records: [], nextCursor: null }
      const union = branches
        .slice(1)
        .reduce<SqlFragment>((acc, branch) => sql`${acc} UNION ALL ${branch}`, first)

      const outerOrder = page.desc
        ? sql`ORDER BY feed.ts DESC, feed.id DESC`
        : sql`ORDER BY feed.ts ASC, feed.id ASC`
      // The union is wrapped in a FROM subquery (rather than trailing the branches with a bare ORDER BY) so
      // the shape is identical whether one branch survived the facet or all four did.
      const rows = await sql<ActivityRowSelect[]>`
        SELECT feed.* FROM (${union}) AS feed
        ${outerOrder}
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginateKeyset(rows, limit, (r) => ({
        atText: r.cursor_at,
        id: r.id,
      }))
      return { records: items.map(toRecord), nextCursor }
    },
  }
}
