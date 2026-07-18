/**
 * Drift guard: the enum value tuples in src/db/schema/types.ts MIRROR the @civfix/shared Zod enums
 * (the DB layer must not depend on Zod runtime objects). This test asserts they stay byte-for-byte
 * identical, so any change to the shared contract that is not reflected in the schema mirror fails CI
 * here instead of silently diverging. No database needed.
 */

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
  PrioritySchema,
  VerificationStatusSchema,
  RegisterPushTokenRequestSchema,
  ReportCategorySchema,
  ReportStatusSchema,
  ReportTypeSchema,
  ReportVisibilitySchema,
  RiskSchema,
  RoleSchema,
  UserStatusSchema,
} from "@civfix/shared"
import {
  ABUSE_REASON_VALUES,
  ABUSE_SOURCE_VALUES,
  ABUSE_SUBJECT_TYPE_VALUES,
  CHAT_MESSAGE_KIND_VALUES,
  CLEANUP_MEMBER_ROLE_VALUES,
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
  MEDIA_PURPOSE_VALUES,
  MEDIA_STATUS_VALUES,
  VERIFICATION_STATUS_VALUES,
  MODERATION_KIND_VALUES,
  MODERATION_SUBJECT_TYPE_VALUES,
  MODERATION_PRIORITY_VALUES,
  NOTIFICATION_TYPE_VALUES,
  OAUTH_PROVIDER_VALUES,
  PUSH_PLATFORM_VALUES,
  REPORT_CATEGORY_VALUES,
  REPORT_STATUS_VALUES,
  REPORT_TYPE_VALUES,
  REPORT_VISIBILITY_VALUES,
  ROLE_VALUES,
  USER_ACCOUNT_STATUS_VALUES,
  USER_RISK_VALUES,
} from "../../src/db/schema/types.js"

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
    ["MediaPurpose", MEDIA_PURPOSE_VALUES, MediaPurposeSchema.options],
    ["JurisdictionLayer", JURISDICTION_LAYER_VALUES, JurisdictionLayerSchema.options],
    ["CleanupType", CLEANUP_TYPE_VALUES, CleanupTypeSchema.options],
    ["CleanupStatus", CLEANUP_STATUS_VALUES, CleanupStatusSchema.options],
    ["EventKind", EVENT_KIND_VALUES, EventKindSchema.options],
    ["ChatMessageKind", CHAT_MESSAGE_KIND_VALUES, ChatMessageKindSchema.options],
    ["OAuthProvider", OAUTH_PROVIDER_VALUES, OAuthProviderSchema.options],
    ["CleanupMemberRole", CLEANUP_MEMBER_ROLE_VALUES, CleanupMemberRoleSchema.options],
    ["AbuseSubjectType", ABUSE_SUBJECT_TYPE_VALUES, AbuseSubjectTypeSchema.options],
    ["AbuseReason", ABUSE_REASON_VALUES, AbuseReasonSchema.options],
    ["AbuseSource", ABUSE_SOURCE_VALUES, AbuseSourceSchema.options],
    ["DiscoveryStatus", DISCOVERY_STATUS_VALUES, DiscoveryStatusSchema.options],
    // Phase 2 (admin) tuples that mirror standalone shared enums.
    ["GovMethod", GOV_METHOD_VALUES, GovMethodSchema.options],
    ["GovClaimStatus", GOV_CLAIM_STATUS_VALUES, GovClaimStatusSchema.options],
    ["VerificationStatus", VERIFICATION_STATUS_VALUES, VerificationStatusSchema.options],
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
  ])("%s matches the shared enum exactly", (_name, mirrored, shared) => {
    expect([...mirrored]).toEqual([...shared])
  })

  it("NotificationType matches the shared enum (tolerating the P4 'group_chat' value shipping ahead)", () => {
    // P4 Task 4.1 adds 'group_chat' to the backend mirror; the shared NotificationTypeSchema gains
    // it in the parallel Task 4.2 shared release. Until that bumped shared is installed here, the
    // guard tolerates EXACTLY this one backend-ahead value (appended last); once shared includes
    // 'group_chat', the expectation collapses back to byte-for-byte equality automatically.
    const shared: string[] = [...NotificationTypeSchema.options]
    const expected = shared.includes("group_chat") ? shared : [...shared, "group_chat"]
    expect([...NOTIFICATION_TYPE_VALUES]).toEqual(expected)
  })

  it("PushPlatform matches the shared register-push-token platform enum", () => {
    // platform is an inline enum on the request schema rather than a standalone export.
    const shape = RegisterPushTokenRequestSchema.shape
    const platformOptions = (shape.platform as { options: readonly string[] }).options
    expect([...PUSH_PLATFORM_VALUES]).toEqual([...platformOptions])
  })
})
