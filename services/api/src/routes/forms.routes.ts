import { createHash } from "node:crypto"
import { AppError } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { perHost } from "../plugins/rate-limit.js"
import type { Container } from "../di.js"
import { honeypotTripped } from "../abuse/honeypot.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import type { CounterStore } from "../abuse/counter-store.js"
import { heading, kvTable, paragraph } from "../adapters/email-blocks.js"
import { renderEmailBody } from "../adapters/email-layout.js"
import { sanitizeHeaderValue } from "../adapters/mail-text.js"
import { parse } from "./_validate.js"
import { exposeMessage } from "../errors/exposed-message.js"

export const HOME_TURF_RATE_LIMIT = perHost({ max: 5, timeWindow: "1 minute" })

export const HOME_TURF_BODY_LIMIT = 16384

export const HOME_TURF_IP_LIMIT_PER_HOUR = 10

export const HOME_TURF_IP_WINDOW_SECONDS = 60 * 60

const HOME_TURF_IP_COUNTER_PREFIX = "abuse:home-turf:ip:"

const HOME_TURF_EMAIL_COUNTER_PREFIX = "abuse:home-turf:email:"

export const HOME_TURF_EMAIL_LIMIT_PER_DAY = 1

export const HOME_TURF_EMAIL_WINDOW_SECONDS = 24 * 60 * 60

export interface HomeTurfOverrides {
  counters?: CounterStore
}

declare module "fastify" {
  interface FastifyInstance {
    homeTurfOverrides?: HomeTurfOverrides
  }
}

const HomeTurfFormSchema = z
  .object({
    coachName: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(60),
    school: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(120),
    teamSize: z.string().trim().min(1).max(30),
    email: z.string().trim().max(254).email(),
    phone: z.string().trim().min(1).max(40),
    notes: z.string().trim().max(2000).optional(),
    turnstileToken: z.string().min(1).max(4096),
    honeypot: z.string().max(4096).optional(),
  })
  .strict()

export type HomeTurfForm = z.infer<typeof HomeTurfFormSchema>

export async function enforceHomeTurfIpCap(
  ip: string | undefined | null,
  counters: CounterStore,
): Promise<void> {
  const key = HOME_TURF_IP_COUNTER_PREFIX + normalizeIp(ip)
  const count = await counters.incr(key, HOME_TURF_IP_WINDOW_SECONDS)
  if (count > HOME_TURF_IP_LIMIT_PER_HOUR) {
    throw AppError.rateLimited("Too many submissions from this network. Try again later.")
  }
}

export function canonicalizeHomeTurfEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0 || at === trimmed.length - 1) return trimmed
  let local = trimmed.slice(0, at)
  let domain = trimmed.slice(at + 1)
  const plus = local.indexOf("+")
  if (plus !== -1) local = local.slice(0, plus)
  if (domain === "googlemail.com") domain = "gmail.com"
  if (domain === "gmail.com") local = local.replace(/\./g, "")
  return `${local}@${domain}`
}

// The cap protects the address in the form from being mail-bombed with confirmations. It runs after the
// staff notification went out, so exceeding it drops only the confirmation: failing the request would tell
// the coach their sign-up failed when staff already have it.
export async function claimHomeTurfConfirmation(
  email: string,
  counters: CounterStore,
): Promise<boolean> {
  const canonical = canonicalizeHomeTurfEmail(email)
  const digest = createHash("sha256").update(canonical).digest("hex")
  const key = HOME_TURF_EMAIL_COUNTER_PREFIX + digest
  const count = await counters.incr(key, HOME_TURF_EMAIL_WINDOW_SECONDS)
  return count <= HOME_TURF_EMAIL_LIMIT_PER_DAY
}

