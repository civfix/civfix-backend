import type { Queryable, Sql } from "../../db/client.js"
import type {
  EinSourceValue,
  EligibilitySourceValue,
  EligibilityVerdictValue,
  EligibilityVerdictContribution,
  OrgPaymentsStateValue,
} from "../../db/schema/types-payments.js"
import type { IrsAddress } from "./eligibility-sources.js"
import type { ScreeningTarget } from "./eligibility-scan.js"

export interface AppendCheckInput {
  organizationId: string
  source: EligibilitySourceValue
  ein: string | null
  irsLegalName: string | null
  foundationCode: string | null
  deductibilityCode: string | null
  sourceRevisionDate: string
  rawReportSha256: string | null
  rawReportKey: string | null
  matched: boolean
  verdictContribution: EligibilityVerdictContribution
  detail: string | null
  checkedAt: Date
  retentionUntil: Date
}

export interface EvidenceSnapshot {
  pub78Listed: boolean
  pub78Checked: boolean
  bmfListed: boolean
  bmfChecked: boolean
  deductibilityCode: string | null
  autoRevocationListed: boolean
  ftbRevoked: boolean
  mnosListed: boolean
  ofacMatch: boolean
  groupExemptionSubordinate: boolean
  centralOrgConfirmed: boolean
  mnosFirstSeenOn: string | null
  foundationCode: string | null
  irsLegalName: string | null
  sourceRevisions: Record<string, string>
  checkIds: string[]
}

export interface SourceRevisionRecord {
  source: EligibilitySourceValue
  sourceRevisionDate: string
  sha256: string
  r2Key: string
  rowCount: number
  matchedCount: number
  retentionUntil: Date
}

export interface LatestRevision {
  sourceRevisionDate: string
  sha256: string
  r2Key: string
  rowCount: number
}

export interface SetEinInput {
  organizationId: string
  ein: string
  source: EinSourceValue
  actorUserId: string | null
  now: Date
}

export interface CentralOrgConfirmationInput {
  organizationId: string
  confirmed: boolean
  actorUserId: string
  now: Date
}

export interface BmfListingInput {
  organizationId: string
  ein: string
  irsAddress: IrsAddress
  groupExemptionSubordinate: boolean
  now: Date
}

export interface EligibilityCheckSummary {
  source: EligibilitySourceValue
  sourceRevisionDate: string
  matched: boolean
  verdictContribution: EligibilityVerdictContribution
  detail: string | null
  checkedAt: Date
}

export interface EligibilityPageRow {
  organizationId: string
  orgName: string
  orgSlug: string
  paymentsState: OrgPaymentsStateValue
  donationsEnabled: boolean
  donationsDisabledReason: string | null
  donationsDisabledReasonText: string | null
  verdict: EligibilityVerdictValue
  reasons: string[]
  ein: string | null
  einSource: EinSourceValue | null
  irsLegalName: string | null
  deductibilityCode: string | null
  foundationCode: string | null
  groupExemptionSubordinate: boolean
  centralOrgConfirmedAt: Date | null
  graceExpiresAt: Date | null
  evaluatedAt: Date | null
  nextCheckAt: Date | null
  checks: EligibilityCheckSummary[]
}

export interface EligibilityPageQuery {
  verdict?: EligibilityVerdictValue
  state?: OrgPaymentsStateValue
  limit: number
  checksLimit: number
  afterOrganizationId: string | null
}

