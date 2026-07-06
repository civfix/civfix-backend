
import type postgres from "postgres"
import type { JurisdictionLayer, ReportCategory } from "@civfix/shared"
import type { Queryable, Sql } from "../../db/client.js"
import { decodeCursor, encodeCursor, clampLimit } from "./pagination.js"
import { writeAudit } from "./audit.js"
import { likeContains } from "./like.js"
import {
  DISCOVERY_CATEGORIES,
  computeContactState,
  type DiscoveryContactRecord,
  type DiscoveryContactSuggestionRecord,
  type DiscoveryDetailRecord,
  type DiscoveryNoteRecord,
  type DiscoveryRepository,
  type DiscoverySamplePinRecord,
  type DiscoveryTaskRecord,
  type ListDiscoveryArgs,
} from "./discovery-service.js"

type SqlFragment = postgres.Fragment

const SAMPLE_PIN_CAP = 50

const DISCOVERY_NOTE_CAP = 200

interface TaskAggRow {
  id: string
  geoid: string | null
  place: string | null
  layer: string | null
  population: number | null
  status: string
  total: string
  oldest_waiting_at: Date | null
  newest_waiting_at: Date | null
  cat_trash: string
  cat_recycling: string
  cat_graffiti: string
  cat_hazard: string
  cat_encampment: string
  cat_water: string
  cat_other: string
  contact_categories: string[] | null
  has_default_contact: boolean
}

function toTaskRecord(r: TaskAggRow): DiscoveryTaskRecord {
  const perCategory: Partial<Record<ReportCategory, number>> = {}
  const counts: Record<ReportCategory, string> = {
    trash: r.cat_trash,
    recycling: r.cat_recycling,
    graffiti: r.cat_graffiti,
    hazard: r.cat_hazard,
    encampment: r.cat_encampment,
    water: r.cat_water,
    other: r.cat_other,
  }
  for (const category of DISCOVERY_CATEGORIES) {
    const n = Number(counts[category] ?? "0")
    if (n > 0) perCategory[category] = n
  }
  const rawContacts = r.contact_categories ?? []
  const contactCategories = rawContacts.filter((c): c is ReportCategory =>
    (DISCOVERY_CATEGORIES as readonly string[]).includes(c),
  )
  return {
    id: r.id,
    geoid: r.geoid ?? "",
    place: r.place ?? r.geoid ?? "",
    layer: (r.layer ?? "place") as JurisdictionLayer,
    population: r.population,
    status: r.status,
    perCategory,
    total: Number(r.total ?? "0"),
    oldestWaitingAt: r.oldest_waiting_at,
    newestWaitingAt: r.newest_waiting_at,
    contactCategories,
    hasDefaultContact: r.has_default_contact,
  }
}

const LIST_FETCH_CAP = 1000

async function taskAggregateSql(
  sql: Queryable,
  extraWhere: SqlFragment,
  extraTail: SqlFragment = sql``,
): Promise<TaskAggRow[]> {
  const rows = await sql`
    SELECT
      t.id,
      t.geoid,
      j.name AS place,
      j.layer AS layer,
      COALESCE(j.population, t.population) AS population,
      t.status,
      COALESCE(w.total, 0)::text AS total,
      w.oldest_waiting_at,
      w.newest_waiting_at,
      COALESCE(w.cat_trash, 0)::text AS cat_trash,
      COALESCE(w.cat_recycling, 0)::text AS cat_recycling,
      COALESCE(w.cat_graffiti, 0)::text AS cat_graffiti,
      COALESCE(w.cat_hazard, 0)::text AS cat_hazard,
      COALESCE(w.cat_encampment, 0)::text AS cat_encampment,
      COALESCE(w.cat_water, 0)::text AS cat_water,
      COALESCE(w.cat_other, 0)::text AS cat_other,
      c.categories AS contact_categories,
      COALESCE(c.has_default, false)
        OR (j.contact_emails IS NOT NULL AND array_length(j.contact_emails, 1) > 0) AS has_default_contact
    FROM jurisdiction_discovery_tasks t
    LEFT JOIN jurisdictions j ON j.geoid = t.geoid
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total,
        MIN(r.created_at) AS oldest_waiting_at,
        MAX(r.created_at) AS newest_waiting_at,
        COUNT(*) FILTER (WHERE r.category = 'trash') AS cat_trash,
        COUNT(*) FILTER (WHERE r.category = 'recycling') AS cat_recycling,
        COUNT(*) FILTER (WHERE r.category = 'graffiti') AS cat_graffiti,
        COUNT(*) FILTER (WHERE r.category = 'hazard') AS cat_hazard,
        COUNT(*) FILTER (WHERE r.category = 'encampment') AS cat_encampment,
        COUNT(*) FILTER (WHERE r.category = 'water') AS cat_water,
        COUNT(*) FILTER (WHERE r.category = 'other') AS cat_other
      FROM reports r
      WHERE r.jurisdiction_geoid = t.geoid
        AND r.deleted_at IS NULL
        AND r.status NOT IN ('rejected', 'resolved')
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT
        array_agg(jc.category) FILTER (WHERE jc.category IS NOT NULL) AS categories,
        bool_or(jc.category IS NULL) AS has_default
      FROM jurisdiction_contacts jc
      WHERE jc.geoid = t.geoid
        AND (jc.email IS NOT NULL AND jc.email <> '')
    ) c ON true
    WHERE t.status <> 'done'
    ${extraWhere}
    ${extraTail}
  `
  return rows as unknown as TaskAggRow[]
}

