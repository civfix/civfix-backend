/**
 * Drift guard: the enum value tuples in src/db/schema/types.ts MIRROR the @civfix/shared Zod enums
 * (the DB layer must not depend on Zod runtime objects). This test asserts they stay byte-for-byte
 * identical, so any change to the shared contract that is not reflected in the schema mirror fails CI
 * here instead of silently diverging. No database needed.
 */

import { describe, expect, it } from "vitest"
import {
  ChatMessageKindSchema,
  CleanupStatusSchema,
  CleanupTypeSchema,
  GeomSourceSchema,
  JurisdictionLayerSchema,
  MediaKindSchema,
  MediaStatusSchema,
  NotificationTypeSchema,
  RegisterPushTokenRequestSchema,
  ReportCategorySchema,
  ReportStatusSchema,
  ReportVisibilitySchema,
  RoleSchema,
} from "@civfix/shared"
import {
  CHAT_MESSAGE_KIND_VALUES,
  CLEANUP_STATUS_VALUES,
  CLEANUP_TYPE_VALUES,
  GEOM_SOURCE_VALUES,
  JURISDICTION_LAYER_VALUES,
  MEDIA_KIND_VALUES,
  MEDIA_STATUS_VALUES,
  NOTIFICATION_TYPE_VALUES,
  PUSH_PLATFORM_VALUES,
  REPORT_CATEGORY_VALUES,
  REPORT_STATUS_VALUES,
  REPORT_VISIBILITY_VALUES,
  ROLE_VALUES,
} from "../../src/db/schema/types.js"

describe("schema enum tuples mirror @civfix/shared", () => {
  it.each([
    ["Role", ROLE_VALUES, RoleSchema.options],
    ["ReportCategory", REPORT_CATEGORY_VALUES, ReportCategorySchema.options],
    ["ReportStatus", REPORT_STATUS_VALUES, ReportStatusSchema.options],
    ["GeomSource", GEOM_SOURCE_VALUES, GeomSourceSchema.options],
    ["ReportVisibility", REPORT_VISIBILITY_VALUES, ReportVisibilitySchema.options],
    ["MediaKind", MEDIA_KIND_VALUES, MediaKindSchema.options],
    ["MediaStatus", MEDIA_STATUS_VALUES, MediaStatusSchema.options],
    ["JurisdictionLayer", JURISDICTION_LAYER_VALUES, JurisdictionLayerSchema.options],
    ["CleanupType", CLEANUP_TYPE_VALUES, CleanupTypeSchema.options],
    ["CleanupStatus", CLEANUP_STATUS_VALUES, CleanupStatusSchema.options],
    ["ChatMessageKind", CHAT_MESSAGE_KIND_VALUES, ChatMessageKindSchema.options],
    ["NotificationType", NOTIFICATION_TYPE_VALUES, NotificationTypeSchema.options],
  ])("%s matches the shared enum exactly", (_name, mirrored, shared) => {
    expect([...mirrored]).toEqual([...shared])
  })

  it("PushPlatform matches the shared register-push-token platform enum", () => {
    // platform is an inline enum on the request schema rather than a standalone export.
    const shape = RegisterPushTokenRequestSchema.shape
    const platformOptions = (shape.platform as { options: readonly string[] }).options
    expect([...PUSH_PLATFORM_VALUES]).toEqual([...platformOptions])
  })
})
