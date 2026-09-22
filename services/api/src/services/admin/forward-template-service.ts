import {
  FORWARD_TEMPLATE_SAMPLE_VALUES,
  type ForwardTemplateSettingsDTO,
  type ForwardTemplateSource,
  type PreviewForwardTemplateRequest,
  type PreviewForwardTemplateResponse,
  type SetForwardTemplateDefaultRequest,
} from "@civfix/shared"
import { buildReportPacket } from "./mail-format.js"
import type {
  AdminReportRecord,
  AdminReportRoutingRecord,
} from "./admin-report-types.js"
import type {
  ForwardTemplateRepository,
  ForwardTemplateSettingsRecord,
} from "./forward-template-types.js"

export interface ForwardTemplateServiceDeps {
  repo: ForwardTemplateRepository
}

export interface ForwardTemplateService {
  get(): Promise<ForwardTemplateSettingsDTO>
  set(
    input: SetForwardTemplateDefaultRequest,
    actorId: string | null,
  ): Promise<ForwardTemplateSettingsDTO>
  preview(input: PreviewForwardTemplateRequest): Promise<PreviewForwardTemplateResponse>
}

const SAMPLE_CREATED_AT = new Date("2026-06-06T12:00:00.000Z")

const EMPTY_SETTINGS: ForwardTemplateSettingsDTO = {
  subjectTemplate: null,
  bodyTemplate: null,
  updatedAt: null,
}

function normalize(template: string | null | undefined): string | null {
  if (typeof template !== "string") return null
  const trimmed = template.trim()
  return trimmed === "" ? null : trimmed
}

function toDTO(record: ForwardTemplateSettingsRecord | null): ForwardTemplateSettingsDTO {
  if (record === null) return EMPTY_SETTINGS
  return {
    subjectTemplate: record.subjectTemplate,
    bodyTemplate: record.bodyTemplate,
    updatedAt: record.updatedAt.toISOString(),
  }
}

function resolve(
  requested: string | null | undefined,
  stored: string | null | undefined,
): { template: string | null; source: ForwardTemplateSource } {
  const custom = normalize(requested)
  if (custom !== null) return { template: custom, source: "custom" }
  const fallback = normalize(stored)
  if (fallback !== null) return { template: fallback, source: "default" }
  return { template: null, source: "builtin" }
}

function sampleValue(name: string): string {
  return FORWARD_TEMPLATE_SAMPLE_VALUES[name] ?? ""
}

function sampleReport(): AdminReportRecord {
  return {
    id: sampleValue("reportId"),
    category: "trash",
    status: "published",
    flagged: false,
    title: sampleValue("title"),
    place: sampleValue("place"),
    reporter: null,
    confirmations: Number(sampleValue("confirmations")),
    address: sampleValue("address"),
    desc: sampleValue("description"),
    lat: Number(sampleValue("lat")),
    lng: Number(sampleValue("lng")),
    hasPhoto: true,
    previewMedia: null,
    createdAt: SAMPLE_CREATED_AT,
    referenceCode: sampleValue("referenceCode"),
    verificationVerdict: null,
    verifiedAt: null,
    reporterReportVerified: null,
  }
}

function sampleRouting(): AdminReportRoutingRecord {
  return {
    geoid: null,
    dept: "",
    place: sampleValue("jurisdictionName"),
    contact: null,
    routed: false,
  }
}

function samplePhotoLinks(): string[] {
  return sampleValue("photoLinks")
    .split("\n")
    .filter((url) => url.trim() !== "")
}

export function makeForwardTemplateService(
  deps: ForwardTemplateServiceDeps,
): ForwardTemplateService {
  return {
    async get(): Promise<ForwardTemplateSettingsDTO> {
      return toDTO(await deps.repo.get())
    },

    async set(
      input: SetForwardTemplateDefaultRequest,
      actorId: string | null,
    ): Promise<ForwardTemplateSettingsDTO> {
      const record = await deps.repo.set({
        subjectTemplate: normalize(input.subjectTemplate),
        bodyTemplate: normalize(input.bodyTemplate),
        actorId,
      })
      return toDTO(record)
    },

    async preview(input: PreviewForwardTemplateRequest): Promise<PreviewForwardTemplateResponse> {
      const needsStored =
        normalize(input.subjectTemplate) === null || normalize(input.bodyTemplate) === null
      const stored = needsStored ? await deps.repo.get() : null
      const subject = resolve(input.subjectTemplate, stored?.subjectTemplate)
      const body = resolve(input.bodyTemplate, stored?.bodyTemplate)
      const packet = buildReportPacket(
        sampleReport(),
        sampleRouting(),
        samplePhotoLinks(),
        sampleValue("operatorNote"),
        { subject: subject.template, body: body.template },
      )
      return {
        subject: packet.subject,
        text: packet.text,
        html: packet.html,
        subjectSource: subject.source,
        bodySource: body.source,
      }
    },
  }
}
