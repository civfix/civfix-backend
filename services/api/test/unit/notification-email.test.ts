// GH#225 / D10: a notification is emailed when its category is on with Email checked and the recipient
// has a verified, unsuppressed address. Chat categories never carry anyone's words, get one email per
// conversation per hour, and every person gets at most 20 notification emails an hour. Email goes out
// after the row and the push, and its failure never fails the notification.

import { describe, expect, it, vi } from "vitest"
import { FakeMailer, FakePushSender } from "@civfix/seams"
import type { OutboundEmail } from "@civfix/seams"
import type { NotificationCategory } from "@civfix/contract"
import { loadEnv } from "../../src/env.js"
import { escapeHtml } from "../../src/adapters/mail-text.js"
import { renderMessage } from "../../src/i18n/renderMessage.js"
import type { MessageKey } from "../../src/i18n/renderMessage.js"
import {
  DEFAULT_PREFS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  makeNotificationService,
  type CreateNotificationInput,
} from "../../src/services/notification-service.js"
import { notificationEmailConfigOf } from "../../src/services/notification-email.js"
import { verifyNotificationEmailToken } from "../../src/services/notification-email-token.js"
import { emailHashOf } from "../../src/services/host/broadcast-service.js"
import { webBaseUrlOf, apiBaseUrlOf } from "../../src/lib/base-url.js"
import {
  InMemoryNotificationEmailThrottle,
  type EmailThrottleRequest,
} from "../../src/adapters/notification-email-throttle.js"
import type { PersonView } from "../../src/services/social-repository.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
  flushNotificationDispatch,
} from "../helpers/notifications.js"

const env = loadEnv({
  NODE_ENV: "test",
  WEB_ORIGINS: "https://web.civfix.test",
  PUBLIC_API_URL: "https://api.civfix.test",
})
const WEB = webBaseUrlOf(env)
const API = apiBaseUrlOf(env)
const NOREPLY = env.MAIL_FROM_NOREPLY
const KEY = env.UNSUBSCRIBE_SIGNING_KEY

const NOW = Date.parse("2026-10-24T12:00:00Z")
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

const U = "aaaaaaaa-0000-4000-8000-000000000001"
const V = "bbbbbbbb-0000-4000-8000-000000000002"
const A = "cccccccc-0000-4000-8000-000000000003"
const P = "dddddddd-0000-4000-8000-000000000004"
const ADDRESS = "u@example.test"

const CHAT_CATEGORIES: readonly NotificationCategory[] = [
  "mentions",
  "directMessages",
  "groupChats",
  "reportDiscussions",
]

type Setting = [enabled: boolean, push: boolean, email: boolean]

function user(i: number): string {
  return `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`
}

function users(n: number): string[] {
  return Array.from({ length: n }, (_, i) => user(i))
}

function person(id: string, displayName: string): PersonView {
  return {
    id,
    displayName,
    handle: null,
    bio: null,
    followers: 0,
    following: 0,
    avatarUrl: null,
    avatarMedia: null,
    socialLinks: null,
    donationUrl: null,
    showVolunteerHours: null,
  }
}

/** Captures warn/error calls with errors expanded, so a test can prove an address never reached a log. */
function recordingLogger() {
  const warns: unknown[][] = []
  const errors: unknown[][] = []
  const logger = {
    warn: vi.fn((...args: unknown[]) => void warns.push(args)),
    error: vi.fn((...args: unknown[]) => void errors.push(args)),
  }
  const serialized = (calls: unknown[][]) =>
    JSON.stringify(calls, (_k, v: unknown) =>
      v instanceof Error ? { message: v.message, stack: v.stack } : v,
    )
  return { logger, warns, errors, serialized }
}