export interface EligibilityRepository {
  listScreeningTargets(limit: number, afterOrganizationId: string | null): Promise<ScreeningTarget[]>
  screeningTarget(organizationId: string): Promise<ScreeningTarget | null>
  appendChecks(
    rows: readonly AppendCheckInput[],
    bmfListings?: readonly BmfListingInput[],
  ): Promise<void>
  appendRevision(
    revision: SourceRevisionRecord,
    rows: readonly AppendCheckInput[],
    bmfListings?: readonly BmfListingInput[],
  ): Promise<void>
  evidenceFor(organizationId: string): Promise<EvidenceSnapshot>
  applyVerdict(input: {
    organizationId: string
    verdict: EligibilityVerdictValue
    reasons: readonly string[]
    contributionsDeductible: boolean
    graceExpiresAt: Date | null
    mnosFirstSeenOn: string | null
    irsLegalName: string | null
    foundationCode: string | null
    deductibilityCode: string | null
    evaluatedAt: Date
    nextCheckAt: Date
  }): Promise<EligibilityVerdictValue | null>
  setEin(input: SetEinInput): Promise<{ changed: boolean }>
  setCentralOrgConfirmation(input: CentralOrgConfirmationInput): Promise<Date | null>
  applyBmfListing(input: BmfListingInput): Promise<void>
  knownRevision(source: EligibilitySourceValue, revision: string): Promise<boolean>
  latestRevision(source: EligibilitySourceValue): Promise<LatestRevision | null>
  expiredRevisions(
    now: Date,
    limit: number,
  ): Promise<{ source: string; sourceRevisionDate: string; r2Key: string }[]>
  deleteRevision(source: string, sourceRevisionDate: string): Promise<void>
  deleteExpiredChecks(now: Date, limit: number): Promise<number>
  listEligibilityPage(query: EligibilityPageQuery): Promise<EligibilityPageRow[]>
  verdictCounts(): Promise<Record<EligibilityVerdictValue, number>>
}

interface TargetRow {
  organization_id: string
  ein: string
  irs_legal_name: string | null
  org_name: string
}

function toTarget(row: TargetRow): ScreeningTarget {
  return {
    organizationId: row.organization_id,
    ein: row.ein,
    irsLegalName: row.irs_legal_name,
    orgName: row.org_name,
  }
}

interface EvidenceRow {
  id: string
  source: EligibilitySourceValue
  source_revision_date: string
  matched: boolean
  verdict_contribution: EligibilityVerdictContribution
  irs_legal_name: string | null
  foundation_code: string | null
  deductibility_code: string | null
  checked_at: Date
}

interface PageRowSelect {
  organization_id: string
  org_name: string
  org_slug: string
  payments_state: OrgPaymentsStateValue
  donations_enabled: boolean
  disabled_reason: string | null
  disabled_reason_text: string | null
  verdict: EligibilityVerdictValue
  reasons: string[]
  ein: string | null
  ein_source: EinSourceValue | null
  irs_legal_name: string | null
  deductibility_code: string | null
  foundation_code: string | null
  group_exemption_subordinate: boolean | null
  central_org_confirmed_at: Date | null
  grace_expires_at: Date | null
  evaluated_at: Date | null
  next_check_at: Date | null
  checks: {
    source: EligibilitySourceValue
    sourceRevisionDate: string
    matched: boolean
    verdictContribution: EligibilityVerdictContribution
    detail: string | null
    checkedAt: string
  }[]
}

const POSITIVE_SOURCES: ReadonlySet<string> = new Set(["irs_pub78", "irs_eo_bmf"])

export function emptyVerdictCounts(): Record<EligibilityVerdictValue, number> {
  return { unknown: 0, eligible: 0, grace: 0, ineligible: 0, review_required: 0 }
}

async function insertCheck(sql: Queryable, row: AppendCheckInput): Promise<void> {
  await sql`
    INSERT INTO org_eligibility_checks (
      organization_id, source, ein, irs_legal_name, foundation_code, deductibility_code,
      source_revision_date, raw_report_sha256, raw_report_key, matched, verdict_contribution,
      detail, checked_at, retention_until
    ) VALUES (
      ${row.organizationId}, ${row.source}, ${row.ein}, ${row.irsLegalName},
      ${row.foundationCode}, ${row.deductibilityCode}, ${row.sourceRevisionDate},
      ${row.rawReportSha256}, ${row.rawReportKey}, ${row.matched}, ${row.verdictContribution},
      ${row.detail}, ${row.checkedAt}, ${row.retentionUntil}
    )`
}

async function insertRevision(sql: Queryable, input: SourceRevisionRecord): Promise<void> {
  await sql`
    INSERT INTO eligibility_source_revisions (
      source, source_revision_date, sha256, r2_key, row_count, matched_count, retention_until
    ) VALUES (
      ${input.source}, ${input.sourceRevisionDate}, ${input.sha256}, ${input.r2Key},
      ${input.rowCount}, ${input.matchedCount}, ${input.retentionUntil}
    )
    ON CONFLICT (source, source_revision_date) DO NOTHING`
}