export async function registerHomeTurfRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  function counters(): CounterStore | null {
    const injected = app.homeTurfOverrides?.counters
    if (injected) return injected
    if (!container.env.REDIS_URL) return null
    return container.getCounterStore()
  }

  function requireCounters(): CounterStore {
    const store = counters()
    if (store === null) {
      app.log.error("home-turf form: no counter store (REDIS_URL unset), refusing to send")
      throw exposeMessage(
        AppError.internal("This form is temporarily unavailable. Please try again later."),
      )
    }
    return store
  }

  if (container.env.HOME_TURF_NOTIFY_TO === "") {
    app.log.warn(
      "home-turf form: HOME_TURF_NOTIFY_TO is unset; POST /forms/home-turf is disabled and will accept no submissions",
    )
  }

  function requireNotifyTo(): string {
    const notifyTo = container.env.HOME_TURF_NOTIFY_TO
    if (notifyTo === "") {
      throw AppError.conflict(
        "This form isn't accepting submissions right now. Please try again later.",
      )
    }
    return notifyTo
  }

  app.post(
    "/forms/home-turf",
    { bodyLimit: HOME_TURF_BODY_LIMIT, config: { rateLimit: HOME_TURF_RATE_LIMIT } },
    async (request, reply) => {
      const form = parse(HomeTurfFormSchema, request.body)

      const human = await container.abuseChecks.verifyTurnstile(
        form.turnstileToken,
        request.ip ?? "",
        {
          action: "home-turf",
        },
      )
      if (!human) {
        throw AppError.turnstileFailed()
      }

      if (honeypotTripped(form.honeypot)) {
        request.log.info(
          { ip: request.ip },
          "home-turf form: honeypot tripped; fake success, no mail",
        )
        return reply.status(200).send({ ok: true })
      }

      const notifyTo = requireNotifyTo()
      const store = requireCounters()
      await enforceHomeTurfIpCap(request.ip, store)

      const from = container.env.HOME_TURF_MAIL_FROM
      const notification = buildNotificationEmail(form, from, notifyTo)
      await container.mailer.sendOutbound(notification)

      if (!(await claimHomeTurfConfirmation(form.email, store))) {
        request.log.info(
          "home-turf form: recipient confirmation cap reached; staff notified, confirmation skipped",
        )
        return reply.status(200).send({ ok: true })
      }

      try {
        await container.mailer.sendOutbound(buildConfirmationEmail(form, from, notifyTo))
      } catch (err) {
        request.log.warn(
          { err },
          "home-turf form: confirmation email failed (non-fatal; returning 200)",
        )
      }

      return reply.status(200).send({ ok: true })
    },
  )
}

export interface FormOutboundEmail {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html?: string
}

function formRows(form: HomeTurfForm): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Coach name", form.coachName],
    ["Role", form.role],
    ["School", form.school],
    ["City", form.city],
    ["Team size", form.teamSize],
    ["Email", form.email],
    ["Phone", form.phone],
  ]
  if (form.notes !== undefined && form.notes !== "") {
    rows.push(["Notes", form.notes])
  }
  return rows
}

export function buildNotificationEmail(
  form: HomeTurfForm,
  from: string,
  to: string,
): FormOutboundEmail {
  const subject = sanitizeHeaderValue(`Home Turf sign-up: ${form.school}`)
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks: [heading("New Home Turf team sign-up"), kvTable(formRows(form))],
  })
  return { from, to, replyTo: form.email, subject, text, html }
}

export function buildConfirmationEmail(
  form: HomeTurfForm,
  from: string,
  notifyTo: string,
): FormOutboundEmail {
  const subject = "We got your Home Turf sign-up"
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks: [
      paragraph("Thanks — we received your Home Turf sign-up."),
      paragraph(
        "The civfix event coordination team will call you soon to find a date that works for your season.",
      ),
      paragraph(
        `If you did not fill out this form, you can ignore this message; nothing was created. Questions or corrections: email ${notifyTo}.`,
        { muted: true },
      ),
      paragraph("The civfix team"),
    ],
  })
  return { from, to: form.email, subject, text, html }
}