export function makeDrizzleDiscoveryRepository(sql: Sql): DiscoveryRepository {
  return {
    async listTasks(
      args: ListDiscoveryArgs,
    ): Promise<{ records: DiscoveryTaskRecord[]; nextCursor: string | null }> {
      const search =
        args.q !== null
          ? (() => {
              const like = likeContains(args.q)
              return sql`AND (j.name ILIKE ${like} ESCAPE '\\' OR t.geoid ILIKE ${like} ESCAPE '\\')`
            })()
          : sql``
      const order =
        args.sort === "reports"
          ? sql`ORDER BY COALESCE(w.total, 0) DESC, t.id DESC`
          : sql`ORDER BY COALESCE(j.population, t.population, 0) DESC, t.id DESC`
      const rows = await taskAggregateSql(sql, search, sql`${order} LIMIT ${LIST_FETCH_CAP}`)
      let records = rows.map(toTaskRecord)

      if (args.filter === "attention") {
        records = records.filter((r) => computeContactState(r).missing.length > 0)
      } else if (args.filter === "clear") {
        records = records.filter((r) => computeContactState(r).missing.length === 0)
      }

      const limit = clampLimit(args.limit)
      const anchor = decodeCursor(args.cursor)
      let start = 0
      if (anchor) {
        const idx = records.findIndex((r) => r.id === anchor.id)
        start = idx >= 0 ? idx + 1 : records.length
      }
      const slice = records.slice(start, start + limit + 1)
      if (slice.length <= limit) {
        return { records: slice, nextCursor: null }
      }
      const page = slice.slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor = last ? encodeCursor({ createdAt: new Date(0), id: last.id }) : null
      return { records: page, nextCursor }
    },

    async getDetail(id: string): Promise<DiscoveryDetailRecord | null> {
      const rows = await taskAggregateSql(sql, sql`AND t.id = ${id}`)
      const row = rows[0]
      if (!row) return null
      const task = toTaskRecord(row)

      const [contacts, samplePins, geo] = await Promise.all([
        loadContacts(sql, task.geoid),
        loadSamplePins(sql, task.geoid),
        loadGeometry(sql, id, task.geoid),
      ])

      return {
        task,
        contacts,
        placeGeojson: geo.placeGeojson,
        samplePins,
        center: geo.center,
        zoom: geo.zoom,
      }
    },

    async listNotes(id: string): Promise<DiscoveryNoteRecord[]> {
      const rows = await sql<{ text: string | null; who: string | null; created_at: Date }[]>`
        SELECT text, who, created_at
        FROM (
          SELECT
            meta->>'text' AS text,
            meta->>'who' AS who,
            created_at,
            id
          FROM audit_log
          WHERE action = 'discovery.note_added'
            AND target = ${"discovery:" + id}
          ORDER BY created_at DESC, id DESC
          LIMIT ${DISCOVERY_NOTE_CAP}
        ) recent
        ORDER BY created_at ASC, id ASC
      `
      return rows
        .filter((r) => r.text !== null)
        .map((r) => ({ text: r.text ?? "", who: r.who ?? "operator", createdAt: r.created_at }))
    },

    async listContactSuggestions(geoid: string): Promise<DiscoveryContactSuggestionRecord[]> {
      const rows = await sql<
        { email: string | null; form_url: string | null; note: string | null; created_at: Date }[]
      >`
        SELECT email, form_url, note, created_at
        FROM (
          SELECT
            meta->>'email' AS email,
            meta->>'formUrl' AS form_url,
            meta->>'note' AS note,
            created_at,
            id
          FROM audit_log
          WHERE action = 'discovery.contact_suggested'
            AND target = ${"jurisdiction:" + geoid}
          ORDER BY created_at DESC, id DESC
          LIMIT ${DISCOVERY_NOTE_CAP}
        ) recent
        ORDER BY created_at ASC, id ASC
      `
      return rows.map((r) => ({
        email: r.email,
        formUrl: r.form_url,
        note: r.note,
        createdAt: r.created_at,
      }))
    },

    async getTask(id: string): Promise<DiscoveryTaskRecord | null> {
      const rows = await taskAggregateSql(sql, sql`AND t.id = ${id}`)
      const row = rows[0]
      return row ? toTaskRecord(row) : null
    },

    async addNote(
      id: string,
      input: { text: string; actorId: string | null; who: string },
    ): Promise<DiscoveryNoteRecord> {
      const auditId = await writeAudit(sql, {
        actorId: input.actorId,
        action: "discovery.note_added",
        target: `discovery:${id}`,
        meta: { text: input.text, who: input.who },
      })
      const rows = await sql<{ created_at: Date }[]>`
        SELECT created_at FROM audit_log WHERE id = ${auditId} LIMIT 1
      `
      const createdAt = rows[0]?.created_at ?? new Date()
      return { text: input.text, who: input.who, createdAt }
    },

    async flagTask(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const taskRows = await tx<{ sample_report_id: string | null }[]>`
          SELECT sample_report_id FROM jurisdiction_discovery_tasks WHERE id = ${id} LIMIT 1
        `
        const task = taskRows[0]
        if (!task) return false

        if (task.sample_report_id !== null) {
          await tx`
            INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
            VALUES ('report', ${task.sample_report_id}, 'manual', 'api')
          `
        }
        await tx`
          UPDATE jurisdiction_discovery_tasks SET status = 'in_progress' WHERE id = ${id}
        `
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "discovery.flagged",
          target: `discovery:${id}`,
          meta: { reason: input.reason },
        })
        return true
      })
    },

    async saveDraft(
      id: string,
      input: {
        contacts: Partial<Record<ReportCategory, string | null>>
        defaultEmails: string[]
        formUrl: string | null
        actorId: string | null
      },
    ): Promise<boolean> {
      return sql.begin(async (tx) => {
        const taskRows = await tx<{ geoid: string | null }[]>`
          SELECT geoid FROM jurisdiction_discovery_tasks WHERE id = ${id} LIMIT 1
        `
        const task = taskRows[0]
        if (!task || task.geoid === null) return false
        const geoid = task.geoid

        await upsertJurisdictionContacts(tx, geoid, input.contacts, input.defaultEmails, input.formUrl)
        await writeAudit(tx, {
          actorId: input.actorId,
          action: "discovery.draft_saved",
          target: `discovery:${id}`,
          meta: {
            geoid,
            categories: Object.keys(input.contacts),
            defaultEmails: input.defaultEmails,
          },
        })
        return true
      })
    },

    async materializeDiscoveryTask(input: {
      geoid: string
      population?: number | null
    }): Promise<boolean> {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO jurisdiction_discovery_tasks (geoid, population, sample_report_id)
        SELECT
          ${input.geoid},
          COALESCE(${input.population ?? null}, j.population),
          (SELECT r.id FROM reports r
             WHERE r.jurisdiction_geoid = ${input.geoid} AND r.deleted_at IS NULL
             ORDER BY r.created_at DESC LIMIT 1)
        FROM jurisdictions j WHERE j.geoid = ${input.geoid}
        ON CONFLICT (geoid) WHERE status <> 'done' DO NOTHING
        RETURNING id
      `
      return rows.length > 0
    },
  }
}

async function loadContacts(sql: Queryable, geoid: string): Promise<DiscoveryContactRecord[]> {
  const rows = await sql<{ category: string | null; email: string | null }[]>`
    SELECT category, email
    FROM jurisdiction_contacts
    WHERE geoid = ${geoid} AND category IS NOT NULL
    ORDER BY category ASC
  `
  return rows
    .filter((r): r is { category: ReportCategory; email: string | null } =>
      r.category !== null && (DISCOVERY_CATEGORIES as readonly string[]).includes(r.category),
    )
    .map((r) => ({ category: r.category, email: r.email }))
}

async function loadSamplePins(sql: Queryable, geoid: string): Promise<DiscoverySamplePinRecord[]> {
  const rows = await sql<{ category: ReportCategory; lat: number; lng: number }[]>`
    SELECT category, ST_Y(geom) AS lat, ST_X(geom) AS lng
    FROM reports
    WHERE jurisdiction_geoid = ${geoid}
      AND deleted_at IS NULL
      AND status NOT IN ('rejected', 'resolved')
    ORDER BY created_at DESC
    LIMIT ${SAMPLE_PIN_CAP}
  `
  return rows.map((r) => ({ category: r.category, lat: r.lat, lng: r.lng }))
}

async function loadGeometry(
  sql: Queryable,
  taskId: string,
  geoid: string,
): Promise<{ placeGeojson: unknown | null; center: [number, number] | null; zoom: number | null }> {
  const [taskRows, centerRows] = await Promise.all([
    sql<{ place_geojson: unknown | null }[]>`
      SELECT place_geojson FROM jurisdiction_discovery_tasks WHERE id = ${taskId} LIMIT 1
    `,
    sql<{ lat: number | null; lng: number | null }[]>`
      SELECT ST_Y(ST_Centroid(geom)) AS lat, ST_X(ST_Centroid(geom)) AS lng
      FROM jurisdictions
      WHERE geoid = ${geoid}
      LIMIT 1
    `,
  ])
  const placeGeojson = taskRows[0]?.place_geojson ?? null
  const c = centerRows[0]
  const center: [number, number] | null =
    c && c.lat !== null && c.lng !== null ? [c.lat, c.lng] : null
  const zoom = center !== null ? 11 : null
  return { placeGeojson, center, zoom }
}

export async function upsertJurisdictionContacts(
  tx: Queryable,
  geoid: string,
  contacts: Partial<Record<ReportCategory, string | null>>,
  defaultEmails: string[],
  formUrl: string | null,
): Promise<void> {
  for (const [category, rawEmail] of Object.entries(contacts) as [
    ReportCategory,
    string | null,
  ][]) {
    const email = rawEmail && rawEmail.trim() !== "" ? rawEmail.trim() : null
    if (email === null) {
      await tx`
        DELETE FROM jurisdiction_contacts WHERE geoid = ${geoid} AND category = ${category}
      `
      continue
    }
    await tx`
      INSERT INTO jurisdiction_contacts (geoid, category, email, updated_at, bounced_at)
      VALUES (${geoid}, ${category}, ${email}, now(), NULL)
      ON CONFLICT (geoid, category) WHERE category IS NOT NULL
      DO UPDATE SET email = EXCLUDED.email, updated_at = now(), bounced_at = NULL
    `
  }

  const defaultEmail = defaultEmails.find((e) => e.trim() !== "")?.trim() ?? null
  const form = formUrl && formUrl.trim() !== "" ? formUrl.trim() : null
  if (defaultEmail !== null || form !== null) {
    await tx`
      INSERT INTO jurisdiction_contacts (geoid, category, email, form_url, updated_at, bounced_at)
      VALUES (${geoid}, NULL, ${defaultEmail}, ${form}, now(), NULL)
      ON CONFLICT (geoid) WHERE category IS NULL
      DO UPDATE SET email = EXCLUDED.email, form_url = EXCLUDED.form_url, updated_at = now(), bounced_at = NULL
    `
  }

  if (defaultEmails.length > 0 || form !== null) {
    const emails = defaultEmails.filter((e) => e.trim() !== "")
    await tx`
      UPDATE jurisdictions
      SET
        contact_emails = CASE WHEN ${emails.length} > 0 THEN ${emails} ELSE contact_emails END,
        report_form_url = COALESCE(${form}, report_form_url)
      WHERE geoid = ${geoid}
    `
  }
}