async function applyBmfListingWith(sql: Queryable, input: BmfListingInput): Promise<void> {
  await sql`
    UPDATE org_eligibility SET
      irs_address                 = ${sql.json({ ...input.irsAddress })},
      group_exemption_subordinate = ${input.groupExemptionSubordinate},
      updated_at                  = ${input.now}
    WHERE organization_id = ${input.organizationId} AND ein = ${input.ein}`
}

export async function upsertOrgEligibilityEin(
  sql: Queryable,
  input: SetEinInput,
): Promise<{ changed: boolean }> {
  const rows = await sql<{ previous_ein: string | null }[]>`
    WITH prior AS (
      SELECT ein FROM org_eligibility WHERE organization_id = ${input.organizationId}
    )
    INSERT INTO org_eligibility (
      organization_id, ein, ein_source, ein_set_at, ein_set_by, updated_at
    ) VALUES (
      ${input.organizationId}, ${input.ein}, ${input.source}, ${input.now},
      ${input.actorUserId}, ${input.now}
    )
    ON CONFLICT (organization_id) DO UPDATE SET
      ein        = EXCLUDED.ein,
      ein_source = EXCLUDED.ein_source,
      ein_set_at = EXCLUDED.ein_set_at,
      ein_set_by = EXCLUDED.ein_set_by,
      updated_at = EXCLUDED.updated_at,
      verdict = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                     THEN 'unknown' ELSE org_eligibility.verdict END,
      reasons = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                     THEN '[]'::jsonb ELSE org_eligibility.reasons END,
      contributions_deductible = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                      THEN false ELSE org_eligibility.contributions_deductible END,
      irs_legal_name = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                            THEN NULL ELSE org_eligibility.irs_legal_name END,
      irs_address = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                         THEN NULL ELSE org_eligibility.irs_address END,
      deductibility_code = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                THEN NULL ELSE org_eligibility.deductibility_code END,
      foundation_code = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                             THEN NULL ELSE org_eligibility.foundation_code END,
      group_exemption_subordinate = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                         THEN false ELSE org_eligibility.group_exemption_subordinate END,
      central_org_confirmed_at = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                      THEN NULL ELSE org_eligibility.central_org_confirmed_at END,
      central_org_confirmed_by = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                      THEN NULL ELSE org_eligibility.central_org_confirmed_by END,
      mnos_first_seen_on = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                                THEN NULL ELSE org_eligibility.mnos_first_seen_on END,
      grace_expires_at = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                              THEN NULL ELSE org_eligibility.grace_expires_at END,
      evaluated_at = CASE WHEN org_eligibility.ein IS DISTINCT FROM EXCLUDED.ein
                          THEN NULL ELSE org_eligibility.evaluated_at END
    RETURNING (SELECT ein FROM prior) AS previous_ein`
  return { changed: (rows[0]?.previous_ein ?? null) !== input.ein }
}

