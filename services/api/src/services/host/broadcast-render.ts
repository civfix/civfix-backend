import { ANNOUNCEMENT_BROADCAST_KIND, AppError, MAX_BROADCAST_BODY } from "@civfix/shared"
import {
  BroadcastLinkError,
  assertSafeBroadcastLinks,
  inAppBodyFrom,
  inspectBroadcastLinks,
  pushBodyFrom,
  pushTitleFrom,
  renderBroadcastVars,
  smsBodyFrom,
  type BroadcastLinkIssue,
  type BroadcastVarValues,
} from "@civfix/shared/host"
import { markdownToPlainText, parseMarkdownSubset } from "@civfix/shared/markdown"
import { button, richList, richParagraph, type EmailBlock } from "../../adapters/email-blocks.js"
import { eventFooter, renderEmailBody } from "../../adapters/email-layout.js"
import type { BroadcastRecord, EventBroadcastContext } from "./broadcast-types.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"

const DEFAULT_CTA_LABEL = "Open"
const DEFAULT_EVENT_WHERE = "the meeting point"
const EVENT_WHEN_LOCALE = "en-US"
const BROADCAST_LINK_FIELD = "bodyMd"
const PER_RECIPIENT_VARS = ["first_name", "ticket_type"] as const

export interface BroadcastContent {
  subject: string
  bodyMd: string
  ctaLabel?: string | null
  ctaUrl?: string | null
}

export interface BroadcastRenderContext {
  eventTitle: string
  vars: BroadcastVarValues
  unsubscribeUrl?: string
  manageUrl?: string
  replyTo?: string | null
  critical?: boolean
  allowedLinkHosts?: readonly string[]
}

export interface RenderedBroadcast {
  subject: string
  html: string
  text: string
  pushTitle: string
  pushBody: string
  inAppTitle: string
  inAppBody: string
  smsBody: string
}

export function renderBroadcast(
  content: BroadcastContent,
  ctx: BroadcastRenderContext,
): RenderedBroadcast {
  const subject = renderBroadcastVars(content.subject, ctx.vars).trim()
  const body = renderBroadcastVars(content.bodyMd, ctx.vars)
  const ctaLabel = content.ctaLabel ? renderBroadcastVars(content.ctaLabel, ctx.vars).trim() : ""
  const ctaUrl = content.ctaUrl ?? ""

  const nodes = parseMarkdownSubset(body, { maxChars: MAX_BROADCAST_BODY })
  const blocks: EmailBlock[] = nodes.map((node) =>
    node.type === "list" ? richList(node) : richParagraph(node.children),
  )
  if (ctaUrl.length > 0) {
    blocks.push(button(ctaUrl, ctaLabel.length > 0 ? ctaLabel : DEFAULT_CTA_LABEL))
  }

  const footerOpts = {
    eventTitle: ctx.eventTitle,
    ...(ctx.unsubscribeUrl !== undefined ? { unsubscribeUrl: ctx.unsubscribeUrl } : {}),
    ...(ctx.manageUrl !== undefined ? { manageUrl: ctx.manageUrl } : {}),
    ...(ctx.replyTo !== undefined ? { replyTo: ctx.replyTo } : {}),
    ...(ctx.critical !== undefined ? { critical: ctx.critical } : {}),
  }
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks,
    footer: eventFooter(footerOpts),
  })

  const plain = markdownToPlainText(nodes)
  return {
    subject,
    html,
    text,
    pushTitle: pushTitleFrom(subject),
    pushBody: pushBodyFrom(plain),
    inAppTitle: pushTitleFrom(subject),
    inAppBody: inAppBodyFrom(plain),
    smsBody: smsBodyFrom(`${subject} ${plain}`),
  }
}

