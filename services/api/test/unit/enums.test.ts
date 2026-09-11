
import { describe, expect, it } from "vitest"
import {
  AbuseReasonSchema,
  AbuseSourceSchema,
  AbuseSubjectTypeSchema,
  ChatMessageKindSchema,
  CleanupMemberRoleSchema,
  CleanupStatusSchema,
  CleanupTypeSchema,
  DiscoveryStatusSchema,
  EventKindSchema,
  GeomSourceSchema,
  GovClaimStatusSchema,
  GovMethodSchema,
  JurisdictionLayerSchema,
  MailDirectionSchema,
  MailStatusSchema,
  MediaKindSchema,
  MediaPurposeSchema,
  MediaStatusSchema,
  ModerationKindSchema,
  ModerationSubjectTypeSchema,
  NotificationTypeSchema,
  OAuthProviderSchema,
  PostKindSchema,
  PrioritySchema,
  RegisterPushTokenRequestSchema,
  ReportCategorySchema,
  ReportStatusSchema,
  ReportTypeSchema,
  ReportVisibilitySchema,
  RiskSchema,
  RoleSchema,
  UserStatusSchema,
  EventVisibilitySchema,
  OrganizationMemberRoleSchema,
  OrgVerificationStatusSchema,
  OrgVerificationKindSchema,
  EventTeamRoleSchema,
  EventTeamInviteStatusSchema,
  TicketTypeVisibilitySchema,
  RegistrationStatusSchema,
  RegistrationSourceSchema,
  SeatStatusSchema,
  CheckinMethodSchema,
  WaitlistStatusSchema,
  EventQuestionKindSchema,
  EventPageStatusSchema,
  EventPageBlockKindSchema,
  ThemeAccentSchema,
  BroadcastKindSchema,
  BroadcastStatusSchema,
  BroadcastChannelSchema,
  DeliveryStatusSchema,
  DeliverySuppressionReasonSchema,
  DeliveryFailureKindSchema,
  PageViewSourceSchema,
  HostExportKindSchema,
  HostExportStatusSchema,
  DonationStatusSchema,
  DonationDisputeStateSchema,
  PayoutStatusSchema,
  OrgPaymentsStateSchema,
  DonateStateSchema,
  EligibilityVerdictSchema,
  EligibilitySourceSchema,
  LegalDocumentTypeSchema,
  ConsentSurfaceSchema,
} from "@civfix/shared"
import {
  ABUSE_REASON_VALUES,
  ABUSE_SOURCE_VALUES,
  ABUSE_SUBJECT_TYPE_VALUES,
  CHAT_MESSAGE_KIND_VALUES,
  CLEANUP_STATUS_VALUES,
  CLEANUP_TYPE_VALUES,
  DISCOVERY_STATUS_VALUES,
  EVENT_KIND_VALUES,
  GEOM_SOURCE_VALUES,
  GOV_CLAIM_STATUS_VALUES,
  GOV_METHOD_VALUES,
  JURISDICTION_LAYER_VALUES,
  MAIL_DIRECTION_VALUES,
  MAIL_THREAD_STATUS_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_STATUS_VALUES,
  MODERATION_KIND_VALUES,
  MODERATION_SUBJECT_TYPE_VALUES,
  MODERATION_PRIORITY_VALUES,
  NOTIFICATION_TYPE_VALUES,
  OAUTH_PROVIDER_VALUES,
  POST_KIND_VALUES,
  PUSH_PLATFORM_VALUES,
  REPORT_CATEGORY_VALUES,
  REPORT_STATUS_VALUES,
  REPORT_TYPE_VALUES,
  REPORT_VISIBILITY_VALUES,
  ROLE_VALUES,
  USER_ACCOUNT_STATUS_VALUES,
  USER_RISK_VALUES,
} from "../../src/db/schema/types.js"
import {
  CLEANUP_MEMBER_ROLE_VALUES,
  MEDIA_PURPOSE_VALUES,
  EVENT_VISIBILITY_VALUES,
  ORGANIZATION_MEMBER_ROLE_VALUES,
  ORG_VERIFICATION_STATUS_VALUES,
  ORGANIZATION_INVITE_STATUS_VALUES,
  ORG_VERIFICATION_KIND_VALUES,
  EVENT_TEAM_ROLE_VALUES,
  EVENT_TEAM_INVITE_STATUS_VALUES,
} from "../../src/db/schema/types-host.js"
import {
  TICKET_TYPE_VISIBILITY_VALUES,
  REGISTRATION_STATUS_VALUES,
  REGISTRATION_SOURCE_VALUES,
  SEAT_STATUS_VALUES,
  CHECKIN_METHOD_VALUES,
  WAITLIST_STATUS_VALUES,
  EVENT_QUESTION_KIND_VALUES,
  EVENT_PAGE_STATUS_VALUES,
  EVENT_PAGE_BLOCK_KIND_VALUES,
  THEME_ACCENT_VALUES,
} from "../../src/db/schema/types-registration.js"
import {
  BROADCAST_KIND_VALUES,
  BROADCAST_STATUS_VALUES,
  BROADCAST_CHANNEL_VALUES,
  DELIVERY_STATUS_VALUES,
  DELIVERY_SUPPRESSION_REASON_VALUES,
  DELIVERY_FAILURE_KIND_VALUES,
  PAGE_VIEW_SOURCE_VALUES,
  HOST_EXPORT_KIND_VALUES,
  HOST_EXPORT_STATUS_VALUES,
} from "../../src/db/schema/types-broadcast.js"
import {
  DONATION_STATUS_VALUES,
  DONATION_DISPUTE_STATE_VALUES,
  PAYOUT_STATUS_VALUES,
  ORG_PAYMENTS_STATE_VALUES,
  DONATE_STATE_VALUES,
  ELIGIBILITY_VERDICT_VALUES,
  ELIGIBILITY_SOURCE_VALUES,
  LEGAL_DOCUMENT_TYPE_VALUES,
  CONSENT_SURFACE_VALUES,
} from "../../src/db/schema/types-payments.js"

