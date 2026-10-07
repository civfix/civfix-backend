import type {
  EventHoursEntry,
  LeaderboardEntryDTO,
  MyVolunteerHoursDTO,
  OrganizationRefDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import type { KeysetCursor } from "../db/cursor-helpers.js"

export type VolunteerHoursAnomalyKind = "weekly_hours" | "reciprocal_credit"

export interface VolunteerHoursAnomaly {
  kind: VolunteerHoursAnomalyKind
  userId: string
  counterpartUserId: string | null
  hours: number | null
}

export interface LogEventHoursArgs {
  actorId: string
  cleanupId: string
  geoid: string | null
  entries: EventHoursEntry[]
  dailyCapHours?: number
  weeklyFlagHours?: number
}

export interface EventCreditChange {
  userId: string
  hours: number
  previousHours: number | null
}

export interface EventCreditWrite {
  cleanupId: string
  geoid: string | null
  actorId: string
  loggedByUserId: string
  note: string | null
  creditedByOperatorId: string | null
  entries: readonly EventHoursEntry[]
}

export interface OperatorEventCreditArgs {
  operatorId: string
  userId: string
  cleanupId: string
  geoid: string | null
  hours: number
  reason: string
  dailyCapHours?: number
}

export interface OperatorManualCreditArgs {
  operatorId: string
  userId: string
  hours: number
  serviceDate: string
  reason: string
  dailyCapHours?: number
}

export interface OperatorCreditResult {
  entryId: string
}

export interface OperatorVoidArgs {
  operatorId: string
  userId: string
  entryId: string
  reason: string
}

export interface VoidedEntry {
  id: string
  source: VolunteerHoursSource
  cleanupId: string | null
  hours: number
}

export interface OperatorLedgerArgs {
  userId: string
  cursor: KeysetCursor | null
  limit: number
}

export interface OperatorLedgerEntryView {
  id: string
  source: VolunteerHoursSource
  hours: number
  occurredAt: Date
  createdAt: Date
  serviceDate: string | null
  event: { id: string; title: string; referenceCode: string | null } | null
  jurisdiction: { geoid: string; name: string | null } | null
  creditedBy: { id: string; name: string; handle: string; official: boolean } | null
  operator: { id: string; name: string } | null
  note: string | null
  voidedAt: Date | null
  voidedBy: { id: string; name: string } | null
  voidReason: string | null
}

export interface OperatorLedgerTotals {
  totalHours: number
  liveEntries: number
  voidedEntries: number
}

export interface LogEventHoursResult {
  credited: number
  changed: EventCreditChange[]
  anomalies: VolunteerHoursAnomaly[]
}

export interface VolunteerHoursEntryView {
  id: string
  source: VolunteerHoursSource
  hours: number
  createdAt: Date
  occurredAt: Date
  cleanupId: string | null
  cleanupTitle: string | null
  cleanupReferenceCode: string | null
  reportId: string | null
  jurisdictionGeoid: string | null
  jurisdictionName: string | null
  creditedBy: {
    id: string
    name: string
    handle: string | null
    organization: OrganizationRefDTO | null
  } | null
}

export interface EventHoursLedgerEntry {
  userId: string
  hours: number
  loggedAt: Date
  creditedByOfficial: boolean
}

export interface EventHoursLedger {
  entries: EventHoursLedgerEntry[]
  anyLogged: boolean
}

export interface HoursVisibility {
  aggregate: boolean
  items: boolean
}

export interface LeaderboardPage {
  jurisdictionName: string | null
  entries: LeaderboardEntryDTO[]
  nextOffset: number | null
  participantCount: number | null
  viewerRank: number | null
  viewerHours: number | null
}

export interface ListEntriesArgs {
  userId: string
  cursor: KeysetCursor | null
  limit: number
  sources?: VolunteerHoursSource[]
}

export interface EntriesForCertificateArgs {
  userId: string
  geoid: string | null
  from: Date | null
  to: Date | null
  limit: number
}

export interface CertificateEntriesPage {
  items: VolunteerHoursEntryView[]
  totalHours: number
  entryCount: number
}

export interface OrgHoursView {
  organizationId: string
  slug: string
  name: string
  logoKey: string | null
  verified: boolean
  verifiedKind: OrganizationRefDTO["verifiedKind"]
  hours: number
}

export interface MyVolunteerHoursTotals {
  totalHours: number
  byJurisdiction: MyVolunteerHoursDTO["byJurisdiction"]
  byOrganization: OrgHoursView[]
}

export interface VolunteerHoursRepository {
  logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult>
  totalsFor(userId: string): Promise<MyVolunteerHoursTotals>
  totalHoursFor(userId: string): Promise<number>
  leaderboard(
    geoid: string,
    limit: number,
    offset: number,
    viewerId: string | null,
    withExtras: boolean,
  ): Promise<LeaderboardPage>
  listEntries(
    args: ListEntriesArgs,
  ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }>
  listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger>
  hoursVisibilityFor(userId: string): Promise<HoursVisibility>
  entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage>
  creditEventAsOperator(args: OperatorEventCreditArgs): Promise<OperatorCreditResult>
  creditManual(args: OperatorManualCreditArgs): Promise<OperatorCreditResult>
  voidEntry(args: OperatorVoidArgs): Promise<VoidedEntry>
  listOperatorLedger(
    args: OperatorLedgerArgs,
  ): Promise<{ items: OperatorLedgerEntryView[]; nextCursor: string | null }>
  operatorLedgerTotals(userId: string): Promise<OperatorLedgerTotals>
}
