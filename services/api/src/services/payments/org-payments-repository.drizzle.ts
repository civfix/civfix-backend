import type { OrganizationMemberRole } from "@civfix/shared"
import type { ConnectedAccountStatus } from "@civfix/shared/interfaces"
import type { Queryable, Sql } from "../../db/client.js"
import type {
  DonationsDisabledReason,
  EligibilityVerdictValue,
  OrgPaymentsStateValue,
} from "../../db/schema/types-payments.js"

export interface OrgIdentityRow {
  id: string
  slug: string
  name: string
  logoUrl: string | null
  verifiedStatus: string
  verifiedKind: string | null
  /** Operator suspension flag (0162): a suspended org's donate page and checkout are refused. */
  suspended: boolean
}

export interface StripeAccountRecord {
  organizationId: string
  stripeAccountId: string
  livemode: boolean
  detailsSubmitted: boolean
  chargesEnabled: boolean
  payoutsEnabled: boolean
  disabledReason: string | null
  currentlyDue: string[]
  pastDue: string[]
  pendingVerification: string[]
  futureCurrentlyDue: string[]
  capabilities: Record<string, string>
  currentDeadline: Date | null
  onboardingState: OrgPaymentsStateValue
  paymentMethodDomains: PaymentMethodDomainRecord[]
  deauthorizedAt: Date | null
  reconnectAttempts: number
  previousStripeAccountIds: string[]
  reconciledThrough: Date | null
  lastSyncedAt: Date | null
}

export interface PaymentMethodDomainRecord {
  domain: string
  id: string
  enabled: boolean
  registeredAt: string | null
}

export interface DonationActorRecord {
  id: string
  name: string
  handle: string
  joined: string
}

export interface DonationSettingsRecord {
  organizationId: string
  enabled: boolean
  disabledReason: DonationsDisabledReason | null
  disabledReasonText: string | null
  disabledBy: DonationActorRecord | null
  donorSharingDefault: boolean
  missionBlurb: string | null
  designationNote: string | null
  refundPolicyText: string | null
  agreedFeeBps: number
  consentAgreementVersion: string | null
  consentAcceptedAt: Date | null
  consentAcceptedByName: string | null
  minAmountMinor: number
  maxAmountMinor: number
  suggestedAmountsMinor: number[]
}

export interface EligibilityRecord {
  organizationId: string
  verdict: EligibilityVerdictValue
  reasons: string[]
  ein: string | null
  irsLegalName: string | null
  irsAddress: Record<string, string | null> | null
  deductibilityCode: string | null
  foundationCode: string | null
  contributionsDeductible: boolean
  groupExemptionSubordinate: boolean
  centralOrgConfirmedAt: Date | null
  mnosFirstSeenOn: string | null
  graceExpiresAt: Date | null
  evaluatedAt: Date | null
  nextCheckAt: Date | null
}

export interface EligibilityCheckRecord {
  source: string
  sourceRevisionDate: string
  matched: boolean
  verdictContribution: "supports" | "disqualifies" | "neutral"
  detail: string | null
  checkedAt: Date
}

export interface OrgPaymentsView {
  org: OrgIdentityRow
  account: StripeAccountRecord | null
  settings: DonationSettingsRecord | null
  eligibility: EligibilityRecord | null
}

export interface AgreementChangeRecord {
  version: string
  acceptedAt: Date
  acceptedByName: string | null
  surface: string | null
}

export interface AcceptAgreementInput {
  organizationId: string
  userId: string
  version: string
  documentSha256: string
  surface: string
  screenRoute: string | null
  uiTemplateVersion: string | null
  feeBps: number
  now: Date
}

export interface SetDonationsEnabledInput {
  organizationId: string
  enabled: boolean
  reason: DonationsDisabledReason | null
  reasonText: string | null
  actorUserId: string | null
  now: Date
}

export interface UpdateDonationSettingsInput {
  organizationId: string
  donorSharingDefault?: boolean
  missionBlurb?: string | null
  designationNote?: string | null
  refundPolicyText?: string | null
  minAmountMinor?: number
  maxAmountMinor?: number
  suggestedAmountsMinor?: number[]
}