describe("schema enum tuples mirror @civfix/shared", () => {
  it.each([
    ["Role", ROLE_VALUES, RoleSchema.options],
    ["ReportCategory", REPORT_CATEGORY_VALUES, ReportCategorySchema.options],
    ["ReportType", REPORT_TYPE_VALUES, ReportTypeSchema.options],
    ["ReportStatus", REPORT_STATUS_VALUES, ReportStatusSchema.options],
    ["GeomSource", GEOM_SOURCE_VALUES, GeomSourceSchema.options],
    ["ReportVisibility", REPORT_VISIBILITY_VALUES, ReportVisibilitySchema.options],
    ["MediaKind", MEDIA_KIND_VALUES, MediaKindSchema.options],
    ["MediaStatus", MEDIA_STATUS_VALUES, MediaStatusSchema.options],
    ["JurisdictionLayer", JURISDICTION_LAYER_VALUES, JurisdictionLayerSchema.options],
    ["CleanupType", CLEANUP_TYPE_VALUES, CleanupTypeSchema.options],
    ["CleanupStatus", CLEANUP_STATUS_VALUES, CleanupStatusSchema.options],
    ["EventKind", EVENT_KIND_VALUES, EventKindSchema.options],
    ["OAuthProvider", OAUTH_PROVIDER_VALUES, OAuthProviderSchema.options],
    ["CleanupMemberRole", CLEANUP_MEMBER_ROLE_VALUES, CleanupMemberRoleSchema.options],
    ["AbuseSubjectType", ABUSE_SUBJECT_TYPE_VALUES, AbuseSubjectTypeSchema.options],
    ["AbuseReason", ABUSE_REASON_VALUES, AbuseReasonSchema.options],
    ["AbuseSource", ABUSE_SOURCE_VALUES, AbuseSourceSchema.options],
    ["DiscoveryStatus", DISCOVERY_STATUS_VALUES, DiscoveryStatusSchema.options],
    ["GovMethod", GOV_METHOD_VALUES, GovMethodSchema.options],
    ["GovClaimStatus", GOV_CLAIM_STATUS_VALUES, GovClaimStatusSchema.options],
    ["UserStatus", USER_ACCOUNT_STATUS_VALUES, UserStatusSchema.options],
    ["Risk", USER_RISK_VALUES, RiskSchema.options],
    ["ModerationKind", MODERATION_KIND_VALUES, ModerationKindSchema.options],
    [
      "ModerationSubjectType",
      MODERATION_SUBJECT_TYPE_VALUES,
      ModerationSubjectTypeSchema.options,
    ],
    ["Priority", MODERATION_PRIORITY_VALUES, PrioritySchema.options],
    ["MailStatus", MAIL_THREAD_STATUS_VALUES, MailStatusSchema.options],
    ["MailDirection", MAIL_DIRECTION_VALUES, MailDirectionSchema.options],
    ["EventVisibility", EVENT_VISIBILITY_VALUES, EventVisibilitySchema.options],
    ["OrganizationMemberRole", ORGANIZATION_MEMBER_ROLE_VALUES, OrganizationMemberRoleSchema.options],
    ["OrgVerificationStatus", ORG_VERIFICATION_STATUS_VALUES, OrgVerificationStatusSchema.options],
    ["OrgVerificationKind", ORG_VERIFICATION_KIND_VALUES, OrgVerificationKindSchema.options],
    ["EventTeamRole", EVENT_TEAM_ROLE_VALUES, EventTeamRoleSchema.options],
    ["EventTeamInviteStatus", EVENT_TEAM_INVITE_STATUS_VALUES, EventTeamInviteStatusSchema.options],
    ["TicketTypeVisibility", TICKET_TYPE_VISIBILITY_VALUES, TicketTypeVisibilitySchema.options],
    ["RegistrationStatus", REGISTRATION_STATUS_VALUES, RegistrationStatusSchema.options],
    ["RegistrationSource", REGISTRATION_SOURCE_VALUES, RegistrationSourceSchema.options],
    ["SeatStatus", SEAT_STATUS_VALUES, SeatStatusSchema.options],
    ["CheckinMethod", CHECKIN_METHOD_VALUES, CheckinMethodSchema.options],
    ["WaitlistStatus", WAITLIST_STATUS_VALUES, WaitlistStatusSchema.options],
    ["EventQuestionKind", EVENT_QUESTION_KIND_VALUES, EventQuestionKindSchema.options],
    ["EventPageStatus", EVENT_PAGE_STATUS_VALUES, EventPageStatusSchema.options],
    ["EventPageBlockKind", EVENT_PAGE_BLOCK_KIND_VALUES, EventPageBlockKindSchema.options],
    ["ThemeAccent", THEME_ACCENT_VALUES, ThemeAccentSchema.options],
    ["BroadcastKind", BROADCAST_KIND_VALUES, BroadcastKindSchema.options],
    ["BroadcastStatus", BROADCAST_STATUS_VALUES, BroadcastStatusSchema.options],
    ["BroadcastChannel", BROADCAST_CHANNEL_VALUES, BroadcastChannelSchema.options],
    ["DeliveryStatus", DELIVERY_STATUS_VALUES, DeliveryStatusSchema.options],
    [
      "DeliverySuppressionReason",
      DELIVERY_SUPPRESSION_REASON_VALUES,
      DeliverySuppressionReasonSchema.options,
    ],
    ["DeliveryFailureKind", DELIVERY_FAILURE_KIND_VALUES, DeliveryFailureKindSchema.options],
    ["PageViewSource", PAGE_VIEW_SOURCE_VALUES, PageViewSourceSchema.options],
    ["HostExportKind", HOST_EXPORT_KIND_VALUES, HostExportKindSchema.options],
    ["HostExportStatus", HOST_EXPORT_STATUS_VALUES, HostExportStatusSchema.options],
    ["DonationStatus", DONATION_STATUS_VALUES, DonationStatusSchema.options],
    ["DonationDisputeState", DONATION_DISPUTE_STATE_VALUES, DonationDisputeStateSchema.options],
    ["PayoutStatus", PAYOUT_STATUS_VALUES, PayoutStatusSchema.options],
    ["OrgPaymentsState", ORG_PAYMENTS_STATE_VALUES, OrgPaymentsStateSchema.options],
    ["DonateState", DONATE_STATE_VALUES, DonateStateSchema.options],
    ["EligibilityVerdict", ELIGIBILITY_VERDICT_VALUES, EligibilityVerdictSchema.options],
    ["EligibilitySource", ELIGIBILITY_SOURCE_VALUES, EligibilitySourceSchema.options],
    ["LegalDocumentType", LEGAL_DOCUMENT_TYPE_VALUES, LegalDocumentTypeSchema.options],
    ["ConsentSurface", CONSENT_SURFACE_VALUES, ConsentSurfaceSchema.options],
  ])("%s matches the shared enum exactly", (_name, mirrored, shared) => {
    expect([...mirrored]).toEqual([...shared])
  })

  it("ChatMessageKind matches the shared enum (tolerating the P6 'poll' value shipping ahead)", () => {
    const shared: string[] = [...ChatMessageKindSchema.options]
    const expected = shared.includes("poll") ? shared : [...shared, "poll"]
    expect([...CHAT_MESSAGE_KIND_VALUES]).toEqual(expected)
  })

  it("NotificationType matches the shared enum (tolerating the P4 'group_chat' value shipping ahead)", () => {
    const shared: string[] = [...NotificationTypeSchema.options]
    const expected = shared.includes("group_chat") ? shared : [...shared, "group_chat"]
    expect([...NOTIFICATION_TYPE_VALUES]).toEqual(expected)
  })

  it("PostKind matches the shared enum exactly", () => {
    expect([...POST_KIND_VALUES]).toEqual([...PostKindSchema.options])
    expect([...POST_KIND_VALUES]).toEqual(["post", "repost", "quote", "reply"])
  })

  it("NotificationType carries the five social-feed post interaction values (in order)", () => {
    expect(NOTIFICATION_TYPE_VALUES.slice(-10, -5)).toEqual([
      "post_like",
      "post_repost",
      "post_reply",
      "post_quote",
      "post_mention",
    ])
    for (const t of ["post_like", "post_repost", "post_reply", "post_quote", "post_mention"]) {
      expect(NotificationTypeSchema.options).toContain(t)
    }
  })

  it("NotificationType carries the two service-hours values (LAST, in order)", () => {
    expect(NOTIFICATION_TYPE_VALUES.slice(-5, -3)).toEqual(["cleanup_slot", "hours_logged"])
    for (const t of ["cleanup_slot", "hours_logged"]) {
      expect(NotificationTypeSchema.options).toContain(t)
    }
  })

  it("NotificationType keeps broadcast, then event-team-invite, then org_invite LAST", () => {
    expect(NOTIFICATION_TYPE_VALUES.at(-3)).toBe("event_broadcast")
    expect(NotificationTypeSchema.options.at(-3)).toBe("event_broadcast")
    expect(NOTIFICATION_TYPE_VALUES.at(-2)).toBe("event_team_invite")
    expect(NotificationTypeSchema.options.at(-2)).toBe("event_team_invite")
    expect(NOTIFICATION_TYPE_VALUES.at(-1)).toBe("org_invite")
    expect(NotificationTypeSchema.options.at(-1)).toBe("org_invite")
  })

  it("CleanupMemberRole appends coordinator LAST and EventTeamRole stays its invitable subset", () => {
    expect(CLEANUP_MEMBER_ROLE_VALUES.at(-1)).toBe("coordinator")
    expect([...EVENT_TEAM_ROLE_VALUES]).toEqual(["cohost", "staff", "coordinator"])
    const positions = EVENT_TEAM_ROLE_VALUES.map((role) =>
      (CLEANUP_MEMBER_ROLE_VALUES as readonly string[]).indexOf(role),
    )
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b))
  })

  it("EventTeamInviteStatus appends declined LAST, distinct from revoked", () => {
    expect([...EVENT_TEAM_INVITE_STATUS_VALUES]).toEqual([
      "pending",
      "accepted",
      "revoked",
      "expired",
      "declined",
    ])
  })

  // The DB value set is a SUPERSET of the client-facing one by exactly one value: 'verification' is
  // written only by the server (organization-repository claims org verification documents with it, and
  // media-authorization denies it on every public path), and 0.43.0 dropped it from the shared enum
  // when the per-user "verified neighbor" queue was retired. Every other value must still match, in
  // order, or a purpose the client can ask for is one the column would reject.
  it("MediaPurpose is the shared enum plus the server-only 'verification' purpose", () => {
    expect([...MEDIA_PURPOSE_VALUES]).toEqual([
      "report",
      "verification",
      "post",
      "event_cover",
      "event_gallery",
      "org_logo",
    ])
    expect(MEDIA_PURPOSE_VALUES.filter((v) => v !== "verification")).toEqual([
      ...MediaPurposeSchema.options,
    ])
  })

  it("OrganizationInviteStatus appends declined LAST, distinct from revoked", () => {
    expect([...ORGANIZATION_INVITE_STATUS_VALUES]).toEqual([
      "pending",
      "accepted",
      "revoked",
      "expired",
      "declined",
    ])
  })

  it("PushPlatform matches the shared register-push-token platform enum", () => {
    const shape = RegisterPushTokenRequestSchema.shape
    const platformOptions = (shape.platform as { options: readonly string[] }).options
    expect([...PUSH_PLATFORM_VALUES]).toEqual([...platformOptions])
  })
})
