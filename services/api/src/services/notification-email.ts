import type { NotificationCategory } from "@civfix/contract"
import type { Mailer, OutboundEmail } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { Env } from "../env.js"
import { button, heading, paragraph, type EmailBlock } from "../adapters/email-blocks.js"
import { renderEmailBody, type EmailFooter } from "../adapters/email-layout.js"
import { mailFailure } from "../adapters/mail-failure.js"
import type {
  EmailThrottleRequest,
  NotificationEmailThrottle,
} from "../adapters/notification-email-throttle.js"
import { renderMessage } from "../i18n/renderMessage.js"
import { apiBaseUrlOf, webBaseUrlOf, type BaseUrlEnv } from "../lib/base-url.js"
import { mapWithLimit } from "../lib/concurrency.js"
import {
  mintNotificationEmailToken,
  notificationEmailExpiryFrom,
} from "./notification-email-token.js"
import type { EmailRecipientRecord, NotificationRepository } from "./notification-repository.js"

/** D10: emails in these categories name the conversation and never carry anyone's words. */
const CHAT_CATEGORIES: ReadonlySet<NotificationCategory> = new Set<NotificationCategory>([
  "mentions",
  "directMessages",
  "groupChats",
  "reportDiscussions",
])

const RECIPIENT_BATCH_SIZE = 500

const SEND_CONCURRENCY = 8

export interface NotificationEmailConfig {
  from: string
  webBaseUrl: string
  apiBaseUrl: string
  signingKey: string
}

export interface NotificationEmailDeps {
  mailer: Mailer
  throttle: NotificationEmailThrottle
  config: NotificationEmailConfig
}

export function notificationEmailConfigOf(
  env: Pick<Env, "MAIL_FROM_NOREPLY" | "UNSUBSCRIBE_SIGNING_KEY"> & BaseUrlEnv,
): NotificationEmailConfig {
  return {
    from: env.MAIL_FROM_NOREPLY,
    webBaseUrl: webBaseUrlOf(env),
    apiBaseUrl: apiBaseUrlOf(env),
    signingKey: env.UNSUBSCRIBE_SIGNING_KEY,
  }
}

export interface NotificationContent {
  title: string
  body: string | null
}

export interface NotificationEmail {
  category: NotificationCategory
  link: string | null
  conversationName: string | null
  /** The notification's title and body in a locale, rendered from the same keys as its row. */
  contentIn(locale: string): NotificationContent
  recipients: ReadonlyArray<{ userId: string; notificationId: string }>
}

export interface NotificationEmailer {
  send(email: NotificationEmail): Promise<void>
}

interface RenderArgs {
  locale: string
  category: NotificationCategory
  content: NotificationContent
  link: string | null
  conversationName: string | null
  token: string
  config: NotificationEmailConfig
}

type RenderedEmail = Pick<OutboundEmail, "subject" | "text" | "html" | "headers">

// Notification links are app paths. Anything else is not somewhere an email should send a reader.
function openUrl(webBaseUrl: string, link: string | null): string {
  return link !== null && link.startsWith("/")
    ? `${webBaseUrl}${link}`
    : `${webBaseUrl}/notifications`
}

function renderNotificationEmail(args: RenderArgs): RenderedEmail {
  const { locale, category, content, config } = args
  const token = encodeURIComponent(args.token)
  const chat = CHAT_CATEGORIES.has(category)
  const subject =
    chat && args.conversationName !== null
      ? renderMessage(locale, "email.notification.conversation_subject", {
          conversation: args.conversationName,
        })
      : content.title
  const blocks: EmailBlock[] = [heading(subject)]
  if (subject !== content.title) blocks.push(paragraph(content.title))
  if (!chat && content.body !== null && content.body.length > 0)
    blocks.push(paragraph(content.body))
  blocks.push(
    button(
      openUrl(config.webBaseUrl, args.link),
      renderMessage(locale, "email.notification.open_cta"),
    ),
  )
  const label = renderMessage(locale, `notification.category.${category}` as const)
  const footer: EmailFooter = {
    segments: [
      { text: renderMessage(locale, "email.notification.footer_reason", { category: label }) },
      { text: "\n" },
      {
        text: renderMessage(locale, "email.notification.footer_stop"),
        href: `${config.webBaseUrl}/unsubscribe/notifications/?t=${token}`,
      },
      { text: "\n" },
      {
        text: renderMessage(locale, "email.notification.footer_manage"),
        href: `${config.webBaseUrl}/notifications/prefs`,
      },
    ],
  }
  const { text, html } = renderEmailBody({ preheader: subject, blocks, footer })
  return {
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${config.apiBaseUrl}/v1/notifications/email-unsubscribe?t=${token}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  }
}