function harness() {
  let clock = NOW
  const repo = new InMemoryNotificationRepository()
  repo.now = () => new Date(clock)
  const settings = new InMemoryNotificationSettingsRepository()
  settings.now = () => new Date(clock)
  const push = new FakePushSender()
  const mailer = new FakeMailer()
  const throttle = new InMemoryNotificationEmailThrottle(() => clock)
  const log = recordingLogger()
  const service = makeNotificationService({
    repo,
    settingsRepo: settings,
    pushSender: push,
    logger: log.logger,
    now: () => new Date(clock),
    email: { mailer, throttle, config: notificationEmailConfigOf(env) },
  })

  function account(userId: string, email: string | null = ADDRESS): void {
    repo.accounts.set(userId, { email, emailVerified: true, deletedAt: null })
  }
  account(U)

  async function set(userId: string, category: NotificationCategory, s: Setting): Promise<void> {
    const [enabled, pushOn, email] = s
    await settings.upsertSettings(userId, { [category]: { enabled, push: pushOn, email } })
  }

  const emails = (): OutboundEmail[] =>
    mailer.sent.flatMap((m) => (m.outbound !== undefined ? [m.outbound] : []))
  const rows = (userId?: string) =>
    repo.notifications.filter((n) => userId === undefined || n.userId === userId)

  return {
    repo,
    settings,
    push,
    mailer,
    throttle,
    log,
    service,
    account,
    set,
    emails,
    rows,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flushNotificationDispatch()
}

function tokenOf(email: OutboundEmail): string {
  const header = email.headers?.["List-Unsubscribe"] ?? ""
  const match = /\?t=([^>]+)>$/.exec(header)
  expect(match, header).not.toBeNull()
  return decodeURIComponent(match![1]!)
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"))
}

function report(i: number, overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput {
  return {
    type: "report_update",
    title: `Report ${i} updated`,
    body: "Status changed to Fixed",
    link: `/reports/r${i}`,
    ...overrides,
  }
}

function dm(conversation: string, overrides: Partial<CreateNotificationInput> = {}) {
  return {
    type: "dm",
    title: "Alex",
    body: "hey there",
    link: `/messages/dm/${conversation}`,
    conversationName: "Alex",
    ...overrides,
  } satisfies CreateNotificationInput
}

describe("notification emails: when one goes out", () => {
  it("T1: a New followers email from the no-reply sender carries the row's title, body and an Open button", async () => {
    const h = harness()
    await h.set(U, "followers", [true, false, true])

    await h.service.onNewFollower({ followeeId: U, follower: person(A, "Alex") })
    await settle()

    expect(h.rows(U)).toHaveLength(1)
    const row = h.rows(U)[0]!
    expect(h.emails()).toHaveLength(1)
    const email = h.emails()[0]!
    expect(email.from).toBe(NOREPLY)
    expect(email.to).toBe(ADDRESS)
    expect(email.subject).toBe(row.title)
    const open = `${WEB}/people/${A}`
    expect(email.text).toContain(row.title)
    expect(email.text).toContain(row.body!)
    expect(email.text).toContain(`Open in civfix: ${open}`)
    expect(email.html).toContain(escapeHtml(row.title))
    expect(email.html).toContain(escapeHtml(row.body!))
    expect(email.html).toMatch(new RegExp(`<a href="${escapeRe(open)}"[^>]*>Open in civfix</a>`))
  })

  it("T2: the footer names the category and links Stop these emails and the settings; the headers carry the same token", async () => {
    const h = harness()
    await h.set(U, "followers", [true, false, true])

    await h.service.onNewFollower({ followeeId: U, follower: person(A, "Alex") })
    await settle()

    const email = h.emails()[0]!
    const token = tokenOf(email)
    const stop = `${WEB}/unsubscribe/notifications/?t=${encodeURIComponent(token)}`
    const manage = `${WEB}/notifications/prefs`
    const reason = "You're getting this because Email is on for New followers."

    expect(email.text).toContain(reason)
    expect(email.text).toContain(`Stop these emails: ${stop}`)
    expect(email.text).toContain(`Manage notification settings: ${manage}`)
    expect(email.html).toContain(escapeHtml(reason))
    expect(email.html).toMatch(new RegExp(`<a [^>]*href="${escapeRe(stop)}"[^>]*>Stop these emails</a>`))
    expect(email.html).toMatch(
      new RegExp(`<a [^>]*href="${escapeRe(manage)}"[^>]*>Manage notification settings</a>`),
    )
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${API}/v1/notifications/email-unsubscribe?t=${encodeURIComponent(token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    })
    expect(verifyNotificationEmailToken(token, KEY, NOW)).toMatchObject({
      userId: U,
      category: "followers",
    })

    const open = `${WEB}/people/${A}`
    expect(hrefsOf(email.html!).sort()).toEqual([manage, open, stop].sort())
    expect(email.html).not.toMatch(/<img\b/i)
    const urls = email.html!.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
    for (const url of urls) expect([open, stop, manage]).toContain(url.replace(/&amp;/g, "&"))
  })

  it("T3: an Off category writes nothing and sends no email", async () => {
    const h = harness()
    await h.set(U, "followers", [false, false, true])

    const result = await h.service.createNotification(U, { type: "new_follower", title: "New follower" })
    await settle()

    expect(result).toBeNull()
    expect(h.rows(U)).toHaveLength(0)
    expect(h.emails()).toHaveLength(0)
  })

  it("T4: Email unchecked writes the row and pushes, with no email", async () => {
    const h = harness()
    await h.set(U, "followers", [true, true, false])

    await h.service.createNotification(U, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.rows(U)).toHaveLength(1)
    expect(h.push.sent).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
  })

  it("T5: email: \"never\" keeps a path's own email the only one", async () => {
    const h = harness()
    await h.set(U, "followers", [true, false, true])

    await h.service.createNotification(U, {
      type: "new_follower",
      title: "New follower",
      email: "never",
    })
    await settle()

    expect(h.rows(U)).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
  })

  it("T6: an Always on (system) notification is never emailed", async () => {
    const h = harness()

    await h.service.createNotification(U, { type: "system", title: "You're registered" })
    await settle()

    expect(h.rows(U)).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
  })

  it("T7: an unverified, missing or erased address gets no email", async () => {
    const accounts = [
      { email: ADDRESS, emailVerified: false, deletedAt: null },
      { email: null, emailVerified: true, deletedAt: null },
      { email: ADDRESS, emailVerified: true, deletedAt: new Date(NOW) },
    ]
    for (const stored of accounts) {
      const h = harness()
      h.repo.accounts.set(U, stored)
      await h.set(U, "followers", [true, false, true])

      await h.service.createNotification(U, { type: "new_follower", title: "New follower" })
      await settle()

      expect(h.rows(U), JSON.stringify(stored)).toHaveLength(1)
      expect(h.emails(), JSON.stringify(stored)).toHaveLength(0)
    }
  })

  it("T8: a suppressed address gets no email", async () => {
    const h = harness()
    h.repo.suppressedEmailHashes.add(emailHashOf(" U@Example.test "))
    await h.set(U, "followers", [true, false, true])

    await h.service.createNotification(U, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.rows(U)).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
  })

  it("T9: a deduped or coalesced hit sends no second email", async () => {
    const h = harness()
    await h.set(U, "followers", [true, false, true])
    await h.service.onNewFollower({ followeeId: U, follower: person(A, "Alex") })
    h.advance(MINUTE_MS)
    await h.service.onNewFollower({ followeeId: U, follower: person(A, "Alex") })
    await settle()
    expect(MINUTE_MS).toBeLessThan(NOTIFICATION_DEDUPE_WINDOW_MS)
    expect(h.rows(U)).toHaveLength(1)
    expect(h.emails()).toHaveLength(1)

    const c = harness()
    await c.set(U, "reportUpdates", [true, false, true])
    await c.service.createNotification(U, report(1, { coalesceWindowMs: HOUR_MS }))
    c.advance(MINUTE_MS)
    await c.service.createNotification(U, report(1, { coalesceWindowMs: HOUR_MS, body: "Again" }))
    await settle()
    expect(c.rows(U)).toHaveLength(1)
    expect(c.emails()).toHaveLength(1)
  })

  it("T10: quiet hours hold the push but not the email", async () => {
    const h = harness()
    await h.set(U, "followers", [true, true, true])
    h.repo.prefs.set(U, { ...DEFAULT_PREFS, quietStart: "11:00", quietEnd: "13:00", tz: "UTC" })

    await h.service.createNotification(U, { type: "new_follower", title: "New follower" })
    await settle()

    expect(h.push.sent).toHaveLength(0)
    expect(h.emails()).toHaveLength(1)
  })

  it("T11: a Spanish reader gets the whole email in Spanish", async () => {
    const h = harness()
    h.repo.locales.set(U, "es")
    await h.set(U, "followers", [true, false, true])

    await h.service.onNewFollower({ followeeId: U, follower: person(A, "Alex") })
    await settle()

    const email = h.emails()[0]!
    const es = (key: MessageKey, vars?: Record<string, string>) => renderMessage("es", key, vars)
    const en = (key: MessageKey, vars?: Record<string, string>) => renderMessage("en", key, vars)
    const title = es("notification.follower.title")
    const body = es("notification.follower.body", { name: "Alex" })
    expect(email.subject).toBe(title)
    expect(email.text).toContain(title)
    expect(email.text).toContain(body)

    const label = es("notification.category.followers")
    const chrome: Array<[string, string]> = [
      [es("email.notification.open_cta"), en("email.notification.open_cta")],
      [
        es("email.notification.footer_reason", { category: label }),
        en("email.notification.footer_reason", {
          category: en("notification.category.followers"),
        }),
      ],
      [label, en("notification.category.followers")],
      [es("email.notification.footer_stop"), en("email.notification.footer_stop")],
      [es("email.notification.footer_manage"), en("email.notification.footer_manage")],
    ]
    for (const [spanish, english] of chrome) {
      expect(spanish).not.toBe(english)
      expect(email.text).toContain(spanish)
      expect(email.html).toContain(escapeHtml(spanish))
    }
  })

  it("T12: a notification without a link opens the notifications page", async () => {
    const h = harness()
    await h.set(U, "reportUpdates", [true, false, true])

    await h.service.createNotification(U, report(1, { link: undefined }))
    await settle()

    const email = h.emails()[0]!
    expect(email.html).toMatch(
      new RegExp(`<a href="${escapeRe(`${WEB}/notifications`)}"[^>]*>Open in civfix</a>`),
    )
    expect(email.text).toContain(`Open in civfix: ${WEB}/notifications\n`)
  })
})

describe("notification emails: what they say", () => {
  it("T13: a chat-category email names the conversation and never carries the message", async () => {
    for (const category of CHAT_CATEGORIES) {
      const h = harness()
      await h.set(U, category, [true, false, true])

      await h.service.createNotification(U, {
        type: "dm",
        category,
        title: "Alex",
        body: "secret text 123",
        link: "/messages/dm/R1",
        conversationName: "Garden crew",
      })
      await settle()

      expect(h.emails(), category).toHaveLength(1)
      const email = h.emails()[0]!
      expect(email.subject, category).toBe("New messages in Garden crew")
      for (const part of [email.text, email.html!]) {
        expect(part, category).toContain("Alex")
        expect(part, category).toContain("Garden crew")
        expect(part, category).not.toContain("secret text 123")
      }
    }
  })

  it("T14: other categories carry the body", async () => {
    const h = harness()
    await h.set(U, "reportUpdates", [true, false, true])

    await h.service.createNotification(U, report(1))
    await settle()

    const email = h.emails()[0]!
    expect(email.text).toContain("Status changed to Fixed")
    expect(email.html).toContain("Status changed to Fixed")
  })

  it("T15: a post mention with no conversation is subjected by its title and leaves out the body", async () => {
    const h = harness()
    await h.set(U, "mentions", [true, false, true])

    await h.service.onPostMention({ recipientId: U, actorName: "Ana", postId: P })
    await settle()

    const row = h.rows(U)[0]!
    expect(h.emails()).toHaveLength(1)
    const email = h.emails()[0]!
    expect(email.subject).toBe(row.title)
    expect(email.text).toContain(row.title)
    expect(email.html).toContain(escapeHtml(row.title))
    expect(email.text).not.toContain(row.body!)
    expect(email.html).not.toContain(escapeHtml(row.body!))
  })
})

describe("notification emails: throttle and cap", () => {
  it("T16: three DMs in a minute send one email for the conversation", async () => {
    const h = harness()
    await h.set(U, "directMessages", [true, true, true])

    for (let i = 0; i < 3; i++) {
      await h.service.createNotification(U, dm("R1"))
      h.advance(20 * 1000)
    }
    await settle()

    expect(h.rows(U)).toHaveLength(3)
    expect(h.push.sent).toHaveLength(3)
    expect(h.emails()).toHaveLength(1)
    expect(h.emails()[0]!.subject).toBe("New messages in Alex")
  })

  it("T17: another conversation in the same hour gets its own email", async () => {
    const h = harness()
    await h.set(U, "directMessages", [true, true, true])
    for (let i = 0; i < 3; i++) await h.service.createNotification(U, dm("R1"))
    h.advance(10 * MINUTE_MS)

    await h.service.createNotification(U, dm("R2"))
    await settle()

    expect(h.emails()).toHaveLength(2)
    expect(h.emails()[1]!.html).toContain(`${WEB}/messages/dm/R2`)
  })

  it("T18: the same conversation emails again once the hour has passed", async () => {
    const h = harness()
    await h.set(U, "directMessages", [true, true, true])
    for (let i = 0; i < 3; i++) await h.service.createNotification(U, dm("R1"))
    await settle()
    h.advance(60 * MINUTE_MS)

    await h.service.createNotification(U, dm("R1"))
    await settle()

    expect(h.emails()).toHaveLength(2)
  })

  it("T19: the conversation throttle is per person", async () => {
    const h = harness()
    h.account(V, "v@example.test")
    await h.set(U, "groupChats", [true, false, true])
    await h.set(V, "groupChats", [true, false, true])
    const input: CreateNotificationInput = {
      type: "group_chat",
      title: "Alex",
      body: "see you there",
      link: "/messages/group/G1",
      conversationName: "Garden crew",
    }

    await h.service.createNotifications([U, V], input)
    await settle()
    h.advance(30 * 1000)
    await h.service.createNotifications([U, V], input)
    await settle()

    expect(h.emails().map((e) => e.to).sort()).toEqual([ADDRESS, "v@example.test"])
  })

  it("T20: at most 20 notification emails an hour, then the next hour emails again", async () => {
    const h = harness()
    await h.set(U, "reportUpdates", [true, false, true])

    for (let i = 0; i < 21; i++) {
      await h.service.createNotification(U, report(i))
      await settle()
      h.advance(MINUTE_MS)
    }

    expect(h.rows(U)).toHaveLength(21)
    expect(h.emails()).toHaveLength(20)
    expect(h.emails().some((e) => e.subject === "Report 20 updated")).toBe(false)

    h.advance(HOUR_MS)
    await h.service.createNotification(U, report(21))
    await settle()
    expect(h.emails()).toHaveLength(21)
  })

  it("T21: throttled chat messages do not count toward the cap", async () => {
    const h = harness()
    await h.set(U, "directMessages", [true, false, true])
    await h.set(U, "reportUpdates", [true, false, true])

    for (let i = 0; i < 30; i++) {
      await h.service.createNotification(U, dm("R1"))
      await settle()
    }
    for (let i = 0; i < 19; i++) {
      await h.service.createNotification(U, report(i))
      await settle()
    }
    await h.service.createNotification(U, report(19))
    await settle()

    expect(h.emails()).toHaveLength(20)
    expect(h.emails().filter((e) => e.subject === "New messages in Alex")).toHaveLength(1)
    expect(h.emails().some((e) => e.subject === "Report 19 updated")).toBe(false)
  })
})

describe("notification emails: failures stay inside the email", () => {
  function failingThrottle(h: ReturnType<typeof harness>): void {
    h.throttle.claim = () => Promise.reject(new Error("redis down"))
    h.throttle.release = () => Promise.reject(new Error("redis down"))
  }

  it("T22: a throttle store outage skips the email and logs once, with no address or body", async () => {
    const h = harness()
    failingThrottle(h)
    await h.set(U, "reportUpdates", [true, true, true])

    const dto = await h.service.createNotification(U, report(1, { body: "secret body 77" }))
    await settle()

    expect(dto).toMatchObject({ type: "report_update" })
    expect(h.rows(U)).toHaveLength(1)
    expect(h.push.sent).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
    expect(h.log.warns).toHaveLength(1)
    expect(h.log.serialized(h.log.warns)).not.toContain(ADDRESS)
    expect(h.log.serialized(h.log.warns)).not.toContain("secret body 77")

    const f = harness()
    failingThrottle(f)
    await f.set(U, "reportUpdates", [true, true, true])
    const result = await f.service.createNotificationsReportingFailures(
      [U],
      report(1, { body: "secret body 77" }),
    )
    await settle()

    expect(result.failed).toEqual([])
    expect(f.rows(U)).toHaveLength(1)
    expect(f.push.sent).toHaveLength(1)
    expect(f.emails()).toHaveLength(0)
    expect(f.log.warns).toHaveLength(1)
    expect(f.log.serialized(f.log.warns)).not.toContain(ADDRESS)
    expect(f.log.serialized(f.log.warns)).not.toContain("secret body 77")
  })

  it("T23: a failed send resolves the notification and logs the user id, never the address", async () => {
    const reject = () =>
      Promise.reject(new Error(`550 5.1.1 <${ADDRESS}>: Recipient address rejected`))

    const h = harness()
    h.mailer.sendOutbound = reject
    await h.set(U, "reportUpdates", [true, false, true])
    const dto = await h.service.createNotification(U, report(1))
    await settle()
    expect(dto).toMatchObject({ type: "report_update" })
    expect(h.log.serialized(h.log.warns)).toContain(U)
    expect(h.log.serialized([...h.log.warns, ...h.log.errors])).not.toContain(ADDRESS)

    const f = harness()
    f.mailer.sendOutbound = reject
    await f.set(U, "reportUpdates", [true, false, true])
    const result = await f.service.createNotificationsReportingFailures([U], report(1))
    await settle()
    expect(result.failed).toEqual([])
    expect(f.log.serialized(f.log.warns)).toContain(U)
    expect(f.log.serialized([...f.log.warns, ...f.log.errors])).not.toContain(ADDRESS)
  })

  it("T24: a failed recipient lookup sends nothing and fails nothing", async () => {
    const h = harness()
    h.repo.findEmailRecipients = () => Promise.reject(new Error("connection terminated"))
    await h.set(U, "reportUpdates", [true, true, true])

    const result = await h.service.createNotificationsReportingFailures([U], report(1))
    await settle()

    expect(result.failed).toEqual([])
    expect(h.rows(U)).toHaveLength(1)
    expect(h.push.sent).toHaveLength(1)
    expect(h.emails()).toHaveLength(0)
  })
})

describe("notification emails: fan-outs", () => {
  it("T25: 1200 recipients take 3 batched lookups and 3 batched throttle calls", async () => {
    const h = harness()
    const ids = users(1200)
    for (const id of ids) h.account(id, `${id}@example.test`)
    const claims: string[][] = []
    const claim = h.throttle.claim.bind(h.throttle)
    h.throttle.claim = (requests: readonly EmailThrottleRequest[]) => {
      claims.push(requests.map((r) => r.userId))
      return claim(requests)
    }

    await h.service.createNotifications(ids, {
      type: "cleanup_reminder",
      title: "Cleanup tomorrow",
      body: "See you at 9",
      link: "/events/e1",
    })
    await vi.waitFor(() => expect(h.emails()).toHaveLength(1200))

    const batches = [ids.slice(0, 500), ids.slice(500, 1000), ids.slice(1000)]
    expect(h.repo.emailRecipientCalls).toEqual(batches)
    expect(claims).toEqual(batches)
  })

  it("T27: never more than 8 sends in flight", async () => {
    const h = harness()
    const ids = users(50)
    for (const id of ids) h.account(id, `${id}@example.test`)
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.mailer.sendOutbound = async () => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return { messageId: `<m${calls}@civfix.test>` }
    }

    await h.service.createNotifications(ids, {
      type: "cleanup_reminder",
      title: "Cleanup tomorrow",
      link: "/events/e1",
    })
    await vi.waitFor(() => expect(inFlight).toBe(8))
    await settle()
    expect(maxInFlight).toBe(8)

    release()
    await vi.waitFor(() => expect(calls).toBe(50))
    await vi.waitFor(() => expect(inFlight).toBe(0))
    expect(maxInFlight).toBe(8)
  })

  it("T28: the first email goes after every row and after the batch's push", async () => {
    const h = harness()
    const ids = users(3)
    for (const id of ids) h.account(id, `${id}@example.test`)
    const events: string[] = []
    const insert = h.repo.insertNotification.bind(h.repo)
    h.repo.insertNotification = (args) => {
      events.push("row")
      return insert(args)
    }
    const sendEach = h.push.sendEach.bind(h.push)
    h.push.sendEach = (items) => {
      events.push("push")
      return sendEach(items)
    }
    const sendOutbound = h.mailer.sendOutbound.bind(h.mailer)
    h.mailer.sendOutbound = (email) => {
      events.push("email")
      return sendOutbound(email)
    }

    await h.service.createNotifications(ids, {
      type: "cleanup_reminder",
      title: "Cleanup tomorrow",
      link: "/events/e1",
    })
    await vi.waitFor(() => expect(h.emails()).toHaveLength(3))

    const firstEmail = events.indexOf("email")
    expect(events.filter((e) => e === "row")).toHaveLength(3)
    expect(events.lastIndexOf("row")).toBeLessThan(firstEmail)
    expect(events.indexOf("push")).toBeGreaterThanOrEqual(0)
    expect(events.indexOf("push")).toBeLessThan(firstEmail)
  })

  it("T29: only the recipient with Email checked gets an email", async () => {
    const h = harness()
    const [a, b, c] = users(3) as [string, string, string]
    for (const id of [a, b, c]) h.account(id, `${id}@example.test`)
    await h.set(a, "events", [false, true, true])
    await h.set(b, "events", [true, true, false])
    await h.set(c, "events", [true, true, true])

    const result = await h.service.createNotificationsReportingFailures([a, b, c], {
      type: "cleanup_reminder",
      title: "Cleanup tomorrow",
      link: "/events/e1",
    })
    await settle()

    expect(result.failed).toEqual([])
    expect(h.emails().map((e) => e.to)).toEqual([`${c}@example.test`])
  })
})

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
