/**
 * Public form-submission routes (raw Fastify, OUTSIDE the @civfix/shared contract — like the
 * inbound-mail webhook, the static marketing pages POST here directly).
 *
 *   POST /forms/home-turf   [public]   the "Home Turf Initiative" coach-interest form from
 *                                      civfix.org/home-turf. Verifies a Cloudflare Turnstile token,
 *                                      applies abuse protections, then sends two emails via the
 *                                      container mailer:
 *                                        1. a notification with the form contents to
 *                                           HOME_TURF_NOTIFY_TO (replyTo = the submitter, so the
 *                                           coordinator can reply directly), and
 *                                        2. a receipt-style confirmation to the submitter (fixed copy
 *                                           around the same escaped field table the coordinator gets).
 *
 * ABUSE ORDERING (mirrors services/anon-service.ts submitAnonReport): Turnstile FIRST (the human gate
 * is cheap and spends no other budget) → honeypot (a filled hidden field is a bot; respond with the
 * SAME 200 {ok:true} a real submit gets so the bot learns nothing, and send NO mail) → per-IP hourly
 * cap. The per-IP counter needs a CounterStore: production wires RedisCounterStore lazily off the
 * container (REDIS_URL is [BOOT] in prod), while a no-infra boot (empty REDIS_URL, no override) simply
 * skips the hourly cap and relies on the per-route 5/min + global rate limits — this route must work
 * whenever the mailer + abuseChecks are in the container, with NO DB/Redis auth bundle required.
 *
 * MAIL FAILURE CONTRACT: the notification send is awaited — a failure surfaces the mailer's standard
 * AppError (5xx envelope) so the submitter can retry. The confirmation is best-effort: a failure only
 * logs a warning and the request still returns 200 (the sign-up itself was delivered).
 */

import { AppError } from "@civfix/shared"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { Container } from "../di.js"
import { honeypotTripped } from "../abuse/honeypot.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import { RedisCounterStore, type CounterStore } from "../abuse/counter-store.js"
import { heading, kvTable, paragraph } from "../adapters/email-blocks.js"
import { renderEmailBody } from "../adapters/email-layout.js"
import { sanitizeHeaderValue } from "../adapters/mail-text.js"
import { parse } from "./_validate.js"

/**
 * Per-route limit: the route is public + unauthenticated and every accepted submit drives two SMTP
 * sends, so cap it well under the global 300/min. A legitimate coach submits once.
 */
export const HOME_TURF_RATE_LIMIT = { max: 5, timeWindow: "1 minute" } as const

/** The form is a handful of short strings + a Turnstile token; cap the body far below the global 256 KB. */
export const HOME_TURF_BODY_LIMIT = 16384

/** Hard per-IP accepted-submissions-per-hour cap (a DEDICATED bucket — see the counter prefix below). */
export const HOME_TURF_IP_LIMIT_PER_HOUR = 10

/** Window length for the per-IP counter: one hour, in seconds. */
export const HOME_TURF_IP_WINDOW_SECONDS = 60 * 60

/**
 * Redis key prefix for the per-IP hourly counter. DELIBERATELY distinct from the anon-report
 * "abuse:ip:" bucket so a form submit never burns a resident's anonymous-report budget (or vice versa).
 */
const HOME_TURF_IP_COUNTER_PREFIX = "abuse:home-turf:ip:"

/**
 * Per-RECIPIENT cap (M8). The per-IP cap does not protect the victim of the amplification: the attacker
 * chooses the recipient, so rotating source IPs (or a botnet) delivers unlimited civfix-DKIM-signed mail
 * to one address. This bucket is keyed on the submitted EMAIL, independent of source IP, so a given
 * address can receive at most one confirmation per window no matter who submits or from where.
 */
const HOME_TURF_EMAIL_COUNTER_PREFIX = "abuse:home-turf:email:"

/** One confirmation per recipient address per day. */
export const HOME_TURF_EMAIL_LIMIT_PER_DAY = 1

