import { afterEach, describe, expect, it } from "vitest"
import type { LightMyRequestResponse } from "fastify"
import { NOTIFICATION_CATEGORY_DEFAULTS, NotificationCategorySchema } from "@civfix/contract"
import type { NotificationCategory, NotificationCategorySetting } from "@civfix/contract"
import { makeAuthHarness, type AuthHarness } from "../helpers/auth.js"
import {
  InMemoryNotificationRepository,
  InMemoryNotificationSettingsRepository,
} from "../helpers/notifications.js"

/**
 * getNotificationSettings / updateNotificationSettings and the old prefs routes bridged onto
 * notification_settings (D4), through the real Fastify app over the in-memory notification and settings
 * repositories. Mutations go over a cookie session with its CSRF token unless a case says otherwise.
 */

type Settings = Record<NotificationCategory, NotificationCategorySetting>
type Triple = readonly [enabled: boolean, push: boolean, email: boolean]

interface WebSession {
  userId: string
  cookie: string
  csrfToken: string
}

interface Harness {
  auth: AuthHarness
  repo: InMemoryNotificationRepository
  settings: InMemoryNotificationSettingsRepository
  a: WebSession
}

const CATEGORIES = NotificationCategorySchema.options

const SETTINGS_URL = "/v1/notifications/settings"
const PREFS_URL = "/v1/notifications/prefs"

let current: AuthHarness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function signInWeb(auth: AuthHarness, email: string): Promise<WebSession> {
  const requested = await auth.app.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { email },
  })
  expect(requested.statusCode).toBe(200)
  const code = auth.mailer.lastOtpFor(email)!
  const res = await auth.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "web" },
    payload: { email, code },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers["set-cookie"]
  const lines = Array.isArray(setCookie) ? setCookie : [String(setCookie)]
  const cookie = lines.find((l) => l.startsWith("civfix_session="))!.split(";")[0]!
  return { userId: res.json().user.id as string, cookie, csrfToken: res.json().csrfToken as string }
}

async function makeHarness(): Promise<Harness> {
  const repo = new InMemoryNotificationRepository()
  const settings = new InMemoryNotificationSettingsRepository()
  const auth = await makeAuthHarness({
    server: { notificationOverrides: { repo, settingsRepo: settings } },
  })
  current = auth
  const a = await signInWeb(auth, "a@example.com")
  return { auth, repo, settings, a }
}

function cookieHeaders(s: WebSession): Record<string, string> {
  return { cookie: s.cookie, "x-csrf-token": s.csrfToken }
}

function getSettings(h: Harness, s: WebSession = h.a): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({ method: "GET", url: SETTINGS_URL, headers: { cookie: s.cookie } })
}

function patchSettings(
  h: Harness,
  payload: unknown,
  s: WebSession = h.a,
  headers: Record<string, string> = cookieHeaders(s),
): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({
    method: "PATCH",
    url: SETTINGS_URL,
    headers,
    payload: payload as Record<string, unknown>,
  })
}

function getPrefs(h: Harness): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({ method: "GET", url: PREFS_URL, headers: { cookie: h.a.cookie } })
}

function putPrefs(h: Harness, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return h.auth.app.inject({ method: "PUT", url: PREFS_URL, headers: cookieHeaders(h.a), payload })
}

function setting([enabled, push, email]: Triple): NotificationCategorySetting {
  return { enabled, push, email }
}

function defaults(): Settings {
  return Object.fromEntries(
    CATEGORIES.map((c) => [c, { ...NOTIFICATION_CATEGORY_DEFAULTS[c] }]),
  ) as Settings
}

function defaultsWith(over: Partial<Settings>): Settings {
  return { ...defaults(), ...over }
}

async function seed(
  h: Harness,
  rows: Partial<Record<NotificationCategory, Triple>>,
): Promise<void> {
  await h.settings.upsertSettings(
    h.a.userId,
    Object.fromEntries(Object.entries(rows).map(([c, t]) => [c, setting(t)])),
  )
}

