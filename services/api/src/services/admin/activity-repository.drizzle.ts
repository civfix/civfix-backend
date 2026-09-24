/**
 * Postgres-backed ActivityRepository (Phase 2): the merged recent-activity feed (#6, enumeration 4.9).
 *
 * ONE union query across the four sources, capped at `limit`:
 *   - audit_log    (operator / gov actions) -> source 'audit'   (action + actor name + target); the L4
 *                  read audits are excluded here (see AUDIT_READ_ACTIONS)
 *   - reports      (a citizen dropped a pin) -> source 'report' (category subject + jurisdiction place +
 *                  reporter name); `visibility = 'public' AND deleted_at IS NULL` only. NOT the
 *                  publicReportFilter status set: an operator feed reports the pin DROP, so a `submitted`
 *                  or `held` report is exactly what the operator needs to see, and the queue it feeds is
 *                  operator-only. The two terms that ARE applied are the owner's opt-out and the delete.
 *   - cleanups     (a cleanup was planned)   -> source 'cleanup' (title subject + organizer name)
 *   - mail_events  (delivery events)         -> source 'mail_event' (type + thread org/jurisdiction)
 *
 * Each branch projects the SAME column set so the UNION ALL aligns; the outer query applies the ORDER BY
 * and the page cut. To bound the per-source scan each branch carries the SAME search predicate, keyset
 * predicate, ORDER BY and `limit + 1` cut as the outer query — a branch can therefore contribute at most
 * `limit + 1` rows, which is exactly what the outer has-more probe needs (a per-branch `limit` would make
 * the probe row unreachable whenever a single branch dominates the window, i.e. nextCursor would always be
 * null).
 *
 * KEYSET: (ts, id) with `id` compared AS TEXT in both the branch predicate and the outer ORDER BY. Every
 * source's pk is a uuid, so text order and uuid order coincide, and one text tuple gives the four sources a
 * single TOTAL order — without the id term two rows sharing a millisecond across sources could repeat or
 * skip across a page boundary.
 *
 * FILTERING: `filter` is an ActivityKind, which is a SERVICE-side classification. Rather than re-typing the
 * action prefixes in SQL, the branch set comes from `sourcesForKind` and the audit predicate is BUILT from
 * `AUDIT_ACTION_RULES` (activity-service.ts) — one vocabulary, so a chip can never filter out a row it also
 * labels. The catch-all kind (AUDIT_FALLBACK_KIND) is defined by exclusion and negates every rule.
 *
 * The service does the kind/hue/what classification; this repo only NORMALIZES and pages the rows.
 */

import type { Sql } from "../../db/client.js"
import { clampLimit, decodeCursor, paginate } from "./pagination.js"
import { AUDIT_READ_ACTIONS } from "./audit.js"
import { ilikeAnyOf, type SqlFragment } from "./sql-fragments.js"
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