export interface NotificationEmailerDeps extends NotificationEmailDeps {
  repo: Pick<NotificationRepository, "findEmailRecipients">
  logger?: Pick<FastifyBaseLogger, "warn">
  now: () => Date
}

// Logs carry user and notification ids only: never an address, a title or a body, and never a mail
// error itself, whose SMTP response can quote the address.
export function makeNotificationEmailer(deps: NotificationEmailerDeps): NotificationEmailer {
  const { config } = deps

  async function deliver(
    email: NotificationEmail,
    recipient: EmailRecipientRecord,
    claim: EmailThrottleRequest,
    notificationId: string,
  ): Promise<void> {
    const token = mintNotificationEmailToken(
      {
        userId: recipient.userId,
        category: email.category,
        expiresAtMs: notificationEmailExpiryFrom(deps.now().getTime()),
      },
      config.signingKey,
    )
    const rendered = renderNotificationEmail({
      locale: recipient.locale,
      category: email.category,
      content: email.contentIn(recipient.locale),
      link: email.link,
      conversationName: email.conversationName,
      token,
      config,
    })
    try {
      await deps.mailer.sendOutbound({ from: config.from, to: recipient.email, ...rendered })
    } catch (err) {
      deps.logger?.warn(
        { userId: recipient.userId, notificationId, failureKind: mailFailure(err).kind },
        "notification email send failed",
      )
      await deps.throttle.release([claim]).catch((releaseErr: unknown) => {
        deps.logger?.warn(
          { err: releaseErr, userId: recipient.userId },
          "notification email throttle give-back failed; this email still counts toward the limits",
        )
      })
    }
  }

  async function sendBatch(
    email: NotificationEmail,
    batch: NotificationEmail["recipients"],
  ): Promise<void> {
    let found: EmailRecipientRecord[]
    try {
      found = await deps.repo.findEmailRecipients(batch.map((r) => r.userId))
    } catch (err) {
      deps.logger?.warn(
        { err, category: email.category, count: batch.length },
        "notification email recipient lookup failed; these emails are skipped",
      )
      return
    }
    if (found.length === 0) return
    // Keyed by link, not by name: two report chats can share a name.
    const conversation = CHAT_CATEGORIES.has(email.category) ? email.link : null
    const claims = found.map((recipient) => ({
      recipient,
      claim: { userId: recipient.userId, conversation },
    }))
    let granted: boolean[]
    try {
      granted = await deps.throttle.claim(claims.map((c) => c.claim))
    } catch (err) {
      deps.logger?.warn(
        { err, category: email.category, count: found.length },
        "notification email throttle unavailable; these emails are skipped",
      )
      return
    }
    const notificationIds = new Map(batch.map((r) => [r.userId, r.notificationId]))
    const sendable = claims.filter((_, i) => granted[i] === true)
    await mapWithLimit(sendable, SEND_CONCURRENCY, ({ recipient, claim }) =>
      deliver(email, recipient, claim, notificationIds.get(recipient.userId) ?? ""),
    )
  }

  return {
    async send(email: NotificationEmail): Promise<void> {
      for (let i = 0; i < email.recipients.length; i += RECIPIENT_BATCH_SIZE) {
        await sendBatch(email, email.recipients.slice(i, i + RECIPIENT_BATCH_SIZE))
      }
    },
  }
}