/** The account's settings as stored, each category at its default when it has no row. */
async function effective(h: Harness): Promise<Settings> {
  const out = defaults()
  for (const row of await h.settings.getSettings(h.a.userId)) {
    out[row.category] = { enabled: row.enabled, push: row.push, email: row.email }
  }
  return out
}

/** Every category in `settings` with Push set to `push`, the rest untouched. */
function withPush(settings: Settings, categories: readonly NotificationCategory[], push: boolean) {
  const out = { ...settings }
  for (const c of categories) out[c] = { ...out[c], push }
  return out
}

describe("GET /v1/notifications/settings", () => {
  it("T1: a new account reads every category at its default and emailAvailable, writing nothing", async () => {
    const h = await makeHarness()
    const res = await getSettings(h)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ categories: Settings; emailAvailable: boolean }>()
    expect(Object.keys(body.categories).sort()).toEqual([...CATEGORIES].sort())
    expect(body.categories).toEqual(defaults())
    expect(body.emailAvailable).toBe(true)
    expect(h.settings.rows.size).toBe(0)
  })

  it("T2: a stored row wins over its default; the other ten stay at their defaults", async () => {
    const h = await makeHarness()
    await seed(h, { events: [true, false, false] })
    const res = await getSettings(h)
    expect(res.statusCode).toBe(200)
    expect(res.json().categories).toEqual(
      defaultsWith({ events: { enabled: true, push: false, email: false } }),
    )
  })

  it("T3: an unverified email is not available", async () => {
    const h = await makeHarness()
    const user = (await h.auth.stores.users.findById(h.a.userId))!
    h.auth.stores.users.seed(user.email, { ...user, emailVerified: false })
    const res = await getSettings(h)
    expect(res.statusCode).toBe(200)
    expect(res.json().emailAvailable).toBe(false)
  })

  it("T4: an account with no email has no email available", async () => {
    const h = await makeHarness()
    const user = (await h.auth.stores.users.findById(h.a.userId))!
    h.auth.stores.users.seed(null, { ...user, email: null, emailVerified: false })
    const res = await getSettings(h)
    expect(res.statusCode).toBe(200)
    expect(res.json().emailAvailable).toBe(false)
  })

  it("T5: GET and PATCH without a session are UNAUTHORIZED and write nothing", async () => {
    const h = await makeHarness()
    const read = await h.auth.app.inject({ method: "GET", url: SETTINGS_URL })
    expect(read.statusCode).toBe(401)
    expect(read.json().code).toBe("UNAUTHORIZED")
    const write = await h.auth.app.inject({
      method: "PATCH",
      url: SETTINGS_URL,
      payload: { categories: { events: { push: false } } },
    })
    expect(write.statusCode).toBe(401)
    expect(write.json().code).toBe("UNAUTHORIZED")
    expect(h.settings.rows.size).toBe(0)
  })
})

