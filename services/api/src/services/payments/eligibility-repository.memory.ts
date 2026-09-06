import type {
  EinSourceValue,
  EligibilitySourceValue,
  EligibilityVerdictValue,
  OrgPaymentsStateValue,
} from "../../db/schema/types-payments.js"
import {
  emptyVerdictCounts,
  evidenceFromRows,
  type AppendCheckInput,
  type EligibilityPageRow,
  type EligibilityRepository,
  type EvidenceRow,
  type LatestRevision,
  type SourceRevisionRecord,
} from "./eligibility-repository.drizzle.js"
import type { BmfListingInput } from "./eligibility-repository.drizzle.js"
import type { IrsAddress } from "./eligibility-sources.js"
import type { ScreeningTarget } from "./eligibility-scan.js"

export interface MemoryEligibilityOrg {
  organizationId: string
  name: string
  slug: string
  verifiedNonprofit: boolean
  paymentsState: OrgPaymentsStateValue
  donationsEnabled: boolean
  disabledReason: string | null
  disabledReasonText: string | null
}

export interface MemoryEligibilityState {
  organizationId: string
  verdict: EligibilityVerdictValue
  reasons: string[]
  contributionsDeductible: boolean
  ein: string | null
  einSource: EinSourceValue | null
  einSetBy: string | null
  irsLegalName: string | null
  irsAddress: IrsAddress | null
  deductibilityCode: string | null
  foundationCode: string | null
  groupExemptionSubordinate: boolean
  centralOrgConfirmedAt: Date | null
  mnosFirstSeenOn: string | null
  graceExpiresAt: Date | null
  evaluatedAt: Date | null
  nextCheckAt: Date | null
}

export interface MemoryEligibilitySeed {
  orgs?: MemoryEligibilityOrg[]
  eligibility?: Partial<MemoryEligibilityState>[]
  checks?: AppendCheckInput[]
  revisions?: SourceRevisionRecord[]
}

export interface MemoryEligibilityRepository extends EligibilityRepository {
  readonly orgs: MemoryEligibilityOrg[]
  readonly eligibility: Map<string, MemoryEligibilityState>
  readonly checks: (AppendCheckInput & { id: string })[]
  readonly revisions: SourceRevisionRecord[]
}

export function memoryEligibilityOrg(patch: Partial<MemoryEligibilityOrg> & { organizationId: string }): MemoryEligibilityOrg {
  return {
    name: "Reach Out LA",
    slug: "reach-out-la",
    verifiedNonprofit: true,
    paymentsState: "ready",
    donationsEnabled: true,
    disabledReason: null,
    disabledReasonText: null,
    ...patch,
  }
}

function blankState(organizationId: string): MemoryEligibilityState {
  return {
    organizationId,
    verdict: "unknown",
    reasons: [],
    contributionsDeductible: false,
    ein: null,
    einSource: null,
    einSetBy: null,
    irsLegalName: null,
    irsAddress: null,
    deductibilityCode: null,
    foundationCode: null,
    groupExemptionSubordinate: false,
    centralOrgConfirmedAt: null,
    mnosFirstSeenOn: null,
    graceExpiresAt: null,
    evaluatedAt: null,
    nextCheckAt: null,
  }
}