export function makeDrizzleEligibilityRepository(sql: Sql): EligibilityRepository {
  return {
    async listScreeningTargets(limit, afterOrganizationId) {
      const rows = await sql<TargetRow[]>`
        SELECT e.organization_id, e.ein, e.irs_legal_name, o.name AS org_name
          FROM org_eligibility e
          JOIN organizations o ON o.id = e.organization_id
         WHERE e.ein IS NOT NULL
           AND o.deleted_at IS NULL
           AND o.verified_status = 'verified'
           AND o.verified_kind = 'nonprofit'
           AND (${afterOrganizationId}::uuid IS NULL OR e.organization_id > ${afterOrganizationId})
         ORDER BY e.organization_id ASC
         LIMIT ${limit}`
      return rows.map(toTarget)
    },

    async screeningTarget(organizationId) {
      const rows = await sql<TargetRow[]>`
        SELECT e.organization_id, e.ein, e.irs_legal_name, o.name AS org_name
          FROM org_eligibility e
          JOIN organizations o ON o.id = e.organization_id
         WHERE e.organization_id = ${organizationId}
           AND e.ein IS NOT NULL
           AND o.deleted_at IS NULL
           AND o.verified_status = 'verified'
           AND o.verified_kind = 'nonprofit'
         LIMIT 1`
      return rows[0] === undefined ? null : toTarget(rows[0])
    },

    async appendChecks(rows, bmfListings = []) {
      if (rows.length === 0 && bmfListings.length === 0) return
      await sql.begin(async (tx) => {
        for (const row of rows) await insertCheck(tx, row)
        for (const listing of bmfListings) await applyBmfListingWith(tx, listing)
      })
    },

    async appendRevision(revision, rows, bmfListings = []) {
      await sql.begin(async (tx) => {
        for (const row of rows) await insertCheck(tx, row)
        for (const listing of bmfListings) await applyBmfListingWith(tx, listing)
        await insertRevision(tx, revision)
      })
    },

    async evidenceFor(organizationId) {
      const rows = await sql<EvidenceRow[]>`
        SELECT DISTINCT ON (c.source)
               c.id, c.source, c.source_revision_date::text AS source_revision_date, c.matched,
               c.verdict_contribution, c.irs_legal_name, c.foundation_code, c.deductibility_code,
               c.checked_at
          FROM org_eligibility_checks c
          JOIN org_eligibility e ON e.organization_id = c.organization_id
         WHERE c.organization_id = ${organizationId}
           AND (c.ein IS NULL OR c.ein = e.ein)
         ORDER BY c.source, c.checked_at DESC, c.id DESC`

      const current = await sql<
        {
          group_exemption_subordinate: boolean
          central_org_confirmed_at: Date | null
          mnos_first_seen_on: string | null
        }[]
      >`
        SELECT group_exemption_subordinate, central_org_confirmed_at,
               mnos_first_seen_on::text AS mnos_first_seen_on
          FROM org_eligibility WHERE organization_id = ${organizationId} LIMIT 1`

      return evidenceFromRows(rows, current[0])
    },

    async applyVerdict(input) {
      const rows = await sql<{ previous: EligibilityVerdictValue | null }[]>`
        WITH prior AS (
          SELECT verdict FROM org_eligibility WHERE organization_id = ${input.organizationId}
        )
        INSERT INTO org_eligibility (
          organization_id, verdict, reasons, contributions_deductible, irs_legal_name,
          foundation_code, deductibility_code, mnos_first_seen_on, grace_expires_at, evaluated_at,
          next_check_at, updated_at
        ) VALUES (
          ${input.organizationId}, ${input.verdict}, ${sql.json([...input.reasons])},
          ${input.contributionsDeductible}, ${input.irsLegalName}, ${input.foundationCode},
          ${input.deductibilityCode}, ${input.mnosFirstSeenOn}, ${input.graceExpiresAt},
          ${input.evaluatedAt}, ${input.nextCheckAt}, ${input.evaluatedAt}
        )
        ON CONFLICT (organization_id) DO UPDATE SET
          verdict            = EXCLUDED.verdict,
          reasons            = EXCLUDED.reasons,
          contributions_deductible = EXCLUDED.contributions_deductible,
          irs_legal_name     = COALESCE(EXCLUDED.irs_legal_name, org_eligibility.irs_legal_name),
          foundation_code    = COALESCE(EXCLUDED.foundation_code, org_eligibility.foundation_code),
          deductibility_code = COALESCE(EXCLUDED.deductibility_code, org_eligibility.deductibility_code),
          mnos_first_seen_on = EXCLUDED.mnos_first_seen_on,
          grace_expires_at   = EXCLUDED.grace_expires_at,
          evaluated_at       = EXCLUDED.evaluated_at,
          next_check_at      = EXCLUDED.next_check_at,
          updated_at         = EXCLUDED.updated_at
        RETURNING (SELECT verdict FROM prior) AS previous`
      return rows[0]?.previous ?? null
    },

    setEin(input) {
      return upsertOrgEligibilityEin(sql, input)
    },

    async setCentralOrgConfirmation(input) {
      const confirmedAt = input.confirmed ? input.now : null
      const confirmedBy = input.confirmed ? input.actorUserId : null
      const rows = await sql<{ central_org_confirmed_at: Date | null }[]>`
        INSERT INTO org_eligibility (
          organization_id, central_org_confirmed_at, central_org_confirmed_by, updated_at
        ) VALUES (${input.organizationId}, ${confirmedAt}, ${confirmedBy}, ${input.now})
        ON CONFLICT (organization_id) DO UPDATE SET
          central_org_confirmed_at = EXCLUDED.central_org_confirmed_at,
          central_org_confirmed_by = EXCLUDED.central_org_confirmed_by,
          updated_at               = EXCLUDED.updated_at
        RETURNING central_org_confirmed_at`
      return rows[0]?.central_org_confirmed_at ?? null
    },

    applyBmfListing(input) {
      return applyBmfListingWith(sql, input)
    },

    async knownRevision(source, revision) {
      const rows = await sql<{ source: string }[]>`
        SELECT source FROM eligibility_source_revisions
         WHERE source = ${source} AND source_revision_date = ${revision} LIMIT 1`
      return rows.length > 0
    },

    async latestRevision(source) {
      const rows = await sql<
        { source_revision_date: string; sha256: string; r2_key: string; row_count: string | number }[]
      >`
        SELECT source_revision_date::text AS source_revision_date, sha256, r2_key, row_count
          FROM eligibility_source_revisions
         WHERE source = ${source}
         ORDER BY source_revision_date DESC
         LIMIT 1`
      const row = rows[0]
      return row === undefined
        ? null
        : {
            sourceRevisionDate: row.source_revision_date,
            sha256: row.sha256,
            r2Key: row.r2_key,
            rowCount: Number(row.row_count),
          }
    },

    async expiredRevisions(now, limit) {
      const rows = await sql<{ source: string; source_revision_date: string; r2_key: string }[]>`
        SELECT source, source_revision_date::text AS source_revision_date, r2_key
          FROM eligibility_source_revisions
         WHERE retention_until <= ${now}
         ORDER BY retention_until ASC
         LIMIT ${limit}`
      return rows.map((row) => ({
        source: row.source,
        sourceRevisionDate: row.source_revision_date,
        r2Key: row.r2_key,
      }))
    },

    async deleteRevision(source, sourceRevisionDate) {
      await sql`
        DELETE FROM eligibility_source_revisions
         WHERE source = ${source} AND source_revision_date = ${sourceRevisionDate}`
    },

    async deleteExpiredChecks(now, limit) {
      const rows = await sql<{ id: string }[]>`
        WITH due AS (
          SELECT id FROM org_eligibility_checks WHERE retention_until <= ${now}
           ORDER BY retention_until ASC LIMIT ${limit}
        )
        DELETE FROM org_eligibility_checks c USING due WHERE c.id = due.id RETURNING c.id`
      return rows.length
    },

    async listEligibilityPage(query) {
      const rows = await sql<PageRowSelect[]>`
        SELECT o.id AS organization_id, o.name AS org_name, o.slug AS org_slug,
               COALESCE(a.onboarding_state, 'not_started') AS payments_state,
               COALESCE(s.enabled, false) AS donations_enabled,
               s.disabled_reason, s.disabled_reason_text,
               COALESCE(e.verdict, 'unknown') AS verdict,
               COALESCE(e.reasons, '[]'::jsonb) AS reasons,
               e.ein, e.ein_source, e.irs_legal_name, e.deductibility_code, e.foundation_code,
               e.group_exemption_subordinate, e.central_org_confirmed_at,
               e.grace_expires_at, e.evaluated_at, e.next_check_at,
               COALESCE(c.checks, '[]'::jsonb) AS checks
          FROM organizations o
          LEFT JOIN org_eligibility e ON e.organization_id = o.id
          LEFT JOIN org_stripe_accounts a ON a.organization_id = o.id
          LEFT JOIN org_donation_settings s ON s.organization_id = o.id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'source', k.source,
                       'sourceRevisionDate', k.source_revision_date::text,
                       'matched', k.matched,
                       'verdictContribution', k.verdict_contribution,
                       'detail', k.detail,
                       'checkedAt', to_char(k.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                     ) ORDER BY k.checked_at DESC, k.id DESC
                   ) AS checks
              FROM (
                SELECT source, source_revision_date, matched, verdict_contribution, detail,
                       checked_at, id
                  FROM org_eligibility_checks
                 WHERE organization_id = o.id
                 ORDER BY checked_at DESC, id DESC
                 LIMIT ${query.checksLimit}
              ) k
          ) c ON TRUE
         WHERE o.deleted_at IS NULL
           AND o.verified_status = 'verified'
           AND o.verified_kind = 'nonprofit'
           AND (${query.verdict ?? null}::text IS NULL OR COALESCE(e.verdict, 'unknown') = ${query.verdict ?? null})
           AND (${query.state ?? null}::text IS NULL OR COALESCE(a.onboarding_state, 'not_started') = ${query.state ?? null})
           AND (${query.afterOrganizationId}::uuid IS NULL OR o.id > ${query.afterOrganizationId})
         ORDER BY o.id ASC
         LIMIT ${query.limit}`
      return rows.map((row) => ({
        organizationId: row.organization_id,
        orgName: row.org_name,
        orgSlug: row.org_slug,
        paymentsState: row.payments_state,
        donationsEnabled: row.donations_enabled,
        donationsDisabledReason: row.disabled_reason,
        donationsDisabledReasonText: row.disabled_reason_text,
        verdict: row.verdict,
        reasons: row.reasons,
        ein: row.ein,
        einSource: row.ein_source,
        irsLegalName: row.irs_legal_name,
        deductibilityCode: row.deductibility_code,
        foundationCode: row.foundation_code,
        groupExemptionSubordinate: row.group_exemption_subordinate === true,
        centralOrgConfirmedAt: row.central_org_confirmed_at,
        graceExpiresAt: row.grace_expires_at,
        evaluatedAt: row.evaluated_at,
        nextCheckAt: row.next_check_at,
        checks: row.checks.map((check) => ({
          source: check.source,
          sourceRevisionDate: check.sourceRevisionDate,
          matched: check.matched,
          verdictContribution: check.verdictContribution,
          detail: check.detail,
          checkedAt: new Date(check.checkedAt),
        })),
      }))
    },

    async verdictCounts() {
      const rows = await sql<{ verdict: EligibilityVerdictValue; count: string | number }[]>`
        SELECT COALESCE(e.verdict, 'unknown') AS verdict, COUNT(*) AS count
          FROM organizations o
          LEFT JOIN org_eligibility e ON e.organization_id = o.id
         WHERE o.deleted_at IS NULL
           AND o.verified_status = 'verified'
           AND o.verified_kind = 'nonprofit'
         GROUP BY 1`
      const counts = emptyVerdictCounts()
      for (const row of rows) {
        counts[row.verdict] = typeof row.count === "number" ? row.count : Number(row.count)
      }
      return counts
    },
  }
}