describe("PATCH /v1/notifications/settings", () => {
  it("T6: merges the given fields and returns the full DTO, which a following GET repeats", async () => {
    const h = await makeHarness()
    const res = await patchSettings(h, {
      categories: { events: { email: false }, followers: { push: true } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      categories: defaultsWith({
        events: { enabled: true, push: true, email: false },
        followers: { enabled: true, push: true, email: false },
      }),
      emailAvailable: true,
    })
    const read = await getSettings(h)
    expect(read.json()).toEqual(res.json())
  })

  it("T7: a later patch keeps the stored fields it leaves out", async () => {
    const h = await makeHarness()
    await patchSettings(h, { categories: { events: { email: false }, followers: { push: true } } })
    const res = await patchSettings(h, { categories: { events: { push: false } } })
    expect(res.statusCode).toBe(200)
    expect(res.json().categories.events).toEqual({ enabled: true, push: false, email: false })
    expect(res.json().categories.followers).toEqual({ enabled: true, push: true, email: false })
  })

  it("T8: an unknown category is a validation error and writes nothing", async () => {
    const h = await makeHarness()
    const res = await patchSettings(h, { categories: { weeklyDigest: { push: true } } })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(h.settings.rows.size).toBe(0)
  })

  it("T9: an unknown field is a validation error and writes nothing", async () => {
    const h = await makeHarness()
    const res = await patchSettings(h, { categories: { events: { sms: true } } })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(h.settings.rows.size).toBe(0)
  })

  it("T10: an empty, mistyped or padded body is a validation error and writes nothing", async () => {
    const h = await makeHarness()
    for (const body of [
      { categories: {} },
      { categories: { events: {} } },
      { categories: { events: { push: "yes" } } },
      { categories: { events: { push: false } }, extra: 1 },
      {},
    ]) {
      const res = await patchSettings(h, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(422)
      expect(res.json().code, JSON.stringify(body)).toBe("VALIDATION")
    }
    expect(h.settings.rows.size).toBe(0)
  })

  it("T11: a cookie session needs the CSRF token; a bearer session does not", async () => {
    const h = await makeHarness()
    const body = { categories: { events: { push: false } } }
    const refused = await patchSettings(h, body, h.a, { cookie: h.a.cookie })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().code).toBe("FORBIDDEN")
    expect(h.settings.rows.size).toBe(0)

    expect((await patchSettings(h, body)).statusCode).toBe(200)

    const token = await h.auth.services.sessions.createSession(h.a.userId, ["citizen"])
    const bearer = { authorization: `Bearer ${token}`, "x-client": "mobile" }
    const res = await patchSettings(h, { categories: { followers: { push: true } } }, h.a, bearer)
    expect(res.statusCode).toBe(200)
  })

  it("T12: the 31st patch within a minute is RATE_LIMITED; another account has its own bucket", async () => {
    const h = await makeHarness()
    const body = { categories: { events: { push: false } } }
    for (let i = 0; i < 30; i += 1) {
      expect((await patchSettings(h, body)).statusCode, `patch ${i + 1}`).toBe(200)
    }
    const over = await patchSettings(h, body)
    expect(over.statusCode).toBe(429)
    expect(over.json().code).toBe("RATE_LIMITED")

    const b = await signInWeb(h.auth, "b@example.com")
    expect((await patchSettings(h, body, b)).statusCode).toBe(200)
  })
})

describe("GET /v1/notifications/prefs (D4 bridge)", () => {
  it("T14: a new account reads the defaults' mapping, with no quiet hours, writing no settings", async () => {
    const h = await makeHarness()
    const res = await getPrefs(h)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      push: true,
      reportUpdates: true,
      cleanupChat: false,
      follows: false,
      mentions: true,
      postInteractions: false,
      hostBroadcasts: true,
    })
    expect(h.settings.rows.size).toBe(0)
  })

  it("T15: push is true when any category has Push checked", async () => {
    const h = await makeHarness()
    await h.settings.upsertSettings(
      h.a.userId,
      Object.fromEntries(CATEGORIES.map((c) => [c, { push: false }])),
    )
    expect((await getPrefs(h)).json().push).toBe(false)
    await h.settings.upsertSettings(h.a.userId, { organizations: { push: true } })
    expect((await getPrefs(h)).json().push).toBe(true)
  })

  it("T16: reportUpdates follows reportUpdates.push alone", async () => {
    const h = await makeHarness()
    await h.settings.upsertSettings(h.a.userId, {
      reportUpdates: { push: false },
      reportDiscussions: { push: true },
    })
    expect((await getPrefs(h)).json().reportUpdates).toBe(false)
  })

  it("T17: cleanupChat follows groupChats.push alone", async () => {
    const h = await makeHarness()
    await h.settings.upsertSettings(h.a.userId, {
      groupChats: { push: true },
      events: { push: false },
      eventTeam: { push: false },
    })
    expect((await getPrefs(h)).json().cleanupChat).toBe(true)
  })

  it("T18: follows follows followers.push", async () => {
    const h = await makeHarness()
    await h.settings.upsertSettings(h.a.userId, { followers: { push: true } })
    expect((await getPrefs(h)).json().follows).toBe(true)
  })

  it("T19: mentions is on only when the category is on with Push checked", async () => {
    const h = await makeHarness()
    await seed(h, { mentions: [false, true, false] })
    expect((await getPrefs(h)).json().mentions).toBe(false)
    await seed(h, { mentions: [true, false, false] })
    expect((await getPrefs(h)).json().mentions).toBe(false)
    await seed(h, { mentions: [true, true, false] })
    expect((await getPrefs(h)).json().mentions).toBe(true)
  })

  it("T20: postInteractions follows likesAndReposts.push", async () => {
    const h = await makeHarness()
    await h.settings.upsertSettings(h.a.userId, { likesAndReposts: { push: true } })
    expect((await getPrefs(h)).json().postInteractions).toBe(true)
  })

  it("T21: hostBroadcasts follows whether hostAnnouncements is on", async () => {
    const h = await makeHarness()
    await seed(h, { hostAnnouncements: [false, true, false] })
    expect((await getPrefs(h)).json().hostBroadcasts).toBe(false)
    await seed(h, { hostAnnouncements: [true, false, false] })
    expect((await getPrefs(h)).json().hostBroadcasts).toBe(true)
  })

  it("T22: quiet hours come from notification_prefs", async () => {
    const h = await makeHarness()
    await h.repo.upsertPrefs(h.a.userId, {
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    })
    expect((await getPrefs(h)).json().quietHours).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/Los_Angeles",
    })
  })
})