export function formatEventWhen(scheduledAt: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat(EVENT_WHEN_LOCALE, {
      timeZone: timezone ?? DEFAULT_EVENT_TIME_ZONE,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(scheduledAt)
  } catch {
    // A stored zone Intl does not know must not block a send; the instant is still unambiguous.
    return scheduledAt.toISOString()
  }
}

function eventPath(pageSlug: string | null, cleanupId: string): string {
  return pageSlug !== null && pageSlug.length > 0
    ? `/e/${encodeURIComponent(pageSlug)}`
    : `/cleanups/${cleanupId}`
}

function eventManageUrl(webBaseUrl: string, pageSlug: string | null, cleanupId: string): string {
  return `${webBaseUrl}${eventPath(pageSlug, cleanupId)}`
}

export function announcementPath(cleanupId: string, announcementId: string): string {
  return `/cleanups/${cleanupId}/announcements/${announcementId}`
}

export function notificationLink(
  record: Pick<BroadcastRecord, "id" | "kind" | "cleanupId">,
  event: Pick<EventBroadcastContext, "pageSlug">,
): string {
  return record.kind === ANNOUNCEMENT_BROADCAST_KIND
    ? announcementPath(record.cleanupId, record.id)
    : eventPath(event.pageSlug, record.cleanupId)
}

export function eventTemplateVars(
  event: EventBroadcastContext,
  webBaseUrl: string,
): BroadcastVarValues {
  return {
    event_title: event.title,
    event_when: formatEventWhen(event.scheduledAt, event.timezone),
    event_where: event.address ?? DEFAULT_EVENT_WHERE,
    manage_link: eventManageUrl(webBaseUrl, event.pageSlug, event.cleanupId),
  }
}

export function broadcastContentOf(
  record: Pick<BroadcastRecord, "subject" | "bodyMd" | "ctaLabel" | "ctaUrl">,
): BroadcastContent {
  return {
    subject: record.subject ?? "",
    bodyMd: record.bodyMd ?? "",
    ctaLabel: record.ctaLabel,
    ctaUrl: record.ctaUrl,
  }
}

export function templateTextOf(
  record: Pick<BroadcastRecord, "subject" | "bodyMd" | "ctaLabel">,
): string {
  return `${record.subject ?? ""} ${record.bodyMd ?? ""} ${record.ctaLabel ?? ""}`
}

export function usesVar(text: string, name: string): boolean {
  return text.includes(`{${name}}`)
}

export function usesPerRecipientVar(text: string): boolean {
  return PER_RECIPIENT_VARS.some((name) => usesVar(text, name))
}

export function verifiedReplyTo(
  event: Pick<EventBroadcastContext, "replyTo" | "replyToVerified">,
): string | null {
  return event.replyToVerified ? event.replyTo : null
}

export function assertBroadcastLinkPolicy(
  text: string,
  allowedHosts: readonly string[] | undefined,
): void {
  try {
    assertSafeBroadcastLinks(text, linkOptions(allowedHosts))
  } catch (err) {
    if (err instanceof BroadcastLinkError) {
      throw AppError.validation(
        { [BROADCAST_LINK_FIELD]: linkIssueMessage(err.issues) },
        "That message has a link we can't send.",
      )
    }
    throw err
  }
}

export function broadcastLinkWarnings(
  text: string,
  allowedHosts: readonly string[] | undefined,
): string[] {
  return inspectBroadcastLinks(text, linkOptions(allowedHosts)).map((issue) => issueCopy(issue))
}

function linkOptions(allowedHosts: readonly string[] | undefined): {
  allowedHosts?: readonly string[]
} {
  return allowedHosts !== undefined && allowedHosts.length > 0 ? { allowedHosts } : {}
}

function linkIssueMessage(issues: readonly BroadcastLinkIssue[]): string {
  const first = issues[0]
  return first === undefined ? "contains an unsupported link" : issueCopy(first)
}

function issueCopy(issue: BroadcastLinkIssue): string {
  switch (issue.kind) {
    case "too_many":
      return `too many links (${issue.count}; the limit is ${issue.max})`
    case "insecure_scheme":
    case "scheme_relative":
      return "links must start with https://"
    case "userinfo":
      return "links must not contain a username or password"
    case "ip_literal":
      return "links must use a domain name, not an IP address"
    case "punycode":
    case "non_ascii_host":
      return "links must use a plain ASCII domain name"
    case "host_not_allowed":
      return "that link's domain is not allowed in event messages"
  }
}