/** Window length for the per-recipient counter: one day, in seconds. */
export const HOME_TURF_EMAIL_WINDOW_SECONDS = 24 * 60 * 60

/**
 * Optional injected seams (tests): an in-memory CounterStore so the per-IP hourly cap runs offline.
 * Left unset in production, where the route builds a RedisCounterStore lazily from the container.
 */
export interface HomeTurfOverrides {
  counters?: CounterStore
}

declare module "fastify" {
  interface FastifyInstance {
    /** Injected Home Turf form overrides (tests). See HomeTurfOverrides. */
    homeTurfOverrides?: HomeTurfOverrides
  }
}

/**
 * The Home Turf coach-interest form body. `.strict()` so an unknown key is rejected with the standard
 * VALIDATION envelope (repo convention — see the colocated schemas in anon.routes.ts); every string is
 * trimmed BEFORE the length checks so padded input neither passes a min nor fails a max spuriously.
 */
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
    // NOT trimmed here: honeypotTripped applies its own trim, and a bot-filled value must survive
    // validation (the honeypot response is a fake success, not a validation error).
    honeypot: z.string().max(4096).optional(),
  })
  .strict()

export type HomeTurfForm = z.infer<typeof HomeTurfFormSchema>

/**
 * Enforce the per-IP hourly cap for the Home Turf form. Same semantics as abuse/ip-rate-limit.ts
 * enforceIpRateLimit (increment the hour-anchored counter, throw 429 once the count EXCEEDS the cap)
 * but against the form's OWN counter bucket. Exported for direct unit testing.
 */
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

/**
 * Enforce the per-RECIPIENT daily cap (M8). Keyed on the normalized submitted address, NOT the source
 * IP, so it is the control that actually bounds how much mail one victim can be made to receive. The
 * error is deliberately the same generic 429 the IP cap throws — a distinct message would tell an
 * attacker which addresses have already been targeted. Exported for direct unit testing.
 */
export async function enforceHomeTurfRecipientCap(
  email: string,
  counters: CounterStore,
): Promise<void> {
  const key = HOME_TURF_EMAIL_COUNTER_PREFIX + email.trim().toLowerCase()
  const count = await counters.incr(key, HOME_TURF_EMAIL_WINDOW_SECONDS)
  if (count > HOME_TURF_EMAIL_LIMIT_PER_DAY) {
    throw AppError.rateLimited("Too many submissions from this network. Try again later.")
  }
}