export interface OrgPaymentsRepository {
  findOrgById(organizationId: string): Promise<OrgIdentityRow | null>
  findOrgBySlug(slug: string): Promise<OrgIdentityRow | null>
  paymentsView(organizationId: string): Promise<OrgPaymentsView | null>
  insertStripeAccount(input: {
    organizationId: string
    status: ConnectedAccountStatus
    state: OrgPaymentsStateValue
  }): Promise<StripeAccountRecord>
  upsertStripeAccount(input: {
    organizationId: string
    status: ConnectedAccountStatus
    state: OrgPaymentsStateValue
    eventId?: string | null
    now: Date
  }): Promise<StripeAccountRecord>
  setPaymentMethodDomains(
    organizationId: string,
    domains: readonly PaymentMethodDomainRecord[],
  ): Promise<void>
  markDeauthorized(stripeAccountId: string, now: Date): Promise<string | null>
  relinkStripeAccount(input: {
    organizationId: string
    status: ConnectedAccountStatus
    state: OrgPaymentsStateValue
    now: Date
  }): Promise<StripeAccountRecord>
  clearDeauthorization(organizationId: string, now: Date): Promise<boolean>
  findOrgIdByStripeAccount(stripeAccountId: string): Promise<string | null>
  ensureSettings(organizationId: string, defaultFeeBps: number): Promise<DonationSettingsRecord>
  updateSettings(input: UpdateDonationSettingsInput): Promise<void>
  setDonationsEnabled(input: SetDonationsEnabledInput): Promise<boolean>
  acceptAgreement(input: AcceptAgreementInput): Promise<void>
  agreementHistory(organizationId: string, limit: number): Promise<AgreementChangeRecord[]>
  recentChecks(organizationId: string, limit: number): Promise<EligibilityCheckRecord[]>
  listAccountsForSync(limit: number): Promise<{ organizationId: string; stripeAccountId: string }[]>
  listOnboardedAccounts(
    limit: number,
    afterOrganizationId: string | null,
  ): Promise<{ organizationId: string; stripeAccountId: string; reconciledThrough: Date | null }[]>
  orgRoleOf(organizationId: string, userId: string): Promise<OrganizationMemberRole | null>
  findVerifiedUserEmail(userId: string): Promise<string | null>
  findEventRef(
    eventId: string,
    organizationId: string,
  ): Promise<{ id: string; title: string; startsAt: string } | null>
}

interface AccountRowSelect {
  organization_id: string
  stripe_account_id: string
  livemode: boolean
  details_submitted: boolean
  charges_enabled: boolean
  payouts_enabled: boolean
  disabled_reason: string | null
  currently_due: string[]
  past_due: string[]
  pending_verification: string[]
  future_currently_due: string[]
  capabilities: Record<string, string>
  current_deadline: Date | null
  onboarding_state: OrgPaymentsStateValue
  payment_method_domains: PaymentMethodDomainRecord[]
  deauthorized_at: Date | null
  reconnect_attempts: number
  previous_stripe_account_ids: string[]
  reconciled_through: Date | null
  last_synced_at: Date | null
}

interface SettingsRowSelect {
  organization_id: string
  enabled: boolean
  disabled_reason: DonationsDisabledReason | null
  disabled_reason_text: string | null
  disabled_by: string | null
  disabled_by_name: string | null
  disabled_by_handle: string | null
  disabled_by_joined: Date | null
  donor_sharing_default: boolean
  mission_blurb: string | null
  designation_note: string | null
  refund_policy_text: string | null
  agreed_fee_bps: number
  consent_agreement_version: string | null
  consent_accepted_at: Date | null
  consent_accepted_by_name: string | null
  min_amount_minor: string | number
  max_amount_minor: string | number
  suggested_amounts_minor: (string | number)[] | null
}

