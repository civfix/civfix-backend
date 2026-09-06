import { AppError, MAX_BROADCAST_BODY } from "@civfix/shared"
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
    blocks.push(button(ctaUrl, ctaLabel.length > 0 ? ctaLabel : "Open"))
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
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(scheduledAt)
  } catch {
    return scheduledAt.toISOString()
  }
}

export function eventPath(pageSlug: string | null, cleanupId: string): string {
  return pageSlug !== null && pageSlug.length > 0
    ? `/e/${encodeURIComponent(pageSlug)}`
    : `/cleanups/${cleanupId}`
}

export function eventManageUrl(
  webBaseUrl: string,
  pageSlug: string | null,
  cleanupId: string,
): string {
  return `${webBaseUrl}${eventPath(pageSlug, cleanupId)}`
}

export const BROADCAST_LINK_FIELD = "bodyMd"

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

function linkOptions(
  allowedHosts: readonly string[] | undefined,
): { allowedHosts?: readonly string[] } {
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
      return "links must start with https://"
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