export async function registerHomeTurfRoutes(
  app: FastifyInstance,
  container: Container,
): Promise<void> {
  // Lazy per-IP counter store: an injected override (tests) wins; otherwise Redis when configured
  // (production — REDIS_URL is [BOOT] there); otherwise null (no-infra boot: skip the hourly cap and
  // rely on the per-route + global rate limits).
  let redisCounters: CounterStore | undefined
  function counters(): CounterStore | null {
    const injected = app.homeTurfOverrides?.counters
    if (injected) return injected
    if (!container.env.REDIS_URL) return null
    if (!redisCounters) redisCounters = new RedisCounterStore(container.getRedis())
    return redisCounters
  }

  /**
   * M8: the abuse caps now FAIL CLOSED. The old behaviour silently SKIPPED both caps whenever no counter
   * store was available (empty REDIS_URL and no injected override), leaving a public endpoint that sends
   * DKIM-signed mail to an attacker-chosen recipient protected by nothing but a per-IP request limiter.
   * A cap that vanishes on misconfiguration is not a cap. If we cannot count, we do not send.
   */
  function requireCounters(): CounterStore {
    const store = counters()
    if (store === null) {
      app.log.error("home-turf form: no counter store (REDIS_URL unset) — refusing to send")
      throw AppError.internal("This form is temporarily unavailable. Please try again later.")
    }
    return store
  }

  app.post(
    "/forms/home-turf",
    { bodyLimit: HOME_TURF_BODY_LIMIT, config: { rateLimit: HOME_TURF_RATE_LIMIT } },
    async (request, reply) => {
      const form = parse(HomeTurfFormSchema, request.body)

      // (1) Turnstile FIRST: clear the human challenge before spending any other budget (counters,
      // SMTP). A failed challenge is a 403 TURNSTILE_FAILED, exactly like the anon-report path.
      const human = await container.abuseChecks.verifyTurnstile(form.turnstileToken, request.ip ?? "")
      if (!human) {
        throw AppError.turnstileFailed()
      }

      // (2) Honeypot: a non-empty hidden field is a bot. Respond with the SAME success body a real
      // submit gets (no signal to the bot that it was caught) and send NOTHING.
      if (honeypotTripped(form.honeypot)) {
        request.log.info({ ip: request.ip }, "home-turf form: honeypot tripped; fake success, no mail")
        return reply.status(200).send({ ok: true })
      }

      // (3) Abuse caps — both FAIL CLOSED (see requireCounters). Per-IP hourly bounds one source's
      // submission rate; per-recipient daily bounds how much mail any single victim can be made to
      // receive, which is the control that actually addresses the amplification (M8).
      const store = requireCounters()
      await enforceHomeTurfIpCap(request.ip, store)
      await enforceHomeTurfRecipientCap(form.email, store)

      // (4) Notification to the coordinator — awaited: a failure here is the repo's standard mailer
      // 5xx and the submit fails loudly (nothing worse than a silently-dropped sign-up).
      const from = container.env.HOME_TURF_MAIL_FROM
      const notification = buildNotificationEmail(form, from, container.env.HOME_TURF_NOTIFY_TO)
      await container.mailer.sendOutbound(notification)

      // (5) Confirmation to the submitter — best-effort: the sign-up already reached the coordinator,
      // so a confirmation failure only logs a warning and the request still succeeds.
      try {
        await container.mailer.sendOutbound(
          buildConfirmationEmail(form, from, container.env.HOME_TURF_NOTIFY_TO),
        )
      } catch (err) {
        request.log.warn({ err }, "home-turf form: confirmation email failed (non-fatal; returning 200)")
      }

      return reply.status(200).send({ ok: true })
    },
  )
}

/** An OutboundEmail-shaped envelope (structural; matches @civfix/shared Mailer.sendOutbound). */
interface FormOutboundEmail {
  from: string
  to: string
  replyTo?: string
  subject: string
  text: string
  html?: string
}

/** The submitted form as key/value rows — the receipt body shared by BOTH emails. */
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

/**
 * The coordinator notification: every form field in a key/value table. kvTable/paragraph HTML-escape
 * every user value; the subject is header-sanitized here (defense in depth — the OCI adapter sanitizes
 * again at send). replyTo is the submitter so the coordinator can reply directly; the address passed
 * zod's .email() so it cannot smuggle CRLF into the header.
 */
function buildNotificationEmail(form: HomeTurfForm, from: string, to: string): FormOutboundEmail {
  const subject = sanitizeHeaderValue(`Home Turf sign-up: ${form.school}`)
  const { text, html } = renderEmailBody({
    preheader: subject,
    blocks: [heading("New Home Turf team sign-up"), kvTable(formRows(form))],
  })
  return { from, to, replyTo: form.email, subject, text, html }
}

/**
 * The submitter confirmation: FIXED COPY ONLY (M8).
 *
 * It used to echo the whole submitted form back — coachName, school, and up to 2000 characters of free
 * text — to an address taken from the same request body. HTML-escaping made the echo inert as *markup*,
 * but the text itself was still attacker-authored, delivered from civfix's own DKIM-signed domain, so it
 * cleared SPF/DMARC and landed in the victim's inbox looking like legitimate civfix mail. That is a
 * phishing amplifier regardless of escaping: the payload was never the HTML, it was the prose.
 *
 * Nothing from the request body is interpolated here. The recipient address is still request-derived
 * (that is inherent to a confirmation), which is why the per-recipient cap above exists. The coordinator
 * notification still carries the full field table — that goes to a FIXED internal address.
 */
function buildConfirmationEmail(form: HomeTurfForm, from: string, notifyTo: string): FormOutboundEmail {
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