interface EligibilityRowSelect {
  organization_id: string
  verdict: EligibilityVerdictValue
  reasons: string[]
  ein: string | null
  irs_legal_name: string | null
  irs_address: Record<string, string | null> | null
  deductibility_code: string | null
  foundation_code: string | null
  contributions_deductible: boolean
  group_exemption_subordinate: boolean
  central_org_confirmed_at: Date | null
  mnos_first_seen_on: string | null
  grace_expires_at: Date | null
  evaluated_at: Date | null
  next_check_at: Date | null
}

interface OrgRowSelect {
  id: string
  slug: string
  name: string
  logo_url: string | null
  verified_status: string
  verified_kind: string | null
  suspended: boolean
}

export function toMinor(value: string | number): number {
  return typeof value === "number" ? value : Number(value)
}

function toAccount(row: AccountRowSelect): StripeAccountRecord {
  return {
    organizationId: row.organization_id,
    stripeAccountId: row.stripe_account_id,
    livemode: row.livemode,
    detailsSubmitted: row.details_submitted,
    chargesEnabled: row.charges_enabled,
    payoutsEnabled: row.payouts_enabled,
    disabledReason: row.disabled_reason,
    currentlyDue: row.currently_due ?? [],
    pastDue: row.past_due ?? [],
    pendingVerification: row.pending_verification ?? [],
    futureCurrentlyDue: row.future_currently_due ?? [],
    capabilities: row.capabilities ?? {},
    currentDeadline: row.current_deadline,
    onboardingState: row.onboarding_state,
    paymentMethodDomains: row.payment_method_domains ?? [],
    deauthorizedAt: row.deauthorized_at,
    reconnectAttempts: row.reconnect_attempts ?? 0,
    previousStripeAccountIds: row.previous_stripe_account_ids ?? [],
    reconciledThrough: row.reconciled_through,
    lastSyncedAt: row.last_synced_at,
  }
}

function toSettings(row: SettingsRowSelect): DonationSettingsRecord {
  return {
    organizationId: row.organization_id,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    disabledReasonText: row.disabled_reason_text,
    disabledBy:
      row.disabled_by === null
        ? null
        : {
            id: row.disabled_by,
            name: row.disabled_by_name ?? "civfix",
            handle: row.disabled_by_handle ?? "",
            joined: row.disabled_by_joined?.toISOString() ?? "",
          },
    donorSharingDefault: row.donor_sharing_default,
    missionBlurb: row.mission_blurb,
    designationNote: row.designation_note,
    refundPolicyText: row.refund_policy_text,
    agreedFeeBps: row.agreed_fee_bps,
    consentAgreementVersion: row.consent_agreement_version,
    consentAcceptedAt: row.consent_accepted_at,
    consentAcceptedByName: row.consent_accepted_by_name,
    minAmountMinor: toMinor(row.min_amount_minor),
    maxAmountMinor: toMinor(row.max_amount_minor),
    suggestedAmountsMinor: (row.suggested_amounts_minor ?? []).map(toMinor),
  }
}

function toEligibility(row: EligibilityRowSelect): EligibilityRecord {
  return {
    organizationId: row.organization_id,
    verdict: row.verdict,
    reasons: row.reasons ?? [],
    ein: row.ein,
    irsLegalName: row.irs_legal_name,
    irsAddress: row.irs_address,
    deductibilityCode: row.deductibility_code,
    foundationCode: row.foundation_code,
    contributionsDeductible: row.contributions_deductible === true,
    groupExemptionSubordinate: row.group_exemption_subordinate,
    centralOrgConfirmedAt: row.central_org_confirmed_at,
    mnosFirstSeenOn: row.mnos_first_seen_on,
    graceExpiresAt: row.grace_expires_at,
    evaluatedAt: row.evaluated_at,
    nextCheckAt: row.next_check_at,
  }
}

function toOrg(row: OrgRowSelect): OrgIdentityRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logoUrl: row.logo_url,
    verifiedStatus: row.verified_status,
    verifiedKind: row.verified_kind,
    suspended: row.suspended,
  }
}