export function evidenceFromRows(
  rows: readonly EvidenceRow[],
  current:
    | {
        group_exemption_subordinate: boolean
        central_org_confirmed_at: Date | null
        mnos_first_seen_on: string | null
      }
    | undefined,
): EvidenceSnapshot {
  const bySource = new Map(rows.map((row) => [row.source, row]))
  const sourceRevisions: Record<string, string> = {}
  for (const row of rows) sourceRevisions[row.source] = row.source_revision_date

  const pub78 = bySource.get("irs_pub78")
  const bmf = bySource.get("irs_eo_bmf")
  const revocation = bySource.get("irs_auto_revocation")
  const positive = rows.find((row) => POSITIVE_SOURCES.has(row.source) && row.matched)

  return {
    pub78Listed: pub78?.matched === true,
    pub78Checked: pub78 !== undefined,
    bmfListed: bmf?.matched === true,
    bmfChecked: bmf !== undefined,
    deductibilityCode: bmf?.deductibility_code ?? pub78?.deductibility_code ?? null,
    autoRevocationListed:
      revocation?.matched === true && revocation.verdict_contribution === "disqualifies",
    ftbRevoked: bySource.get("ftb_revoked")?.matched === true,
    mnosListed: bySource.get("ca_ag_mnos")?.matched === true,
    ofacMatch: bySource.get("ofac_sdn")?.matched === true,
    groupExemptionSubordinate: current?.group_exemption_subordinate === true,
    centralOrgConfirmed: current !== undefined && current.central_org_confirmed_at !== null,
    mnosFirstSeenOn: current?.mnos_first_seen_on ?? null,
    foundationCode: positive?.foundation_code ?? null,
    irsLegalName: positive?.irs_legal_name ?? null,
    sourceRevisions,
    checkIds: rows.map((row) => row.id),
  }
}

export type { EvidenceRow }