describe("PUT /v1/notifications/prefs (D4 bridge)", () => {
  it("T23: reportUpdates writes Push on reportUpdates and reportDiscussions, both ways", async () => {
    const h = await makeHarness()
    const off = await putPrefs(h, { reportUpdates: false })
    expect(off.statusCode).toBe(200)
    expect(await effective(h)).toEqual(
      withPush(defaults(), ["reportUpdates", "reportDiscussions"], false),
    )
    expect(off.json().reportUpdates).toBe(false)

    const on = await putPrefs(h, { reportUpdates: true })
    expect(on.statusCode).toBe(200)
    expect(await effective(h)).toEqual(
      withPush(defaults(), ["reportUpdates", "reportDiscussions"], true),
    )
    expect(on.json().reportUpdates).toBe(true)
  })

  it("T24: cleanupChat writes Push on groupChats, events and eventTeam, both ways", async () => {
    const h = await makeHarness()
    const off = await putPrefs(h, { cleanupChat: false })
    expect(off.statusCode).toBe(200)
    const offSettings = await effective(h)
    expect(offSettings).toEqual(withPush(defaults(), ["groupChats", "events", "eventTeam"], false))
    expect(offSettings.events.email).toBe(true)
    expect(off.json().cleanupChat).toBe(false)

    const on = await putPrefs(h, { cleanupChat: true })
    expect(on.statusCode).toBe(200)
    expect(await effective(h)).toEqual(
      withPush(defaults(), ["groupChats", "events", "eventTeam"], true),
    )
    expect(on.json().cleanupChat).toBe(true)
  })

  it("T25: follows writes followers.push, both ways", async () => {
    const h = await makeHarness()
    const on = await putPrefs(h, { follows: true })
    expect(await effective(h)).toEqual(withPush(defaults(), ["followers"], true))
    expect(on.json().follows).toBe(true)
    const off = await putPrefs(h, { follows: false })
    expect(await effective(h)).toEqual(withPush(defaults(), ["followers"], false))
    expect(off.json().follows).toBe(false)
  })

  it("T26: postInteractions writes likesAndReposts.push, both ways", async () => {
    const h = await makeHarness()
    const on = await putPrefs(h, { postInteractions: true })
    expect(await effective(h)).toEqual(withPush(defaults(), ["likesAndReposts"], true))
    expect(on.json().postInteractions).toBe(true)
    const off = await putPrefs(h, { postInteractions: false })
    expect(await effective(h)).toEqual(withPush(defaults(), ["likesAndReposts"], false))
    expect(off.json().postInteractions).toBe(false)
  })

  it("T27: mentions writes the category's enabled and Push, both ways", async () => {
    const h = await makeHarness()
    const off = await putPrefs(h, { mentions: false })
    expect(await effective(h)).toEqual(
      defaultsWith({ mentions: { enabled: false, push: false, email: false } }),
    )
    expect(off.json().mentions).toBe(false)
    const on = await putPrefs(h, { mentions: true })
    expect(await effective(h)).toEqual(
      defaultsWith({ mentions: { enabled: true, push: true, email: false } }),
    )
    expect(on.json().mentions).toBe(true)
  })

  it("T28: hostBroadcasts writes hostAnnouncements' enabled and Push, both ways", async () => {
    const h = await makeHarness()
    const off = await putPrefs(h, { hostBroadcasts: false })
    expect(await effective(h)).toEqual(
      defaultsWith({ hostAnnouncements: { enabled: false, push: false, email: false } }),
    )
    expect(off.json().hostBroadcasts).toBe(false)
    const on = await putPrefs(h, { hostBroadcasts: true })
    expect(await effective(h)).toEqual(
      defaultsWith({ hostAnnouncements: { enabled: true, push: true, email: false } }),
    )
    expect(on.json().hostBroadcasts).toBe(true)
  })

  it("T29: master push off unchecks Push everywhere and keeps every enabled and email", async () => {
    const h = await makeHarness()
    const res = await putPrefs(h, { push: false })
    expect(res.statusCode).toBe(200)
    expect(await effective(h)).toEqual(withPush(defaults(), CATEGORIES, false))
    expect(res.json()).toEqual({
      push: false,
      reportUpdates: false,
      cleanupChat: false,
      follows: false,
      mentions: false,
      postInteractions: false,
      hostBroadcasts: true,
    })
  })

  it("T30: master push on changes nothing", async () => {
    const h = await makeHarness()
    await putPrefs(h, { push: false })
    const res = await putPrefs(h, { push: true })
    expect(res.statusCode).toBe(200)
    expect(await effective(h)).toEqual(withPush(defaults(), CATEGORIES, false))
    expect(res.json().push).toBe(false)
  })

  it("T31: master push off is applied after the per-switch mappings in the same body", async () => {
    const h = await makeHarness()
    const res = await putPrefs(h, { push: false, reportUpdates: true })
    expect(res.statusCode).toBe(200)
    expect(await effective(h)).toEqual(withPush(defaults(), CATEGORIES, false))
    expect(res.json().push).toBe(false)
    expect(res.json().reportUpdates).toBe(false)
  })

  it("T32: quiet hours save on notification_prefs, never on notification_settings, and clear", async () => {
    const h = await makeHarness()
    const quietHours = { start: "22:00", end: "07:00", tz: "America/Los_Angeles" }
    expect((await putPrefs(h, { quietHours })).statusCode).toBe(200)
    expect(h.repo.prefs.get(h.a.userId)).toMatchObject({
      quietStart: "22:00",
      quietEnd: "07:00",
      tz: "America/Los_Angeles",
    })
    expect((await getPrefs(h)).json().quietHours).toEqual(quietHours)
    expect(h.settings.rows.size).toBe(0)

    expect((await putPrefs(h, { quietHours: null })).statusCode).toBe(200)
    expect(h.repo.prefs.get(h.a.userId)).toMatchObject({ quietStart: null, quietEnd: null })
    expect((await getPrefs(h)).json()).not.toHaveProperty("quietHours")
  })

  it("T33: a switch leaves the notification_prefs row untouched", async () => {
    const h = await makeHarness()
    await h.repo.upsertPrefs(h.a.userId, {
      follows: false,
      mentions: false,
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    })
    const before = { ...h.repo.prefs.get(h.a.userId)! }
    expect((await putPrefs(h, { reportUpdates: false })).statusCode).toBe(200)
    expect(h.repo.prefs.get(h.a.userId)).toEqual(before)
    expect(await effective(h)).toEqual(
      withPush(defaults(), ["reportUpdates", "reportDiscussions"], false),
    )
  })
})