export function makeDrizzleOrgPaymentsRepository(sql: Sql): OrgPaymentsRepository {
  async function readAccount(tag: Queryable, organizationId: string): Promise<StripeAccountRecord | null> {
    const rows = await tag<AccountRowSelect[]>`
      SELECT organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
             payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
             future_currently_due, capabilities, current_deadline, onboarding_state,
             payment_method_domains, deauthorized_at, reconnect_attempts,
             previous_stripe_account_ids, reconciled_through, last_synced_at
        FROM org_stripe_accounts
       WHERE organization_id = ${organizationId}
       LIMIT 1`
    return rows[0] === undefined ? null : toAccount(rows[0])
  }

  return {
    async findOrgById(organizationId) {
      const rows = await sql<OrgRowSelect[]>`
        SELECT o.id, o.slug, o.name, NULL::text AS logo_url, o.verified_status, o.verified_kind,
               (o.suspended_at IS NOT NULL) AS suspended
          FROM organizations o
         WHERE o.id = ${organizationId} AND o.deleted_at IS NULL
         LIMIT 1`
      return rows[0] === undefined ? null : toOrg(rows[0])
    },

    async findOrgBySlug(slug) {
      const rows = await sql<OrgRowSelect[]>`
        SELECT o.id, o.slug, o.name, NULL::text AS logo_url, o.verified_status, o.verified_kind,
               (o.suspended_at IS NOT NULL) AS suspended
          FROM organizations o
         WHERE o.slug = ${slug} AND o.deleted_at IS NULL
         LIMIT 1`
      return rows[0] === undefined ? null : toOrg(rows[0])
    },

    async paymentsView(organizationId) {
      const orgRows = await sql<OrgRowSelect[]>`
        SELECT o.id, o.slug, o.name, NULL::text AS logo_url, o.verified_status, o.verified_kind,
               (o.suspended_at IS NOT NULL) AS suspended
          FROM organizations o
         WHERE o.id = ${organizationId} AND o.deleted_at IS NULL
         LIMIT 1`
      const org = orgRows[0]
      if (org === undefined) return null

      const [account, settingsRows, eligibilityRows] = await Promise.all([
        readAccount(sql, organizationId),
        sql<SettingsRowSelect[]>`
          SELECT s.organization_id, s.enabled, s.disabled_reason, s.disabled_reason_text,
                 s.disabled_by, d.display_name AS disabled_by_name, d.handle AS disabled_by_handle,
                 d.created_at AS disabled_by_joined,
                 s.donor_sharing_default, s.mission_blurb, s.designation_note, s.refund_policy_text,
                 s.agreed_fee_bps, s.consent_agreement_version, s.consent_accepted_at,
                 u.display_name AS consent_accepted_by_name,
                 s.min_amount_minor, s.max_amount_minor, s.suggested_amounts_minor
            FROM org_donation_settings s
            LEFT JOIN users u ON u.id = s.consent_accepted_by
            LEFT JOIN users d ON d.id = s.disabled_by
           WHERE s.organization_id = ${organizationId}
           LIMIT 1`,
        sql<EligibilityRowSelect[]>`
          SELECT organization_id, verdict, reasons, ein, irs_legal_name, irs_address,
                 deductibility_code, foundation_code, contributions_deductible,
                 group_exemption_subordinate,
                 central_org_confirmed_at, mnos_first_seen_on::text AS mnos_first_seen_on,
                 grace_expires_at, evaluated_at, next_check_at
            FROM org_eligibility
           WHERE organization_id = ${organizationId}
           LIMIT 1`,
      ])

      return {
        org: toOrg(org),
        account,
        settings: settingsRows[0] === undefined ? null : toSettings(settingsRows[0]),
        eligibility: eligibilityRows[0] === undefined ? null : toEligibility(eligibilityRows[0]),
      }
    },

    async insertStripeAccount({ organizationId, status, state }) {
      const rows = await sql<AccountRowSelect[]>`
        INSERT INTO org_stripe_accounts (
          organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
          payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
          future_currently_due, capabilities, current_deadline, onboarding_state, last_synced_at
        ) VALUES (
          ${organizationId}, ${status.accountId}, ${status.livemode}, ${status.detailsSubmitted},
          ${status.chargesEnabled}, ${status.payoutsEnabled}, ${status.disabledReason},
          ${sql.json(status.currentlyDue)}, ${sql.json(status.pastDue)},
          ${sql.json(status.pendingVerification)}, ${sql.json(status.futureCurrentlyDue)},
          ${sql.json(status.capabilities)},
          ${status.currentDeadlineSec === null ? null : new Date(status.currentDeadlineSec * 1000)},
          ${state}, now()
        )
        ON CONFLICT (organization_id) DO NOTHING
        RETURNING organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
                  payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
                  future_currently_due, capabilities, current_deadline, onboarding_state,
                  payment_method_domains, deauthorized_at, reconnect_attempts,
                  previous_stripe_account_ids, reconciled_through, last_synced_at`
      const inserted = rows[0]
      if (inserted !== undefined) return toAccount(inserted)
      const existing = await readAccount(sql, organizationId)
      if (existing === null) {
        throw new Error("org_stripe_accounts row vanished between insert conflict and re-read")
      }
      return existing
    },

    async upsertStripeAccount({ organizationId, status, state, eventId, now }) {
      const rows = await sql<AccountRowSelect[]>`
        INSERT INTO org_stripe_accounts (
          organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
          payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
          future_currently_due, capabilities, current_deadline, onboarding_state,
          last_account_event_id, last_synced_at, updated_at
        ) VALUES (
          ${organizationId}, ${status.accountId}, ${status.livemode}, ${status.detailsSubmitted},
          ${status.chargesEnabled}, ${status.payoutsEnabled}, ${status.disabledReason},
          ${sql.json(status.currentlyDue)}, ${sql.json(status.pastDue)},
          ${sql.json(status.pendingVerification)}, ${sql.json(status.futureCurrentlyDue)},
          ${sql.json(status.capabilities)},
          ${status.currentDeadlineSec === null ? null : new Date(status.currentDeadlineSec * 1000)},
          ${state}, ${eventId ?? null}, ${now}, ${now}
        )
        ON CONFLICT (organization_id) DO UPDATE SET
          stripe_account_id    = EXCLUDED.stripe_account_id,
          livemode             = EXCLUDED.livemode,
          details_submitted    = EXCLUDED.details_submitted,
          charges_enabled      = EXCLUDED.charges_enabled,
          payouts_enabled      = EXCLUDED.payouts_enabled,
          disabled_reason      = EXCLUDED.disabled_reason,
          currently_due        = EXCLUDED.currently_due,
          past_due             = EXCLUDED.past_due,
          pending_verification = EXCLUDED.pending_verification,
          future_currently_due = EXCLUDED.future_currently_due,
          capabilities         = EXCLUDED.capabilities,
          current_deadline     = EXCLUDED.current_deadline,
          onboarding_state     = EXCLUDED.onboarding_state,
          last_account_event_id = COALESCE(EXCLUDED.last_account_event_id, org_stripe_accounts.last_account_event_id),
          last_synced_at       = EXCLUDED.last_synced_at,
          updated_at           = EXCLUDED.updated_at
        RETURNING organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
                  payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
                  future_currently_due, capabilities, current_deadline, onboarding_state,
                  payment_method_domains, deauthorized_at, reconnect_attempts,
                  previous_stripe_account_ids, reconciled_through, last_synced_at`
      const row = rows[0]
      if (row === undefined) throw new Error("org_stripe_accounts upsert returned no row")
      return toAccount(row)
    },

    async setPaymentMethodDomains(organizationId, domains) {
      await sql`
        UPDATE org_stripe_accounts
           SET payment_method_domains = ${sql.json([...domains] as unknown as Parameters<typeof sql.json>[0])}, updated_at = now()
         WHERE organization_id = ${organizationId}`
    },

    async markDeauthorized(stripeAccountId, now) {
      const rows = await sql<{ organization_id: string }[]>`
        UPDATE org_stripe_accounts
           SET deauthorized_at   = COALESCE(deauthorized_at, ${now}),
               onboarding_state  = 'blocked',
               charges_enabled   = false,
               updated_at        = ${now}
         WHERE stripe_account_id = ${stripeAccountId}
        RETURNING organization_id`
      return rows[0]?.organization_id ?? null
    },

    async relinkStripeAccount({ organizationId, status, state, now }) {
      const rows = await sql<AccountRowSelect[]>`
        UPDATE org_stripe_accounts
           SET stripe_account_id           = ${status.accountId},
               livemode                    = ${status.livemode},
               details_submitted           = ${status.detailsSubmitted},
               charges_enabled             = ${status.chargesEnabled},
               payouts_enabled             = ${status.payoutsEnabled},
               disabled_reason             = ${status.disabledReason},
               currently_due               = ${sql.json(status.currentlyDue)},
               past_due                    = ${sql.json(status.pastDue)},
               pending_verification        = ${sql.json(status.pendingVerification)},
               future_currently_due        = ${sql.json(status.futureCurrentlyDue)},
               capabilities                = ${sql.json(status.capabilities)},
               current_deadline            = ${status.currentDeadlineSec === null ? null : new Date(status.currentDeadlineSec * 1000)},
               onboarding_state            = ${state},
               payment_method_domains      = '[]'::jsonb,
               deauthorized_at             = NULL,
               reconnect_attempts          = reconnect_attempts + 1,
               previous_stripe_account_ids =
                 CASE WHEN stripe_account_id = ${status.accountId}
                      THEN previous_stripe_account_ids
                      ELSE previous_stripe_account_ids || to_jsonb(stripe_account_id) END,
               last_synced_at              = ${now},
               updated_at                  = ${now}
         WHERE organization_id = ${organizationId}
        RETURNING organization_id, stripe_account_id, livemode, details_submitted, charges_enabled,
                  payouts_enabled, disabled_reason, currently_due, past_due, pending_verification,
                  future_currently_due, capabilities, current_deadline, onboarding_state,
                  payment_method_domains, deauthorized_at, reconnect_attempts,
                  previous_stripe_account_ids, reconciled_through, last_synced_at`
      const row = rows[0]
      if (row === undefined) throw new Error("org_stripe_accounts relink matched no row")
      return toAccount(row)
    },

    async clearDeauthorization(organizationId, now) {
      const rows = await sql<{ organization_id: string }[]>`
        UPDATE org_stripe_accounts
           SET deauthorized_at = NULL, updated_at = ${now}
         WHERE organization_id = ${organizationId} AND deauthorized_at IS NOT NULL
        RETURNING organization_id`
      return rows.length > 0
    },

    async findOrgIdByStripeAccount(stripeAccountId) {
      const rows = await sql<{ organization_id: string }[]>`
        SELECT organization_id FROM org_stripe_accounts
         WHERE stripe_account_id = ${stripeAccountId} LIMIT 1`
      return rows[0]?.organization_id ?? null
    },

    async ensureSettings(organizationId, defaultFeeBps) {
      await sql`
        INSERT INTO org_donation_settings (organization_id, agreed_fee_bps)
        VALUES (${organizationId}, ${defaultFeeBps})
        ON CONFLICT (organization_id) DO NOTHING`
      const rows = await sql<SettingsRowSelect[]>`
        SELECT s.organization_id, s.enabled, s.disabled_reason, s.disabled_reason_text,
               s.disabled_by, d.display_name AS disabled_by_name, d.handle AS disabled_by_handle,
               d.created_at AS disabled_by_joined,
               s.donor_sharing_default, s.mission_blurb, s.designation_note, s.refund_policy_text,
               s.agreed_fee_bps, s.consent_agreement_version, s.consent_accepted_at,
               u.display_name AS consent_accepted_by_name,
               s.min_amount_minor, s.max_amount_minor, s.suggested_amounts_minor
          FROM org_donation_settings s
          LEFT JOIN users u ON u.id = s.consent_accepted_by
          LEFT JOIN users d ON d.id = s.disabled_by
         WHERE s.organization_id = ${organizationId}
         LIMIT 1`
      const row = rows[0]
      if (row === undefined) throw new Error("org_donation_settings row vanished after upsert")
      return toSettings(row)
    },

    async updateSettings(input) {
      await sql`
        UPDATE org_donation_settings SET
          donor_sharing_default   = COALESCE(${input.donorSharingDefault ?? null}, donor_sharing_default),
          mission_blurb           = CASE WHEN ${input.missionBlurb !== undefined} THEN ${input.missionBlurb ?? null} ELSE mission_blurb END,
          designation_note        = CASE WHEN ${input.designationNote !== undefined} THEN ${input.designationNote ?? null} ELSE designation_note END,
          refund_policy_text      = CASE WHEN ${input.refundPolicyText !== undefined} THEN ${input.refundPolicyText ?? null} ELSE refund_policy_text END,
          min_amount_minor        = COALESCE(${input.minAmountMinor ?? null}, min_amount_minor),
          max_amount_minor        = COALESCE(${input.maxAmountMinor ?? null}, max_amount_minor),
          suggested_amounts_minor = COALESCE(${input.suggestedAmountsMinor ?? null}::bigint[], suggested_amounts_minor),
          updated_at              = now()
        WHERE organization_id = ${input.organizationId}`
    },

    async setDonationsEnabled(input) {
      const rows = await sql<{ enabled: boolean }[]>`
        UPDATE org_donation_settings SET
          enabled              = ${input.enabled},
          disabled_reason      = ${input.enabled ? null : input.reason},
          disabled_reason_text = ${input.enabled ? null : input.reasonText},
          disabled_at          = ${input.enabled ? null : input.now},
          disabled_by          = ${input.enabled ? null : input.actorUserId},
          updated_at           = ${input.now}
        WHERE organization_id = ${input.organizationId}
        RETURNING enabled`
      return rows[0]?.enabled ?? false
    },

    async acceptAgreement(input) {
      await sql.begin(async (tx) => {
        const priorRows = await tx<{ consent_agreement_version: string | null; agreed_fee_bps: number }[]>`
          SELECT consent_agreement_version, agreed_fee_bps
            FROM org_donation_settings
           WHERE organization_id = ${input.organizationId}
           FOR UPDATE`
        const prior = priorRows[0]

        await tx`
          INSERT INTO org_donation_settings (
            organization_id, agreed_fee_bps, consent_agreement_version, consent_accepted_at, consent_accepted_by
          ) VALUES (
            ${input.organizationId}, ${input.feeBps}, ${input.version}, ${input.now}, ${input.userId}
          )
          ON CONFLICT (organization_id) DO UPDATE SET
            agreed_fee_bps            = ${input.feeBps},
            consent_agreement_version = ${input.version},
            consent_accepted_at       = ${input.now},
            consent_accepted_by       = ${input.userId},
            updated_at                = ${input.now}`

        await tx`
          INSERT INTO consent_records (
            subject_kind, user_id, organization_id, document_type, document_version,
            document_sha256, accepted_at, surface, screen_route, ui_template_version
          ) VALUES (
            'organization', ${input.userId}, ${input.organizationId}, 'org_donation_agreement',
            ${input.version}, ${input.documentSha256}, ${input.now}, ${input.surface},
            ${input.screenRoute}, ${input.uiTemplateVersion}
          )`

        await tx`
          INSERT INTO org_donation_agreement_changes (
            organization_id, from_version, to_version, document_sha256, change_kind,
            fee_bps_before, fee_bps_after, actor_user_id, notified_at
          ) VALUES (
            ${input.organizationId}, ${prior?.consent_agreement_version ?? null}, ${input.version},
            ${input.documentSha256}, 'accepted', ${prior?.agreed_fee_bps ?? null}, ${input.feeBps},
            ${input.userId}, ${input.now}
          )`
      })
    },

    async agreementHistory(organizationId, limit) {
      const rows = await sql<
        { to_version: string; created_at: Date; actor_name: string | null; surface: string | null }[]
      >`
        SELECT c.to_version, c.created_at, u.display_name AS actor_name, NULL::text AS surface
          FROM org_donation_agreement_changes c
          LEFT JOIN users u ON u.id = c.actor_user_id
         WHERE c.organization_id = ${organizationId}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ${limit}`
      return rows.map((row) => ({
        version: row.to_version,
        acceptedAt: row.created_at,
        acceptedByName: row.actor_name,
        surface: row.surface,
      }))
    },

    async recentChecks(organizationId, limit) {
      const rows = await sql<
        {
          source: string
          source_revision_date: string
          matched: boolean
          verdict_contribution: "supports" | "disqualifies" | "neutral"
          detail: string | null
          checked_at: Date
        }[]
      >`
        SELECT source, source_revision_date::text AS source_revision_date, matched,
               verdict_contribution, detail, checked_at
          FROM org_eligibility_checks
         WHERE organization_id = ${organizationId}
         ORDER BY checked_at DESC, id DESC
         LIMIT ${limit}`
      return rows.map((row) => ({
        source: row.source,
        sourceRevisionDate: row.source_revision_date,
        matched: row.matched,
        verdictContribution: row.verdict_contribution,
        detail: row.detail,
        checkedAt: row.checked_at,
      }))
    },

    async listAccountsForSync(limit) {
      const rows = await sql<{ organization_id: string; stripe_account_id: string }[]>`
        SELECT organization_id, stripe_account_id
          FROM org_stripe_accounts
         WHERE deauthorized_at IS NULL
         ORDER BY COALESCE(last_synced_at, to_timestamp(0)) ASC
         LIMIT ${limit}`
      return rows.map((row) => ({
        organizationId: row.organization_id,
        stripeAccountId: row.stripe_account_id,
      }))
    },

    async listOnboardedAccounts(limit, afterOrganizationId) {
      const rows = await sql<
        { organization_id: string; stripe_account_id: string; reconciled_through: Date | null }[]
      >`
        SELECT organization_id, stripe_account_id, reconciled_through
          FROM org_stripe_accounts
         WHERE deauthorized_at IS NULL
           AND (${afterOrganizationId}::uuid IS NULL OR organization_id > ${afterOrganizationId})
         ORDER BY organization_id ASC
         LIMIT ${limit}`
      return rows.map((row) => ({
        organizationId: row.organization_id,
        stripeAccountId: row.stripe_account_id,
        reconciledThrough: row.reconciled_through,
      }))
    },

    async findEventRef(eventId, organizationId) {
      const rows = await sql<{ id: string; title: string; scheduled_at: Date }[]>`
        SELECT id, title, scheduled_at
          FROM cleanups
         WHERE id = ${eventId} AND organization_id = ${organizationId}
         LIMIT 1`
      const row = rows[0]
      return row === undefined
        ? null
        : { id: row.id, title: row.title, startsAt: row.scheduled_at.toISOString() }
    },

    async findVerifiedUserEmail(userId) {
      const rows = await sql<{ email: string | null }[]>`
        SELECT email FROM users
         WHERE id = ${userId} AND email_verified = true AND deleted_at IS NULL
         LIMIT 1`
      const email = rows[0]?.email ?? null
      return email !== null && email.length > 0 ? email : null
    },

    async orgRoleOf(organizationId, userId) {
      const rows = await sql<{ role: OrganizationMemberRole }[]>`
        SELECT om.role
          FROM organization_members om
          JOIN organizations o ON o.id = om.organization_id AND o.deleted_at IS NULL
         WHERE om.organization_id = ${organizationId} AND om.user_id = ${userId}
         LIMIT 1`
      return rows[0]?.role ?? null
    },
  }
}