/** A unioned activity row as selected back (snake_case; the common projection across all sources). */
interface ActivityRowSelect {
  source: ActivitySource
  id: string
  ts: Date
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

/** Construct the production ActivityRepository over the raw postgres-js tag (`container.getDb().sql`). */
export function makeDrizzleActivityRepository(sql: Sql): ActivityRepository {
  /**
   * The audit branch's kind predicate. For a kind that OWNS rules, match any of them; for the catch-all
   * kind, match NONE of them (that is what "everything else" means, and it must stay derived from the one
   * rule table or the chip drifts from the label).
   */
  function auditKindFilter(args: ListActivityArgs): SqlFragment {
    if (args.filter === "all") return sql``
    const own = auditRulesForKind(args.filter)
    if (own.length > 0) return sql`AND ${anyRule(own)}`
    if (args.filter === AUDIT_FALLBACK_KIND) return sql`AND NOT ${anyRule(AUDIT_ACTION_RULES)}`
    // The kind cannot come from the audit branch at all; sourcesForKind already pruned it, so this is
    // unreachable defense rather than a filter.
    return sql`AND false`
  }

  /** `(action LIKE 'p.%' OR action = 'x' OR ...)` over a rule list. */
  function anyRule(rules: readonly AuditActionRule[]): SqlFragment {
    // Prefixes are compile-time literals from AUDIT_ACTION_RULES, never user input, but they still ride as
    // bound parameters — LIKE's own metacharacters are not special in these dotted namespaces.
    const branches = rules.map((rule) =>
      rule.exact !== undefined
        ? sql`a.action = ${rule.exact}`
        : sql`a.action LIKE ${`${rule.prefix}%`}`,
    )
    const first = branches[0]
    if (first === undefined) return sql`(false)`
    return sql`(${branches.slice(1).reduce<SqlFragment>((acc, b) => sql`${acc} OR ${b}`, first)})`
  }

  /** The mail branch's kind predicate (bounced/failed vs everything else on the same type column). */
  function mailKindFilter(args: ListActivityArgs): SqlFragment {
    const types = [...MAIL_BOUNCE_EVENT_TYPES]
    if (args.filter === "outreach_bounce") return sql`AND e.type = ANY(${types}::text[])`
    if (args.filter === "outreach_open") return sql`AND e.type <> ALL(${types}::text[])`
    return sql``
  }

  return {
    async list(
      args: ListActivityArgs,
    ): Promise<{ records: ActivitySourceRecord[]; nextCursor: string | null }> {
      const limit = clampLimit(args.limit)
      // requireUuid is FALSE: the keyset compares `id::text`, never `${id}::uuid`, so a non-uuid id in a
      // hand-made cursor cannot raise a 22P02 — it simply anchors past every real row.
      const anchor = decodeCursor(args.cursor)
      const desc = args.sort === "newest"
      const sources = args.filter === "all" ? null : new Set(sourcesForKind(args.filter))
      const wants = (source: ActivitySource): boolean => sources === null || sources.has(source)

      /** The per-branch keyset + ORDER BY tail, parameterized on the branch's own ts/id expressions. */
      const pageWindow = (tsCol: SqlFragment, idText: SqlFragment): SqlFragment => {
        const keyset =
          anchor === null
            ? sql``
            : desc
              ? sql`AND (${tsCol}, ${idText}) < (${anchor.createdAt}, ${anchor.id}::text)`
              : sql`AND (${tsCol}, ${idText}) > (${anchor.createdAt}, ${anchor.id}::text)`
        const order = desc
          ? sql`ORDER BY ${tsCol} DESC, ${idText} DESC`
          : sql`ORDER BY ${tsCol} ASC, ${idText} ASC`
        return sql`${keyset} ${order} LIMIT ${limit + 1}`
      }

      const search = (columns: readonly SqlFragment[]): SqlFragment =>
        args.q === null ? sql`` : sql`AND ${ilikeAnyOf(sql, columns, args.q)}`

      const branches: SqlFragment[] = []

      if (wants("audit")) {
        branches.push(sql`(
          SELECT 'audit'::text AS source, a.id::text AS id, a.created_at AS ts,
                 u.display_name AS who, a.actor_id IS NULL AS actorless, a.target AS where_label,
                 a.action AS action, NULL::text AS event_type, a.target AS subject
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_id
          -- audit_log carries the L4 read audits too (one row per sensitive PAGE VIEW). Those are
          -- navigation, not activity: unfiltered they fill this branch's whole per-source window and evict
          -- every real action from the feed. They remain in the audit-log view.
          WHERE a.action <> ALL(${[...AUDIT_READ_ACTIONS]})
          ${auditKindFilter(args)}
          ${search([sql`a.action`, sql`u.display_name`, sql`a.target`])}
          ${pageWindow(sql`a.created_at`, sql`a.id::text`)}
        )`)
      }

      if (wants("report")) {
        branches.push(sql`(
          SELECT 'report'::text AS source, r.id::text AS id, r.created_at AS ts,
                 ru.display_name AS who, false AS actorless, j.name AS where_label,
                 NULL::text AS action, NULL::text AS event_type, r.category AS subject
          FROM reports r
          LEFT JOIN users ru ON ru.id = r.reporter_user_id
          LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
          WHERE r.deleted_at IS NULL AND r.visibility = 'public'
          ${search([sql`r.category`, sql`ru.display_name`, sql`j.name`])}
          -- reports.created_at is DEFAULT now() (effectively non-null on every row), so ordering on the
          -- bare column lets the (created_at) index serve the sort instead of a seq-scan+top-N heap sort.
          ${pageWindow(sql`r.created_at`, sql`r.id::text`)}
        )`)
      }

      if (wants("cleanup")) {
        branches.push(sql`(
          SELECT 'cleanup'::text AS source, c.id::text AS id, c.created_at AS ts,
                 cu.display_name AS who, false AS actorless, c.address AS where_label,
                 NULL::text AS action, NULL::text AS event_type, c.title AS subject
          FROM cleanups c
          LEFT JOIN users cu ON cu.id = c.organizer_user_id
          WHERE true
          ${search([sql`c.title`, sql`cu.display_name`, sql`c.address`])}
          -- cleanups.created_at is DEFAULT now() (set on insert, effectively non-null), so ordering on the
          -- bare column lets the (created_at) index serve the sort.
          ${pageWindow(sql`c.created_at`, sql`c.id::text`)}
        )`)
      }

      if (wants("mail_event")) {
        branches.push(sql`(
          SELECT 'mail_event'::text AS source, e.id::text AS id, e.created_at AS ts,
                 t.org AS who, false AS actorless, COALESCE(t.org, t.jurisdiction_geoid) AS where_label,
                 NULL::text AS action, e.type AS event_type, t.subject AS subject
          FROM mail_events e
          LEFT JOIN mail_threads t ON t.id = e.thread_id
          WHERE true
          ${mailKindFilter(args)}
          ${search([sql`e.type`, sql`t.org`, sql`t.jurisdiction_geoid`, sql`t.subject`])}
          ${pageWindow(sql`e.created_at`, sql`e.id::text`)}
        )`)
      }

      const first = branches[0]
      // No branch can produce the requested kind (today: filter=claim). An empty union is not valid SQL, so
      // the page ends here rather than issuing a query that cannot match.
      if (first === undefined) return { records: [], nextCursor: null }
      const union = branches
        .slice(1)
        .reduce<SqlFragment>((acc, branch) => sql`${acc} UNION ALL ${branch}`, first)

      const outerOrder = desc
        ? sql`ORDER BY feed.ts DESC, feed.id DESC`
        : sql`ORDER BY feed.ts ASC, feed.id ASC`
      // The union is wrapped in a FROM subquery (rather than trailing the branches with a bare ORDER BY) so
      // the shape is identical whether one branch survived the facet or all four did.
      const rows = await sql<ActivityRowSelect[]>`
        SELECT feed.* FROM (${union}) AS feed
        ${outerOrder}
        LIMIT ${limit + 1}
      `
      const { items, nextCursor } = paginate(rows, limit, (r) => ({ at: r.ts, id: r.id }))
      return { records: items.map(toRecord), nextCursor }
    },
  }
}