export function makeMemoryEligibilityRepository(
  seed: MemoryEligibilitySeed = {},
): MemoryEligibilityRepository {
  const orgs = seed.orgs ?? []
  const eligibility = new Map<string, MemoryEligibilityState>()
  for (const entry of seed.eligibility ?? []) {
    if (entry.organizationId === undefined) continue
    eligibility.set(entry.organizationId, { ...blankState(entry.organizationId), ...entry })
  }
  let sequence = 0
  const checks: (AppendCheckInput & { id: string })[] = (seed.checks ?? []).map((check) => ({
    ...check,
    id: `check-${++sequence}`,
  }))
  const revisions: SourceRevisionRecord[] = [...(seed.revisions ?? [])]

  function stateOf(organizationId: string): MemoryEligibilityState {
    const existing = eligibility.get(organizationId)
    if (existing !== undefined) return existing
    const fresh = blankState(organizationId)
    eligibility.set(organizationId, fresh)
    return fresh
  }

  function targetOf(state: MemoryEligibilityState): ScreeningTarget | null {
    const org = orgs.find((entry) => entry.organizationId === state.organizationId)
    if (org === undefined || !org.verifiedNonprofit || state.ein === null) return null
    return {
      organizationId: state.organizationId,
      ein: state.ein,
      irsLegalName: state.irsLegalName,
      orgName: org.name,
    }
  }

  function sortedChecks(organizationId: string): (AppendCheckInput & { id: string })[] {
    return checks
      .filter((check) => check.organizationId === organizationId)
      .sort((a, b) => {
        const byTime = b.checkedAt.getTime() - a.checkedAt.getTime()
        return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
      })
  }

  function applyListing(input: BmfListingInput): void {
    const state = eligibility.get(input.organizationId)
    if (state !== undefined && state.ein === input.ein) {
      state.irsAddress = { ...input.irsAddress }
      state.groupExemptionSubordinate = input.groupExemptionSubordinate
    }
  }

  function verdictOf(organizationId: string): EligibilityVerdictValue {
    return eligibility.get(organizationId)?.verdict ?? "unknown"
  }

  function verifiedOrgs(): MemoryEligibilityOrg[] {
    return orgs
      .filter((org) => org.verifiedNonprofit)
      .sort((a, b) => a.organizationId.localeCompare(b.organizationId))
  }

  return {
    orgs,
    eligibility,
    checks,
    revisions,

    listScreeningTargets(limit, afterOrganizationId) {
      const targets = [...eligibility.values()]
        .sort((a, b) => a.organizationId.localeCompare(b.organizationId))
        .filter((state) => afterOrganizationId === null || state.organizationId > afterOrganizationId)
        .map(targetOf)
        .filter((target): target is ScreeningTarget => target !== null)
      return Promise.resolve(targets.slice(0, limit))
    },

    screeningTarget(organizationId) {
      const state = eligibility.get(organizationId)
      return Promise.resolve(state === undefined ? null : targetOf(state))
    },

    appendChecks(rows, bmfListings = []) {
      for (const row of rows) checks.push({ ...row, id: `check-${++sequence}` })
      for (const listing of bmfListings) applyListing(listing)
      return Promise.resolve()
    },

    appendRevision(revision, rows, bmfListings = []) {
      for (const row of rows) checks.push({ ...row, id: `check-${++sequence}` })
      for (const listing of bmfListings) applyListing(listing)
      if (
        !revisions.some(
          (entry) =>
            entry.source === revision.source &&
            entry.sourceRevisionDate === revision.sourceRevisionDate,
        )
      ) {
        revisions.push(revision)
      }
      return Promise.resolve()
    },

    evidenceFor(organizationId) {
      const state = eligibility.get(organizationId)
      const rows: EvidenceRow[] = []
      const seen = new Set<EligibilitySourceValue>()
      if (state !== undefined) {
        for (const check of sortedChecks(organizationId)) {
          if (check.ein !== null && check.ein !== state.ein) continue
          if (seen.has(check.source)) continue
          seen.add(check.source)
          rows.push({
            id: check.id,
            source: check.source,
            source_revision_date: check.sourceRevisionDate,
            matched: check.matched,
            verdict_contribution: check.verdictContribution,
            irs_legal_name: check.irsLegalName,
            foundation_code: check.foundationCode,
            deductibility_code: check.deductibilityCode,
            checked_at: check.checkedAt,
          })
        }
      }
      return Promise.resolve(
        evidenceFromRows(
          rows,
          state === undefined
            ? undefined
            : {
                group_exemption_subordinate: state.groupExemptionSubordinate,
                central_org_confirmed_at: state.centralOrgConfirmedAt,
                mnos_first_seen_on: state.mnosFirstSeenOn,
              },
        ),
      )
    },

    applyVerdict(input) {
      const existed = eligibility.has(input.organizationId)
      const state = stateOf(input.organizationId)
      const previous = existed ? state.verdict : null
      state.verdict = input.verdict
      state.reasons = [...input.reasons]
      state.contributionsDeductible = input.contributionsDeductible
      state.irsLegalName = input.irsLegalName ?? state.irsLegalName
      state.foundationCode = input.foundationCode ?? state.foundationCode
      state.deductibilityCode = input.deductibilityCode ?? state.deductibilityCode
      state.mnosFirstSeenOn = input.mnosFirstSeenOn
      state.graceExpiresAt = input.graceExpiresAt
      state.evaluatedAt = input.evaluatedAt
      state.nextCheckAt = input.nextCheckAt
      return Promise.resolve(previous)
    },

    setEin(input) {
      const state = stateOf(input.organizationId)
      const changed = state.ein !== input.ein
      if (changed) {
        Object.assign(state, blankState(input.organizationId))
      }
      state.ein = input.ein
      state.einSource = input.source
      state.einSetBy = input.actorUserId
      return Promise.resolve({ changed })
    },

    setCentralOrgConfirmation(input) {
      const state = stateOf(input.organizationId)
      state.centralOrgConfirmedAt = input.confirmed ? input.now : null
      return Promise.resolve(state.centralOrgConfirmedAt)
    },

    applyBmfListing(input) {
      applyListing(input)
      return Promise.resolve()
    },

    knownRevision(source, revision) {
      return Promise.resolve(
        revisions.some(
          (entry) => entry.source === source && entry.sourceRevisionDate === revision,
        ),
      )
    },

    latestRevision(source) {
      const latest = revisions
        .filter((entry) => entry.source === source)
        .sort((a, b) => b.sourceRevisionDate.localeCompare(a.sourceRevisionDate))[0]
      const result: LatestRevision | null =
        latest === undefined
          ? null
          : {
              sourceRevisionDate: latest.sourceRevisionDate,
              sha256: latest.sha256,
              r2Key: latest.r2Key,
              rowCount: latest.rowCount,
            }
      return Promise.resolve(result)
    },

    expiredRevisions(now, limit) {
      return Promise.resolve(
        revisions
          .filter((entry) => entry.retentionUntil.getTime() <= now.getTime())
          .slice(0, limit)
          .map((entry) => ({
            source: entry.source,
            sourceRevisionDate: entry.sourceRevisionDate,
            r2Key: entry.r2Key,
          })),
      )
    },

    deleteRevision(source, sourceRevisionDate) {
      const position = revisions.findIndex(
        (entry) => entry.source === source && entry.sourceRevisionDate === sourceRevisionDate,
      )
      if (position >= 0) revisions.splice(position, 1)
      return Promise.resolve()
    },

    deleteExpiredChecks(now, limit) {
      let removed = 0
      for (let i = checks.length - 1; i >= 0 && removed < limit; i--) {
        if ((checks[i] as AppendCheckInput).retentionUntil.getTime() <= now.getTime()) {
          checks.splice(i, 1)
          removed++
        }
      }
      return Promise.resolve(removed)
    },

    listEligibilityPage(query) {
      const rows: EligibilityPageRow[] = verifiedOrgs()
        .filter(
          (org) =>
            query.afterOrganizationId === null || org.organizationId > query.afterOrganizationId,
        )
        .filter((org) => query.verdict === undefined || verdictOf(org.organizationId) === query.verdict)
        .filter((org) => query.state === undefined || org.paymentsState === query.state)
        .slice(0, query.limit)
        .map((org) => {
          const state = eligibility.get(org.organizationId) ?? blankState(org.organizationId)
          return {
            organizationId: org.organizationId,
            orgName: org.name,
            orgSlug: org.slug,
            paymentsState: org.paymentsState,
            donationsEnabled: org.donationsEnabled,
            donationsDisabledReason: org.disabledReason,
            donationsDisabledReasonText: org.disabledReasonText,
            verdict: state.verdict,
            reasons: [...state.reasons],
            ein: state.ein,
            einSource: state.einSource,
            irsLegalName: state.irsLegalName,
            deductibilityCode: state.deductibilityCode,
            foundationCode: state.foundationCode,
            groupExemptionSubordinate: state.groupExemptionSubordinate,
            centralOrgConfirmedAt: state.centralOrgConfirmedAt,
            graceExpiresAt: state.graceExpiresAt,
            evaluatedAt: state.evaluatedAt,
            nextCheckAt: state.nextCheckAt,
            checks: sortedChecks(org.organizationId)
              .slice(0, query.checksLimit)
              .map((check) => ({
                source: check.source,
                sourceRevisionDate: check.sourceRevisionDate,
                matched: check.matched,
                verdictContribution: check.verdictContribution,
                detail: check.detail,
                checkedAt: check.checkedAt,
              })),
          }
        })
      return Promise.resolve(rows)
    },

    verdictCounts() {
      const counts = emptyVerdictCounts()
      for (const org of verifiedOrgs()) counts[verdictOf(org.organizationId)] += 1
      return Promise.resolve(counts)
    },
  }
}
