/**
 * Seeds a realistic Los Angeles demo community: users with a follow graph, posts, reports, cleanup
 * events and volunteer hours.
 *
 * INVARIANTS (each mirrors the live write path so seeded rows are indistinguishable from organic ones):
 *   - Reference codes come from the same reference_counters allocator the create transactions use, so
 *     live creates can never collide.
 *   - reports.h3_cell and the jurisdiction_geoid columns come from reportH3Cell and resolveJurisdiction,
 *     as on the create paths.
 *   - Every denormalized counter is exact (repost_count counts pure reposts only; quotes do not bump it,
 *     matching createPost). A SQL verification pass recomputes them all inside the transaction and
 *     aborts on any mismatch.
 *   - Volunteer hours follow the logEventHours shape: a ledger row per credited attendee, the rollup
 *     upsert, and one audit row.
 *
 * CLOSED WORLD: all follows / likes / replies / memberships the seeder writes stay inside the seeded
 * cohort. Real users can still interact with demo content once it is live, so --purge recomputes the
 * counters of every real user and post a demo account touched, and refuses (naming the rows) when real
 * replies, reposts or volunteer hours depend on demo content.
 *
 * SAFETY: the default run is a rehearsal: the seed and its verification run in one transaction that
 * then rolls back. Pass --yes to commit. Seeded accounts use the reserved DEMO_EMAIL_DOMAIN so a real
 * person can never collide with (or inherit) one via the OTP flow, and --purge keys off that domain.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:seed:demo                # rehearse (rollback), print report
 *   DATABASE_URL=postgres://... pnpm db:seed:demo -- --yes       # commit
 *   DATABASE_URL=postgres://... pnpm db:seed:demo -- --purge     # rehearse purge
 *   DATABASE_URL=postgres://... pnpm db:seed:demo -- --purge --yes
 *   Optional: --users N (default 250), --seed N (PRNG seed, default 20260902).
 *
 * Reads DATABASE_URL directly (not loadEnv) so it can run from a minimal shell; sslmode on the URL is
 * honored by makeDb exactly as the API does. A seed (not --purge) also needs TICKET_TOKEN_SECRET,
 * resolved as the API resolves it (development fallback included), because members of upcoming events
 * get the free registration + seat a live sign-up mints.
 */

import { randomUUID } from "node:crypto"
import { HANDLE_REGEX, REPORT_TYPE_TO_CATEGORY, type ReportType } from "@civfix/shared"
import type { Sql, TransactionSql } from "./client.js"
import {
  allocateEventReferenceCode,
  allocateReportReferenceCode,
  resolveJurisdictionCode,
} from "./reference-code.js"
import { resolveJurisdiction } from "./sql/jurisdiction.js"
import { reportH3Cell } from "../services/report-clustering.js"
import { argValue, requireDatabaseUrl, runDbCli, runIfMain } from "./cli.js"
import { DEMO_EMAIL_DOMAIN, DEMO_EMAIL_PATTERN } from "./seed-demo-domain.js"
import { DEFAULT_EVENT_DURATION_MS, DEFAULT_EVENT_SLOT_TITLE } from "../services/cleanup-rules.js"
import { demoTicketTokenHasher, mintDemoSignupSeats } from "./demo-signup-seats.js"
import { touchUserActivity } from "./sql/user-activity.js"
import {
  DEMO_PRNG_SEED,
  chance,
  pick,
  pickWeighted,
  rand,
  rint,
  sampleWeighted,
  seedDemoRandom,
  shuffle,
} from "./demo-random.js"
import {
  ACCENTED,
  BIO_FEMALE,
  BIO_HISPANIC_F,
  BIO_HISPANIC_M,
  BIO_HISPANIC_NEUTRAL,
  BIO_MALE,
  BIO_NEUTRAL,
  BRING_POOL,
  EVENT_DESC_EN,
  EVENT_DESC_ES,
  EVENT_POST_EN,
  EVENT_POST_ES,
  EVENT_RECAP_EN,
  EVENT_RECAP_ES,
  EVENT_TITLE_EN,
  EVENT_TITLE_ES,
  HISPANIC_FIRST_F,
  HISPANIC_FIRST_M,
  HISPANIC_LAST,
  HOODS,
  OTHER_POOLS,
  PARKS,
  POST_TEMPLATES_EN,
  POST_TEMPLATES_ES,
  QUOTE_EN,
  QUOTE_ES,
  REPLY_EVENT_EN,
  REPLY_EVENT_ES,
  REPLY_GENERIC_EN,
  REPLY_GENERIC_ES,
  REPLY_REPORT_EN,
  REPLY_REPORT_ES,
  REPORT_CONTENT,
  REPORT_POST_EN,
  REPORT_POST_ES,
  SLOT_SETS,
  TIMELINE_ACK_NOTES,
  TIMELINE_RESOLVE_NOTES,
  hoodByName,
  type Hood,
} from "./seed-demo-la-data.js"

// Seeded addresses are typed by hand, the provenance the live create paths record for that case.
const SEEDED_REPORT_ADDR_SOURCE = "user"
const SEEDED_EVENT_ADDRESS_SOURCE = "manual"

const DEFAULT_USER_COUNT = 250
const COHORT_HISTORY_DAYS = 185
const NEWEST_ACCOUNT_AGE_DAYS = 2
const REPORTS_PER_USER = 0.62

const EVENT_COUNT = 20
const EVENT_ORGANIZER_COUNT = 14
// Events before this index are past ("done"), the one at it is cancelled, the rest are upcoming.
const PAST_EVENT_COUNT = 13
const EVENT_HISTORY_DAYS = 150
const EVENT_MIN_CREATE_LEAD_DAYS = 2
const EVENT_MIN_AGE_HOURS = 6
const EVENT_MAX_CREATE_LEAD_DAYS = 28
const EVENT_START_HOUR = 9
const EVENT_SITE_JITTER_DEG = 0.0015

const MAX_REPLIES_PER_THREAD = 14
const MAX_REPLY_DEPTH = 3
const REPLY_WINDOW_DAYS = 5
const RESHARE_WINDOW_DAYS = 7
const MIN_FOLLOWERS_TO_RESHARE = 3
const LIKE_WINDOW_DAYS = 14
const MAX_LIKES_PER_POST = 60
const CREDITED_HOUR_CHOICES: readonly number[] = [1.5, 2, 2, 2.5, 2.5, 3, 3, 3.5, 4]

// Mirrors HANDLE_REGEX's length bounds, which validate() enforces on every generated handle.
const HANDLE_MIN_LENGTH = 3
const HANDLE_MAX_LENGTH = 20

// A degree of longitude is shorter than a degree of latitude at LA's latitude, so the jitter is stretched
// east-west to keep points spread in a circle on the ground rather than an ellipse.
const LNG_JITTER_STRETCH = 1.2
const COORDINATE_DECIMALS = 6

const EM_DASH = "\u2014"
const ERROR_BODY_PREVIEW_CHARS = 40
const VALIDATION_ERROR_SAMPLE = 25

const INSERT_CHUNK = {
  users: 200,
  notificationPrefs: 300,
  follows: 500,
  timeline: 500,
  posts: 300,
  postGeom: 500,
  mentions: 500,
  engagement: 800,
  hours: 300,
  rollups: 500,
} as const

// Timestamps get an LA-plausible time-of-day (evenings and weekends heavier), stored as UTC. The
// seeded window spans both PST and PDT, so the offset is resolved per date.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const HOUR_MINUTES = 60
const DAYS_PER_WEEK = 7
const LA_TIME_ZONE = "America/Los_Angeles"
const LA_STANDARD_OFFSET_HOURS = -8
const LA_UTC_OFFSET_RE = /^GMT([+-]\d{1,2})$/
const SUNDAY = 0
const SATURDAY = 6
const TIMESTAMP_ATTEMPTS = 6
const WEEKDAY_KEEP_PROBABILITY = 0.75

const LA_OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  timeZoneName: "shortOffset",
})

function laOffsetHoursAt(at: Date): number {
  const name = LA_OFFSET_FORMAT.formatToParts(at).find((p) => p.type === "timeZoneName")?.value
  const m = LA_UTC_OFFSET_RE.exec(name ?? "")
  return m ? Number(m[1]) : LA_STANDARD_OFFSET_HOURS
}

/** The UTC instant of hour:minute:second LA wall-clock time on the UTC calendar day of `dayMs`. */
export function laLocalToUtc(dayMs: number, hour: number, minute: number, second: number): Date {
  const d = new Date(dayMs)
  const wallAsUtc = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    hour,
    minute,
    second,
  )
  const offset = laOffsetHoursAt(new Date(wallAsUtc - LA_STANDARD_OFFSET_HOURS * HOUR))
  return new Date(wallAsUtc - offset * HOUR)
}

function localHour(): number {
  return pickWeighted<number>([
    [6, 1],
    [7, 3],
    [8, 4],
    [9, 4],
    [10, 4],
    [11, 5],
    [12, 6],
    [13, 5],
    [14, 4],
    [15, 4],
    [16, 5],
    [17, 7],
    [18, 9],
    [19, 10],
    [20, 10],
    [21, 8],
    [22, 5],
    [23, 2],
    [0, 1],
    [1, 1],
  ])
}

function atLocalTime(dayMs: number): Date {
  const hour = localHour()
  const minute = rint(0, 59)
  const second = rint(0, 59)
  return laLocalToUtc(dayMs, hour, minute, second)
}

function randTimestamp(start: Date, end: Date): Date {
  const span = Math.max(end.getTime() - start.getTime(), MINUTE)
  for (let attempt = 0; attempt < TIMESTAMP_ATTEMPTS; attempt++) {
    const t = atLocalTime(start.getTime() + rand() * span)
    if (t.getTime() < start.getTime() || t.getTime() > end.getTime()) continue
    const dow = t.getUTCDay()
    if (dow === SUNDAY || dow === SATURDAY || chance(WEEKDAY_KEEP_PROBABILITY)) return t
  }
  return new Date(start.getTime() + rand() * span)
}

function minutesAfter(d: Date, min: number, max: number): Date {
  return new Date(d.getTime() + rint(min, max) * MINUTE)
}
function later(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

function jitterPoint(lat: number, lng: number, r: number): { lat: number; lng: number } {
  const angle = rand() * Math.PI * 2
  const dist = Math.sqrt(rand()) * r
  return {
    lat: +(lat + Math.sin(angle) * dist).toFixed(COORDINATE_DECIMALS),
    lng: +(lng + Math.cos(angle) * dist * LNG_JITTER_STRETCH).toFixed(COORDINATE_DECIMALS),
  }
}

type Tier = "power" | "casual" | "light" | "lurker"

interface SeedUser {
  id: string
  displayName: string
  handle: string
  email: string
  bio: string | null
  locale: string
  hood: Hood
  tier: Tier
  popularity: number
  hispanic: boolean
  createdAt: Date
  showVolunteerHours: boolean | null
  allowDirectMessages: boolean
  instagram: string | null
  followerCount: number
  followingCount: number
}

interface SeedFollow {
  followerId: string
  followeeId: string
  createdAt: Date
}

interface SeedEvent {
  id: string
  organizer: SeedUser
  cohost: SeedUser | null
  title: string
  description: string
  lat: number
  lng: number
  address: string
  scheduledAt: Date
  endsAt: Date
  createdAt: Date
  status: "upcoming" | "done" | "cancelled"
  bring: string[]
  capacity: number | null
  bags: number
  members: { user: SeedUser; role: "organizer" | "cohost" | "member"; joinedAt: Date }[]
  slots: {
    id: string
    title: string
    description: string | null
    capacity: number | null
    sortOrder: number
  }[]
  claims: { userId: string; slotId: string; claimedAt: Date }[]
  hood: Hood
}

interface SeedReport {
  id: string
  reporter: SeedUser
  type: ReportType
  title: string
  description: string
  addr: string | null
  lat: number
  lng: number
  status: "published" | "acknowledged" | "in_progress" | "resolved" | "submitted"
  createdAt: Date
  publishedAt: Date | null
  geomSource: "device" | "manual"
  timeline: { status: string; note: string | null; createdAt: Date; actorId: string | null }[]
  hood: Hood
}

interface SeedPost {
  id: string
  author: SeedUser
  kind: "post" | "reply" | "quote" | "repost"
  body: string | null
  replyTo: SeedPost | null
  threadRoot: SeedPost | null
  repostOf: SeedPost | null
  eventId: string | null
  reportId: string | null
  createdAt: Date
  depth: number
  likeCount: number
  replyCount: number
  repostCount: number
  saveCount: number
  mentions: string[]
}

interface SeedHours {
  userId: string
  cleanupId: string
  hours: string
  jurisdictionGeoid: string | null
  loggedBy: string
  createdAt: Date
}

function fill(template: string, user: SeedUser, extra?: Record<string, string>): string {
  const streets = user.hood.streets
  const s1 = pick(streets)
  let s2 = pick(streets)
  if (s2 === s1 && streets.length > 1) s2 = streets[(streets.indexOf(s1) + 1) % streets.length]!
  return template
    .replaceAll("{street}", extra?.street ?? s1)
    .replaceAll("{street2}", extra?.street2 ?? s2)
    .replaceAll("{hood}", (extra?.hood ?? user.hood.name).toLowerCase())
    .replaceAll("{park}", extra?.park ?? "")
    .replaceAll("{bags}", extra?.bags ?? "")
    .replaceAll("{n}", extra?.n ?? "")
}

function bilingual(user: SeedUser, en: readonly string[], es: readonly string[]): string {
  const useEs = user.hispanic && es.length > 0 && chance(user.locale === "es" ? 0.55 : 0.18)
  return pick(useEs ? es : en)
}

function pickName(hispanic: boolean, female: boolean): { first: string; last: string } {
  if (hispanic) {
    return {
      first: female ? pick(HISPANIC_FIRST_F) : pick(HISPANIC_FIRST_M),
      last: pick(HISPANIC_LAST),
    }
  }
  const pool = pickWeighted(OTHER_POOLS.map((p) => [p, p.weight] as const))
  const first = female ? pick(pool.firstF) : pick(pool.firstM)
  return { first, last: pick(pool.last) }
}

function displayNameFor(first: string, last: string, hispanic: boolean): string {
  const dFirst = hispanic && chance(0.35) ? (ACCENTED[first] ?? first) : first
  const dLast = hispanic && chance(0.2) ? (ACCENTED[last] ?? last) : last
  const fullName = `${dFirst} ${dLast}`
  // The full name is listed twice on purpose: merging the weights would remap which name each roll picks
  // and so change every cohort generated from a given seed.
  return pickWeighted<string>([
    [fullName, 55],
    [`${dFirst} ${dLast[0]}.`, 15],
    [dFirst, 10],
    [`${dFirst.toLowerCase()} ${dLast.toLowerCase()}`, 10],
    [fullName, 10],
  ])
}

function uniqueHandle(first: string, last: string, usedHandles: Set<string>): string {
  const fl = first.toLowerCase().replace(/[^a-z0-9]/g, "")
  const ll = last.toLowerCase().replace(/[^a-z0-9]/g, "")
  const candidates = [
    `${fl}${ll}`,
    `${fl}_${ll}`,
    `${fl}${ll[0] ?? ""}${rint(1, 99)}`,
    `${fl}_${rint(80, 99)}`,
    `${fl}${ll}${rint(1, 9)}`,
    `${fl}_la`,
    `${fl}${rint(100, 999)}`,
  ]
  for (const c of shuffle(candidates)) {
    const h = c.slice(0, HANDLE_MAX_LENGTH)
    if (h.length >= HANDLE_MIN_LENGTH && !usedHandles.has(h)) return h
  }
  let n = rint(10, 9999)
  while (usedHandles.has(`${fl}${n}`.slice(0, HANDLE_MAX_LENGTH))) n++
  return `${fl}${n}`.slice(0, HANDLE_MAX_LENGTH)
}

function popularityFor(tier: Tier): number {
  return (
    Math.exp((rand() + rand() + rand() - 1.5) * 1.6) *
    (tier === "power" ? 3 : tier === "casual" ? 1.2 : 0.6)
  )
}

function bioFor(user: SeedUser, female: boolean): string {
  const bioPool: string[] = [...BIO_NEUTRAL, ...(female ? BIO_FEMALE : BIO_MALE)]
  if (user.hispanic) {
    bioPool.push(...BIO_HISPANIC_NEUTRAL, ...(female ? BIO_HISPANIC_F : BIO_HISPANIC_M))
  }
  return fill(pick(bioPool), user, { street: pick(user.hood.streets) })
}

function makeUsers(count: number, start: Date, end: Date): SeedUser[] {
  const usedHandles = new Set<string>()
  const users: SeedUser[] = []
  for (let i = 0; i < count; i++) {
    const hispanic = chance(0.7)
    const female = chance(0.52)
    const { first, last } = pickName(hispanic, female)
    const displayName = displayNameFor(first, last, hispanic)
    const handle = uniqueHandle(first, last, usedHandles)
    usedHandles.add(handle)

    const hood = pickWeighted(HOODS.map((h) => [h, h.weight] as const))
    const tier = pickWeighted<Tier>([
      ["power", 15],
      ["casual", 45],
      ["light", 28],
      ["lurker", 12],
    ])
    const popularity = popularityFor(tier)

    const user: SeedUser = {
      id: randomUUID(),
      displayName,
      handle,
      email: `${handle.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`,
      bio: null,
      locale: hispanic ? (chance(0.3) ? "es" : "en") : chance(0.05) ? "ko" : "en",
      hood,
      tier,
      popularity,
      hispanic,
      createdAt: randTimestamp(
        start,
        new Date(start.getTime() + Math.pow(rand(), 0.65) * (end.getTime() - start.getTime())),
      ),
      showVolunteerHours: chance(0.85) ? null : chance(0.8) ? true : false,
      allowDirectMessages: chance(0.95),
      instagram: chance(0.15) ? handle.toLowerCase() : null,
      followerCount: 0,
      followingCount: 0,
    }
    if (chance(0.62)) user.bio = bioFor(user, female)
    users.push(user)
  }
  return users
}

function makeFollows(users: SeedUser[], now: Date): SeedFollow[] {
  const edges = new Map<string, SeedFollow>()
  const key = (a: string, b: string) => `${a}>${b}`
  const weightFor = (follower: SeedUser) => (candidate: SeedUser) =>
    candidate.popularity * (candidate.hood.name === follower.hood.name ? 3 : 1)

  for (const u of users) {
    const target =
      u.tier === "power"
        ? rint(15, 40)
        : u.tier === "casual"
          ? rint(6, 18)
          : u.tier === "light"
            ? rint(3, 10)
            : rint(0, 4)
    const followees = sampleWeighted(users, weightFor(u), target, new Set([u]))
    for (const f of followees) {
      const at = randTimestamp(later(u.createdAt, f.createdAt), now)
      edges.set(key(u.id, f.id), { followerId: u.id, followeeId: f.id, createdAt: at })
    }
  }
  for (const e of [...edges.values()]) {
    if (!chance(0.3)) continue
    const back = key(e.followeeId, e.followerId)
    if (edges.has(back)) continue
    edges.set(back, {
      followerId: e.followeeId,
      followeeId: e.followerId,
      createdAt: randTimestamp(e.createdAt, now),
    })
  }
  const list = [...edges.values()]
  const byId = new Map(users.map((u) => [u.id, u]))
  for (const e of list) {
    byId.get(e.followeeId)!.followerCount++
    byId.get(e.followerId)!.followingCount++
  }
  return list
}

function eventScheduledAt(kind: SeedEvent["status"], organizer: SeedUser, now: Date): Date {
  if (kind === "upcoming") return nextSaturdayish(now, rint(3, 21))
  return nextSaturdayish(
    new Date(
      later(organizer.createdAt, new Date(now.getTime() - EVENT_HISTORY_DAYS * DAY)).getTime(),
    ),
    rint(7, 120),
    now,
  )
}

/**
 * The create must land in the PAST even for upcoming events (scheduled_at minus the lead can exceed now
 * when the event is less than that lead away, which would backdate joins into the future).
 */
function eventCreatedAt(organizer: SeedUser, scheduledAt: Date, now: Date): Date {
  const createdCeiling = new Date(
    Math.min(
      scheduledAt.getTime() - EVENT_MIN_CREATE_LEAD_DAYS * DAY,
      now.getTime() - EVENT_MIN_AGE_HOURS * HOUR,
    ),
  )
  return randTimestamp(
    later(organizer.createdAt, new Date(scheduledAt.getTime() - EVENT_MAX_CREATE_LEAD_DAYS * DAY)),
    createdCeiling,
  )
}

function addEventMembers(ev: SeedEvent, users: SeedUser[], joinEnd: Date): void {
  const memberTarget = ev.status === "cancelled" ? rint(3, 8) : rint(6, 26)
  const weight = (c: SeedUser) =>
    (c.hood.name === ev.hood.name ? 4 : 1) *
    (c.tier === "lurker" ? 0.3 : 1) *
    Math.sqrt(c.popularity)
  const joiners = sampleWeighted(users, weight, memberTarget, new Set([ev.organizer]))
  for (const [j, u] of joiners.entries()) {
    const joinedAt = randTimestamp(later(u.createdAt, ev.createdAt), joinEnd)
    const role = j === 0 && chance(0.4) ? "cohost" : "member"
    if (role === "cohost") ev.cohost = u
    ev.members.push({ user: u, role, joinedAt })
  }
}

/**
 * A richer board on ~40% of events and 0169's default slot on every other OPEN one (past and cancelled
 * keep the empty board it skips).
 */
function eventSlots(ev: SeedEvent): SeedEvent["slots"] {
  if (chance(0.4)) {
    const set = pick(SLOT_SETS)
    return set.map((s, idx) => ({ id: randomUUID(), ...s, sortOrder: idx }))
  }
  if (ev.status !== "upcoming") return []
  return [
    {
      id: randomUUID(),
      title: DEFAULT_EVENT_SLOT_TITLE,
      description: null,
      capacity: ev.capacity,
      sortOrder: 0,
    },
  ]
}

/** Claims come from members only, one per member, with slot capacity respected. */
function addSlotClaims(ev: SeedEvent, joinEnd: Date): void {
  if (ev.slots.length === 0) return
  const claimed = new Set<string>()
  for (const m of ev.members) {
    if (m.role === "organizer" || !chance(0.5)) continue
    const open = ev.slots.filter(
      (s) => s.capacity === null || ev.claims.filter((c) => c.slotId === s.id).length < s.capacity,
    )
    if (open.length === 0 || claimed.has(m.user.id)) continue
    const slot = pick(open)
    claimed.add(m.user.id)
    ev.claims.push({
      userId: m.user.id,
      slotId: slot.id,
      claimedAt: randTimestamp(m.joinedAt, joinEnd),
    })
  }
}

function makeEvents(users: SeedUser[], now: Date): SeedEvent[] {
  const organizers = shuffle(users.filter((u) => u.tier === "power")).slice(
    0,
    EVENT_ORGANIZER_COUNT,
  )
  const events: SeedEvent[] = []
  const parkPool = shuffle([...PARKS])
  for (let i = 0; i < EVENT_COUNT; i++) {
    const organizer = organizers[i % organizers.length]!
    const park = parkPool[i % parkPool.length]!
    const hood = hoodByName(park.hood)
    const kind: SeedEvent["status"] =
      i < PAST_EVENT_COUNT ? "done" : i === PAST_EVENT_COUNT ? "cancelled" : "upcoming"
    const scheduledAt = eventScheduledAt(kind, organizer, now)
    const createdAt = eventCreatedAt(organizer, scheduledAt, now)
    const { lat, lng } = jitterPoint(park.lat, park.lng, EVENT_SITE_JITTER_DEG)
    const title = fill(bilingual(organizer, EVENT_TITLE_EN, EVENT_TITLE_ES), organizer, {
      park: park.name,
      hood: hood.name,
      street: pick(hood.streets),
    })
    const ev: SeedEvent = {
      id: randomUUID(),
      organizer,
      cohost: null,
      title,
      description: bilingual(organizer, EVENT_DESC_EN, EVENT_DESC_ES),
      lat,
      lng,
      address: park.name,
      scheduledAt,
      endsAt: new Date(scheduledAt.getTime() + DEFAULT_EVENT_DURATION_MS),
      createdAt,
      status: kind,
      bring: shuffle([...BRING_POOL]).slice(0, rint(2, 5)),
      capacity: chance(0.3) ? rint(20, 50) : null,
      bags: kind === "done" ? rint(6, 42) : 0,
      members: [{ user: organizer, role: "organizer", joinedAt: createdAt }],
      slots: [],
      claims: [],
      hood,
    }

    const joinEnd = kind === "upcoming" ? now : scheduledAt
    addEventMembers(ev, users, joinEnd)
    ev.slots = eventSlots(ev)
    addSlotClaims(ev, joinEnd)
    events.push(ev)
  }
  return events
}

function nextSaturdayish(base: Date, minDays: number, latest?: Date): Date {
  let d = new Date(base.getTime() + minDays * DAY)
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const dow = new Date(d.getTime() + i * DAY).getUTCDay()
    if (dow === SATURDAY || (dow === SUNDAY && chance(0.4))) {
      d = new Date(d.getTime() + i * DAY)
      break
    }
  }
  if (latest && d.getTime() >= latest.getTime()) d = new Date(latest.getTime() - DAY)
  return laLocalToUtc(d.getTime(), EVENT_START_HOUR, pick([0, 0, 30]), 0)
}

function reportTimeline(
  status: SeedReport["status"],
  reporter: SeedUser,
  createdAt: Date,
  now: Date,
): { timeline: SeedReport["timeline"]; publishedAt: Date | null } {
  const timeline: SeedReport["timeline"] = [
    { status: "submitted", note: null, createdAt, actorId: reporter.id },
  ]
  let publishedAt: Date | null = null
  if (status !== "submitted") {
    publishedAt = minutesAfter(createdAt, 1, 10)
    timeline.push({ status: "published", note: null, createdAt: publishedAt, actorId: null })
  }
  let cursor = publishedAt ?? createdAt
  const nextStep = (maxDays: number): Date =>
    randTimestamp(cursor, new Date(Math.min(cursor.getTime() + maxDays * DAY, now.getTime())))
  if (status === "acknowledged" || status === "in_progress" || status === "resolved") {
    cursor = nextStep(10)
    timeline.push({
      status: "acknowledged",
      note: pick(TIMELINE_ACK_NOTES),
      createdAt: cursor,
      actorId: null,
    })
  }
  if (status === "in_progress" || (status === "resolved" && chance(0.5))) {
    cursor = nextStep(12)
    timeline.push({ status: "in_progress", note: null, createdAt: cursor, actorId: null })
  }
  if (status === "resolved") {
    cursor = nextStep(15)
    timeline.push({
      status: "resolved",
      note: chance(0.6) ? pick(TIMELINE_RESOLVE_NOTES) : null,
      createdAt: cursor,
      actorId: null,
    })
  }
  return { timeline, publishedAt }
}

function reporterWeight(u: SeedUser): number {
  return u.tier === "power" ? 4 : u.tier === "casual" ? 2 : u.tier === "light" ? 1 : 0.2
}

function makeReports(users: SeedUser[], count: number, now: Date): SeedReport[] {
  const reports: SeedReport[] = []
  for (let i = 0; i < count; i++) {
    const reporter = pickWeighted(users.map((u) => [u, reporterWeight(u)] as const))
    const hood = chance(0.85)
      ? reporter.hood
      : pickWeighted(HOODS.map((h) => [h, h.weight] as const))
    const type = pickWeighted<ReportType>([
      ["dump", 38],
      ["graffiti", 16],
      ["pavement", 14],
      ["vegetation", 9],
      ["infrastructure", 9],
      ["encampment", 6],
      ["other", 8],
    ])
    const { lat, lng } = jitterPoint(hood.lat, hood.lng, hood.r)
    const content = REPORT_CONTENT[type]
    const street = pick(hood.streets)
    const street2 = pick(hood.streets.filter((s) => s !== street)) ?? street
    const createdAt = randTimestamp(reporter.createdAt, now)
    const status = pickWeighted<SeedReport["status"]>([
      ["published", 52],
      ["acknowledged", 15],
      ["in_progress", 8],
      ["resolved", 20],
      ["submitted", 5],
    ])
    const { timeline, publishedAt } = reportTimeline(status, reporter, createdAt, now)

    reports.push({
      id: randomUUID(),
      reporter,
      type,
      title: pick(content.titles).replaceAll("{street}", street).replaceAll("{street2}", street2),
      description: bilingual(reporter, content.descs, content.descsEs ?? [])
        .replaceAll("{street}", street)
        .replaceAll("{street2}", street2),
      addr: chance(0.88) ? `${rint(100, 9899)} ${street}` : null,
      lat,
      lng,
      status,
      createdAt,
      publishedAt,
      geomSource: chance(0.8) ? "device" : "manual",
      timeline,
      hood,
    })
  }
  return reports
}

function followersIndex(users: SeedUser[], follows: SeedFollow[]): Map<string, SeedUser[]> {
  const byId = new Map(users.map((u) => [u.id, u]))
  const followersOf = new Map<string, SeedUser[]>()
  for (const f of follows) {
    const arr = followersOf.get(f.followeeId) ?? []
    arr.push(byId.get(f.followerId)!)
    followersOf.set(f.followeeId, arr)
  }
  return followersOf
}

type PostLinks = Partial<
  Pick<SeedPost, "replyTo" | "threadRoot" | "repostOf" | "eventId" | "reportId" | "mentions">
>

function seedPost(
  fields: Pick<SeedPost, "author" | "kind" | "body" | "createdAt" | "depth"> & PostLinks,
): SeedPost {
  return {
    id: randomUUID(),
    replyTo: null,
    threadRoot: null,
    repostOf: null,
    eventId: null,
    reportId: null,
    mentions: [],
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    saveCount: 0,
    ...fields,
  }
}

type AddTopPost = (
  author: SeedUser,
  body: string,
  createdAt: Date,
  eventId: string | null,
  reportId: string | null,
) => SeedPost

function authorPostCount(u: SeedUser): number {
  return u.tier === "power"
    ? rint(4, 10)
    : u.tier === "casual"
      ? rint(1, 4)
      : u.tier === "light"
        ? rint(0, 2)
        : 0
}

function addAuthorPosts(users: SeedUser[], now: Date, addTop: AddTopPost): void {
  for (const u of users) {
    const n = authorPostCount(u)
    for (let i = 0; i < n; i++) {
      addTop(
        u,
        fill(bilingual(u, POST_TEMPLATES_EN, POST_TEMPLATES_ES), u),
        randTimestamp(u.createdAt, now),
        null,
        null,
      )
    }
  }
}

function addEventPosts(events: SeedEvent[], now: Date, addTop: AddTopPost): void {
  for (const ev of events) {
    if (ev.status !== "cancelled") {
      const promoAt = randTimestamp(
        ev.createdAt,
        new Date(Math.min(ev.scheduledAt.getTime(), now.getTime())),
      )
      addTop(
        ev.organizer,
        fill(bilingual(ev.organizer, EVENT_POST_EN, EVENT_POST_ES), ev.organizer, {
          hood: ev.hood.name,
        }),
        promoAt,
        ev.id,
        null,
      )
      if (ev.cohost && chance(0.4)) {
        addTop(
          ev.cohost,
          fill(bilingual(ev.cohost, EVENT_POST_EN, EVENT_POST_ES), ev.cohost, {
            hood: ev.hood.name,
          }),
          randTimestamp(
            later(ev.cohost.createdAt, ev.createdAt),
            new Date(Math.min(ev.scheduledAt.getTime(), now.getTime())),
          ),
          ev.id,
          null,
        )
      }
    }
    if (ev.status === "done" && chance(0.85)) {
      const recapAt = minutesAfter(ev.scheduledAt, 3 * HOUR_MINUTES, 30 * HOUR_MINUTES)
      if (recapAt.getTime() < now.getTime()) {
        addTop(
          ev.organizer,
          fill(bilingual(ev.organizer, EVENT_RECAP_EN, EVENT_RECAP_ES), ev.organizer, {
            bags: String(ev.bags),
            n: String(ev.members.length),
          }),
          recapAt,
          ev.id,
          null,
        )
      }
    }
  }
}

function addReportPosts(reports: SeedReport[], now: Date, addTop: AddTopPost): void {
  for (const r of reports) {
    if (r.status === "submitted" || !chance(0.3)) continue
    const at = minutesAfter(r.publishedAt ?? r.createdAt, 5, 36 * HOUR_MINUTES)
    if (at.getTime() >= now.getTime()) continue
    addTop(
      r.reporter,
      fill(bilingual(r.reporter, REPORT_POST_EN, REPORT_POST_ES), r.reporter, {
        street: r.hood.streets[0]!,
      }),
      at,
      null,
      r.id,
    )
  }
}

function replyPools(parent: SeedPost): readonly [readonly string[], readonly string[]] {
  if (parent.eventId) return [REPLY_EVENT_EN, REPLY_EVENT_ES]
  if (parent.reportId) return [REPLY_REPORT_EN, REPLY_REPORT_ES]
  return [REPLY_GENERIC_EN, REPLY_GENERIC_ES]
}

/**
 * One reply per person per thread (the root author may answer their own thread), and no repeated body
 * text within a thread; both read as bots otherwise.
 */
function addThreadReplies(
  posts: SeedPost[],
  root: SeedPost,
  users: SeedUser[],
  followersOf: Map<string, SeedUser[]>,
  now: Date,
): void {
  const base = root.eventId ? 2.2 : root.reportId ? 1.6 : 1
  const n = Math.min(
    MAX_REPLIES_PER_THREAD,
    Math.floor(Math.pow(rand(), 1.8) * 7 * base * Math.sqrt(root.author.popularity)),
  )
  const threadRepliers = new Set<string>()
  const threadBodies = new Set<string>()
  let parent: SeedPost = root
  for (let i = 0; i < n; i++) {
    parent = chance(0.75)
      ? root
      : posts[posts.length - 1]!.depth > 0 && chance(0.5)
        ? posts[posts.length - 1]!
        : root
    if (parent.depth >= MAX_REPLY_DEPTH) parent = root
    const followerPool = followersOf.get(parent.author.id) ?? []
    const replier =
      parent.depth > 0 && parent.author.id !== root.author.id && chance(0.4)
        ? root.author
        : followerPool.length > 0 && chance(0.65)
          ? pick(followerPool)
          : pickWeighted(users.map((u) => [u, u.tier === "lurker" ? 0.2 : 1] as const))
    if (replier.id === parent.author.id) continue
    if (replier.id !== root.author.id && threadRepliers.has(replier.id)) continue
    const start = later(replier.createdAt, parent.createdAt)
    const end = new Date(
      Math.min(parent.createdAt.getTime() + REPLY_WINDOW_DAYS * DAY, now.getTime()),
    )
    if (start.getTime() >= end.getTime()) continue
    const [poolEn, poolEs] = replyPools(parent)
    let body = fill(bilingual(replier, poolEn, poolEs), replier)
    if (threadBodies.has(body)) continue
    threadBodies.add(body)
    threadRepliers.add(replier.id)
    const mentions: string[] = []
    if (parent.depth > 0 && chance(0.3)) {
      body = `@${parent.author.handle} ${body}`
      mentions.push(parent.author.id)
    }
    const reply = seedPost({
      author: replier,
      kind: "reply",
      body,
      replyTo: parent,
      threadRoot: parent.depth === 0 ? parent : (parent.threadRoot ?? parent),
      createdAt: randTimestamp(start, end),
      depth: parent.depth + 1,
      mentions,
    })
    parent.replyCount++
    posts.push(reply)
  }
}

function reshareWindow(
  sharer: SeedUser,
  target: SeedPost,
  now: Date,
): { start: Date; end: Date } | null {
  const start = later(sharer.createdAt, target.createdAt)
  const end = new Date(
    Math.min(target.createdAt.getTime() + RESHARE_WINDOW_DAYS * DAY, now.getTime()),
  )
  return start.getTime() >= end.getTime() ? null : { start, end }
}

function addRepostsAndQuotes(
  posts: SeedPost[],
  topLevel: SeedPost[],
  followersOf: Map<string, SeedUser[]>,
  now: Date,
): void {
  const repostKeys = new Set<string>()
  const popularTargets = topLevel.filter(
    (p) => (followersOf.get(p.author.id)?.length ?? 0) >= MIN_FOLLOWERS_TO_RESHARE,
  )
  for (const target of popularTargets) {
    const nReposts = chance(0.16) ? rint(1, 3) : 0
    const nQuotes = chance(0.07) ? rint(1, 2) : 0
    const pool = followersOf.get(target.author.id) ?? []
    for (let i = 0; i < nReposts && pool.length > 0; i++) {
      const reposter = pick(pool)
      const k = `${reposter.id}:${target.id}`
      if (reposter.id === target.author.id || repostKeys.has(k)) continue
      const window = reshareWindow(reposter, target, now)
      if (window === null) continue
      repostKeys.add(k)
      posts.push(
        seedPost({
          author: reposter,
          kind: "repost",
          body: null,
          repostOf: target,
          createdAt: randTimestamp(window.start, window.end),
          depth: 1,
        }),
      )
      target.repostCount++ // pure reposts only, matching the live repost() path
    }
    for (let i = 0; i < nQuotes && pool.length > 0; i++) {
      const quoter = pick(pool)
      if (quoter.id === target.author.id) continue
      const window = reshareWindow(quoter, target, now)
      if (window === null) continue
      posts.push(
        seedPost({
          author: quoter,
          kind: "quote",
          body: fill(bilingual(quoter, QUOTE_EN, QUOTE_ES), quoter),
          repostOf: target,
          createdAt: randTimestamp(window.start, window.end),
          depth: 1,
        }),
      )
      // Quotes do NOT bump repost_count (createPost has no bump for kind='quote').
    }
  }
}

function makePosts(
  users: SeedUser[],
  events: SeedEvent[],
  reports: SeedReport[],
  follows: SeedFollow[],
  now: Date,
): SeedPost[] {
  const posts: SeedPost[] = []
  const followersOf = followersIndex(users, follows)
  const addTop: AddTopPost = (author, body, createdAt, eventId, reportId) => {
    const p = seedPost({ author, kind: "post", body, createdAt, depth: 0, eventId, reportId })
    posts.push(p)
    return p
  }

  addAuthorPosts(users, now, addTop)
  addEventPosts(events, now, addTop)
  addReportPosts(reports, now, addTop)

  const topLevel = posts.filter((p) => p.depth === 0)
  for (const root of topLevel) addThreadReplies(posts, root, users, followersOf, now)
  addRepostsAndQuotes(posts, topLevel, followersOf, now)
  return posts
}

interface SeedLike {
  postId: string
  userId: string
  createdAt: Date
}

function makeLikesAndSaves(
  users: SeedUser[],
  posts: SeedPost[],
  follows: SeedFollow[],
  now: Date,
): { likes: SeedLike[]; saves: SeedLike[] } {
  const followersOf = followersIndex(users, follows)
  const likes: SeedLike[] = []
  const saves: SeedLike[] = []
  const likeKeys = new Set<string>()
  const saveKeys = new Set<string>()

  for (const p of posts) {
    if (p.kind === "repost") continue // the app shows the original; likes land on it
    const followerPool = followersOf.get(p.author.id) ?? []
    const reach = followerPool.length
    const base =
      Math.pow(rand(), 1.5) *
      (3 + reach * 0.7) *
      (p.eventId || p.reportId ? 1.4 : 1) *
      (p.depth === 0 ? 1 : 0.35)
    const n = Math.min(Math.floor(base), MAX_LIKES_PER_POST)
    for (let i = 0; i < n; i++) {
      const liker =
        followerPool.length > 0 && chance(0.7)
          ? pick(followerPool)
          : pickWeighted(users.map((u) => [u, u.tier === "lurker" ? 0.6 : 1] as const))
      if (liker.id === p.author.id) continue
      const k = `${p.id}:${liker.id}`
      if (likeKeys.has(k)) continue
      const start = later(liker.createdAt, p.createdAt)
      const end = new Date(Math.min(p.createdAt.getTime() + LIKE_WINDOW_DAYS * DAY, now.getTime()))
      if (start.getTime() >= end.getTime()) continue
      likeKeys.add(k)
      likes.push({ postId: p.id, userId: liker.id, createdAt: randTimestamp(start, end) })
      p.likeCount++
      if (chance(0.06) && !saveKeys.has(k)) {
        saveKeys.add(k)
        saves.push({ postId: p.id, userId: liker.id, createdAt: randTimestamp(start, end) })
        p.saveCount++
      }
    }
  }
  return { likes, saves }
}

function makeHours(events: SeedEvent[], now: Date): SeedHours[] {
  const rows: SeedHours[] = []
  for (const ev of events) {
    if (ev.status !== "done") continue
    const loggedAt = minutesAfter(ev.scheduledAt, 4 * HOUR_MINUTES, 48 * HOUR_MINUTES)
    if (loggedAt.getTime() >= now.getTime()) continue
    for (const m of ev.members) {
      if (m.role !== "organizer" && !chance(0.85)) continue // a few no-shows never get credited
      const hours = pick(CREDITED_HOUR_CHOICES).toFixed(2)
      rows.push({
        userId: m.user.id,
        cleanupId: ev.id,
        hours,
        jurisdictionGeoid: null, // stamped after event jurisdiction resolution
        loggedBy: ev.organizer.id,
        createdAt: minutesAfter(loggedAt, 0, 20),
      })
    }
  }
  return rows
}

function validateUsers(users: SeedUser[], errors: string[]): void {
  const handles = new Set<string>()
  const emails = new Set<string>()
  for (const u of users) {
    if (!HANDLE_REGEX.test(u.handle)) errors.push(`bad handle: ${u.handle}`)
    if (handles.has(u.handle.toLowerCase())) errors.push(`dup handle: ${u.handle}`)
    handles.add(u.handle.toLowerCase())
    if (emails.has(u.email)) errors.push(`dup email: ${u.email}`)
    emails.add(u.email)
    if (!u.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`))
      errors.push(`email outside demo domain: ${u.email}`)
  }
}

function validateFollows(users: SeedUser[], follows: SeedFollow[], errors: string[]): void {
  const ids = new Set(users.map((u) => u.id))
  const followerCounts = new Map<string, number>()
  const followingCounts = new Map<string, number>()
  const edgeKeys = new Set<string>()
  for (const f of follows) {
    if (!ids.has(f.followerId) || !ids.has(f.followeeId)) errors.push("follow edge escapes cohort")
    if (f.followerId === f.followeeId) errors.push("self follow")
    const k = `${f.followerId}>${f.followeeId}`
    if (edgeKeys.has(k)) errors.push("duplicate follow edge")
    edgeKeys.add(k)
    followerCounts.set(f.followeeId, (followerCounts.get(f.followeeId) ?? 0) + 1)
    followingCounts.set(f.followerId, (followingCounts.get(f.followerId) ?? 0) + 1)
  }
  for (const u of users) {
    if ((followerCounts.get(u.id) ?? 0) !== u.followerCount)
      errors.push(`followerCount drift for @${u.handle}`)
    if ((followingCounts.get(u.id) ?? 0) !== u.followingCount)
      errors.push(`followingCount drift for @${u.handle}`)
  }
}

function countBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1)
  return counts
}

function validatePosts(
  posts: SeedPost[],
  likes: SeedLike[],
  saves: SeedLike[],
  errors: string[],
): void {
  const likeAgg = countBy(likes, (l) => l.postId)
  const saveAgg = countBy(saves, (s) => s.postId)
  const replyAgg = new Map<string, number>()
  const repostAgg = new Map<string, number>()
  const repostKeys = new Set<string>()
  for (const p of posts) {
    if (p.body && p.body.includes(EM_DASH))
      errors.push(`em dash in post body: ${p.body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`)
    if (p.kind === "reply") {
      if (!p.replyTo || !p.threadRoot) errors.push("reply missing parent/root")
      else {
        if (p.createdAt.getTime() < p.replyTo.createdAt.getTime())
          errors.push("reply predates parent")
        replyAgg.set(p.replyTo.id, (replyAgg.get(p.replyTo.id) ?? 0) + 1)
      }
    }
    if (p.kind === "repost") {
      const k = `${p.author.id}:${p.repostOf!.id}`
      if (repostKeys.has(k)) errors.push("duplicate repost")
      repostKeys.add(k)
      repostAgg.set(p.repostOf!.id, (repostAgg.get(p.repostOf!.id) ?? 0) + 1)
    }
    if (p.createdAt.getTime() < p.author.createdAt.getTime())
      errors.push("post predates its author")
  }
  for (const p of posts) {
    if ((likeAgg.get(p.id) ?? 0) !== p.likeCount) errors.push("likeCount drift")
    if ((saveAgg.get(p.id) ?? 0) !== p.saveCount) errors.push("saveCount drift")
    if ((replyAgg.get(p.id) ?? 0) !== p.replyCount) errors.push("replyCount drift")
    if ((repostAgg.get(p.id) ?? 0) !== p.repostCount) errors.push("repostCount drift")
  }
}

function validateEvents(events: SeedEvent[], errors: string[]): void {
  for (const ev of events) {
    const seen = new Set<string>()
    for (const m of ev.members) {
      if (seen.has(m.user.id)) errors.push(`dup member in ${ev.title}`)
      seen.add(m.user.id)
      if (m.joinedAt.getTime() < ev.createdAt.getTime())
        errors.push("member joined before event existed")
    }
    const claimants = new Set<string>()
    for (const c of ev.claims) {
      if (claimants.has(c.userId)) errors.push("user claimed two slots on one event")
      claimants.add(c.userId)
      if (!seen.has(c.userId)) errors.push("slot claim from non-member")
    }
    for (const s of ev.slots) {
      if (s.capacity !== null && ev.claims.filter((c) => c.slotId === s.id).length > s.capacity)
        errors.push(`slot over capacity: ${s.title}`)
    }
  }
}

function validateReports(reports: SeedReport[], errors: string[]): void {
  for (const r of reports) {
    for (let i = 1; i < r.timeline.length; i++) {
      if (r.timeline[i]!.createdAt.getTime() < r.timeline[i - 1]!.createdAt.getTime())
        errors.push("timeline out of order")
    }
    if (r.description.includes(EM_DASH) || r.title.includes(EM_DASH))
      errors.push("em dash in report")
  }
}

function validate(
  users: SeedUser[],
  follows: SeedFollow[],
  events: SeedEvent[],
  reports: SeedReport[],
  posts: SeedPost[],
  likes: SeedLike[],
  saves: SeedLike[],
): void {
  const errors: string[] = []
  validateUsers(users, errors)
  validateFollows(users, follows, errors)
  validatePosts(posts, likes, saves, errors)
  validateEvents(events, errors)
  validateReports(reports, errors)
  if (errors.length > 0) {
    throw new Error(
      `seed validation failed (${errors.length}):\n  ${[...new Set(errors)].slice(0, VALIDATION_ERROR_SAMPLE).join("\n  ")}`,
    )
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface SeedData {
  now: Date
  hashFor: (seatId: string) => string
  users: SeedUser[]
  follows: SeedFollow[]
  events: SeedEvent[]
  reports: SeedReport[]
  posts: SeedPost[]
  likes: SeedLike[]
  saves: SeedLike[]
  hours: SeedHours[]
}

async function writeUsers(tx: TransactionSql, users: SeedUser[]): Promise<void> {
  for (const rows of chunk(users, INSERT_CHUNK.users)) {
    await tx`INSERT INTO users ${tx(
      rows.map((u) => ({
        id: u.id,
        role: "citizen",
        display_name: u.displayName,
        handle: u.handle,
        email: u.email,
        email_verified: true,
        bio: u.bio,
        locale: u.locale,
        profile_complete: true,
        allow_direct_messages: u.allowDirectMessages,
        show_volunteer_hours: u.showVolunteerHours,
        follower_count: u.followerCount,
        following_count: u.followingCount,
        created_at: u.createdAt,
      })),
    )}`
  }
  for (const u of users) {
    if (u.instagram) {
      await tx`UPDATE users SET social_links = ${tx.json({ instagram: u.instagram })} WHERE id = ${u.id}`
    }
  }
  for (const rows of chunk(users, INSERT_CHUNK.notificationPrefs)) {
    await tx`INSERT INTO notification_prefs ${tx(
      rows.map((u) => ({
        user_id: u.id,
        push: chance(0.9),
        cleanup_chat: true,
        report_updates: true,
        follows: chance(0.95),
        mentions: true,
        post_interactions: chance(0.9),
      })),
    )}`
  }
}

async function writeFollows(tx: TransactionSql, follows: SeedFollow[]): Promise<void> {
  for (const rows of chunk(follows, INSERT_CHUNK.follows)) {
    await tx`INSERT INTO follows_people ${tx(
      rows.map((f) => ({
        follower_id: f.followerId,
        followee_id: f.followeeId,
        created_at: f.createdAt,
      })),
    )}`
  }
}

/** Also stamps each event's resolved jurisdiction onto its volunteer-hours rows. */
async function writeEvents(
  tx: TransactionSql,
  events: SeedEvent[],
  hours: SeedHours[],
): Promise<void> {
  // Per row, with the reference-code counter allocated first as in createCleanupTx (lock order).
  for (const ev of events) {
    const jur = await resolveJurisdiction(tx, ev.lng, ev.lat)
    const jurCode = await resolveJurisdictionCode(tx, jur?.geoid ?? null)
    const referenceCode = await allocateEventReferenceCode(tx, jurCode)
    await tx`
      INSERT INTO cleanups (
        id, organizer_user_id, type, event_kind, title, description, geom, scheduled_at, ends_at,
        status, bring, address, address_source, capacity, bags, jurisdiction_geoid, reference_code,
        created_at
      ) VALUES (
        ${ev.id}, ${ev.organizer.id}, 'site', 'cleanup', ${ev.title}, ${ev.description},
        ST_SetSRID(ST_MakePoint(${ev.lng}, ${ev.lat}), 4326),
        ${ev.scheduledAt}, ${ev.endsAt},
        ${ev.status === "cancelled" ? "cancelled" : "upcoming"},
        ${ev.bring}, ${ev.address}, ${SEEDED_EVENT_ADDRESS_SOURCE}, ${ev.capacity}, ${ev.bags},
        ${jur?.geoid ?? null}, ${referenceCode}, ${ev.createdAt}
      )
    `
    await touchUserActivity(tx, {
      userId: ev.organizer.id,
      lng: ev.lng,
      lat: ev.lat,
      at: ev.createdAt,
    })
    for (const h of hours) if (h.cleanupId === ev.id) h.jurisdictionGeoid = jur?.geoid ?? null
  }
}

async function writeEventRosters(
  tx: TransactionSql,
  events: SeedEvent[],
  now: Date,
  hashFor: (seatId: string) => string,
): Promise<void> {
  for (const ev of events) {
    await tx`INSERT INTO cleanup_members ${tx(
      ev.members.map((m) => ({
        cleanup_id: ev.id,
        user_id: m.user.id,
        role: m.role,
        joined_at: m.joinedAt,
      })),
    )}`
    if (ev.slots.length > 0) {
      await tx`INSERT INTO cleanup_slots ${tx(
        ev.slots.map((s) => ({
          id: s.id,
          cleanup_id: ev.id,
          title: s.title,
          description: s.description,
          capacity: s.capacity,
          sort_order: s.sortOrder,
          created_at: ev.createdAt,
        })),
      )}`
    }
    // Same scope as the signup-seat backfill: a seat matters only while the event can still be
    // checked into, so events that ended or were cancelled keep membership alone.
    if (ev.status !== "cancelled" && ev.endsAt.getTime() > now.getTime()) {
      await mintDemoSignupSeats(tx, {
        cleanupId: ev.id,
        members: ev.members.map((m) => ({ user_id: m.user.id, joined_at: m.joinedAt })),
        hashFor,
      })
    }
    if (ev.claims.length > 0) {
      await tx`INSERT INTO cleanup_slot_claims ${tx(
        ev.claims.map((c) => ({
          cleanup_id: ev.id,
          user_id: c.userId,
          slot_id: c.slotId,
          claimed_at: c.claimedAt,
        })),
      )}`
    }
  }
}

async function writeReports(tx: TransactionSql, reports: SeedReport[]): Promise<void> {
  // Per row, with the reference-code counter allocated first (lock order).
  for (const r of reports) {
    const jur = await resolveJurisdiction(tx, r.lng, r.lat)
    const jurCode = await resolveJurisdictionCode(tx, jur?.geoid ?? null)
    const referenceCode = await allocateReportReferenceCode(tx, r.type, jurCode)
    await tx`
      INSERT INTO reports (
        id, reporter_user_id, idempotency_key, geom, geom_source, jurisdiction_geoid, category, type,
        title, description, addr, addr_source, status, visibility, h3_cell, reference_code,
        created_at, published_at
      ) VALUES (
        ${r.id}, ${r.reporter.id}, ${randomUUID()},
        ST_SetSRID(ST_MakePoint(${r.lng}, ${r.lat}), 4326),
        ${r.geomSource}, ${jur?.geoid ?? null}, ${REPORT_TYPE_TO_CATEGORY[r.type]}, ${r.type},
        ${r.title}, ${r.description}, ${r.addr}, ${r.addr === null ? null : SEEDED_REPORT_ADDR_SOURCE},
        ${r.status}, 'public', ${reportH3Cell(r.lat, r.lng)}, ${referenceCode}, ${r.createdAt},
        ${r.publishedAt}
      )
    `
    await touchUserActivity(tx, { userId: r.reporter.id, lng: r.lng, lat: r.lat, at: r.createdAt })
  }
  const timelineRows = reports.flatMap((r) =>
    r.timeline.map((t) => ({
      report_id: r.id,
      status: t.status,
      note: t.note,
      actor_id: t.actorId,
      created_at: t.createdAt,
    })),
  )
  for (const rows of chunk(timelineRows, INSERT_CHUNK.timeline)) {
    await tx`INSERT INTO report_timeline ${tx(rows)}`
  }
}

async function writeReportLinks(
  tx: TransactionSql,
  events: SeedEvent[],
  reports: SeedReport[],
): Promise<void> {
  const linkRows: {
    cleanup_id: string
    report_id: string
    linked_by_user_id: string
    linked_at: Date
  }[] = []
  const linkedReportIds = new Set<string>()
  for (const ev of events) {
    if (ev.status === "cancelled" || !chance(0.5)) continue
    const nearby = reports.filter(
      (r) =>
        r.hood.name === ev.hood.name &&
        !linkedReportIds.has(r.id) &&
        r.createdAt.getTime() < ev.scheduledAt.getTime() &&
        r.status !== "submitted",
    )
    for (const r of shuffle(nearby).slice(0, rint(1, 3))) {
      linkedReportIds.add(r.id)
      linkRows.push({
        cleanup_id: ev.id,
        report_id: r.id,
        linked_by_user_id: ev.organizer.id,
        linked_at: later(ev.createdAt, r.createdAt),
      })
    }
  }
  if (linkRows.length > 0) await tx`INSERT INTO cleanup_reports ${tx(linkRows)}`
}

async function writePosts(tx: TransactionSql, posts: SeedPost[]): Promise<void> {
  // Dependency waves: parents before replies, targets before reposts and quotes.
  const waves = new Map<number, SeedPost[]>()
  for (const p of posts) {
    const arr = waves.get(p.depth) ?? []
    arr.push(p)
    waves.set(p.depth, arr)
  }
  for (const depth of [...waves.keys()].sort((a, b) => a - b)) {
    for (const rows of chunk(waves.get(depth)!, INSERT_CHUNK.posts)) {
      await tx`INSERT INTO posts ${tx(
        rows.map((p) => ({
          id: p.id,
          author_id: p.author.id,
          kind: p.kind,
          body: p.body,
          visibility: "public",
          reply_to_id: p.replyTo?.id ?? null,
          thread_root_id: p.threadRoot?.id ?? null,
          repost_of_id: p.repostOf?.id ?? null,
          event_id: p.eventId,
          report_id: p.reportId,
          like_count: p.likeCount,
          repost_count: p.repostCount,
          reply_count: p.replyCount,
          save_count: p.saveCount,
          created_at: p.createdAt,
          updated_at: p.createdAt,
        })),
      )}`
    }
  }
  const linkedPostIds = posts
    .filter((p) => p.reportId !== null || p.eventId !== null)
    .map((p) => p.id)
  for (const ids of chunk(linkedPostIds, INSERT_CHUNK.postGeom)) {
    await tx`
      UPDATE posts p SET geom = COALESCE(
        (SELECT r.geom FROM reports r WHERE r.id = p.report_id),
        (SELECT c.geom FROM cleanups c WHERE c.id = p.event_id)
      )
      WHERE p.id = ANY(${ids}::uuid[])
    `
  }
  const mentionRows = posts.flatMap((p) =>
    p.mentions.map((m) => ({ post_id: p.id, mentioned_user_id: m })),
  )
  for (const rows of chunk(mentionRows, INSERT_CHUNK.mentions)) {
    await tx`INSERT INTO post_mentions ${tx(rows)}`
  }
}

async function writeEngagement(
  tx: TransactionSql,
  likes: SeedLike[],
  saves: SeedLike[],
): Promise<void> {
  for (const rows of chunk(likes, INSERT_CHUNK.engagement)) {
    await tx`INSERT INTO post_likes ${tx(
      rows.map((l) => ({ post_id: l.postId, user_id: l.userId, created_at: l.createdAt })),
    )}`
  }
  for (const rows of chunk(saves, INSERT_CHUNK.engagement)) {
    await tx`INSERT INTO post_saves ${tx(
      rows.map((s) => ({ post_id: s.postId, user_id: s.userId, created_at: s.createdAt })),
    )}`
  }
}

async function writeHours(tx: TransactionSql, hours: SeedHours[]): Promise<void> {
  for (const rows of chunk(hours, INSERT_CHUNK.hours)) {
    await tx`INSERT INTO volunteer_hours ${tx(
      rows.map((h) => ({
        user_id: h.userId,
        hours: h.hours,
        source: "event",
        cleanup_id: h.cleanupId,
        jurisdiction_geoid: h.jurisdictionGeoid,
        logged_by_user_id: h.loggedBy,
        created_at: h.createdAt,
      })),
    )}`
    await tx`INSERT INTO volunteer_hours_audit ${tx(
      rows.map((h) => ({
        cleanup_id: h.cleanupId,
        user_id: h.userId,
        actor_user_id: h.loggedBy,
        previous_hours: null,
        new_hours: h.hours,
        created_at: h.createdAt,
      })),
    )}`
  }
  const rollups = new Map<string, { userId: string; geoid: string; total: number }>()
  for (const h of hours) {
    if (h.jurisdictionGeoid === null) continue
    const k = `${h.userId}:${h.jurisdictionGeoid}`
    const cur = rollups.get(k) ?? { userId: h.userId, geoid: h.jurisdictionGeoid, total: 0 }
    cur.total += Number(h.hours)
    rollups.set(k, cur)
  }
  const rollupRows = [...rollups.values()].map((r) => ({
    user_id: r.userId,
    jurisdiction_geoid: r.geoid,
    total_hours: r.total.toFixed(2),
  }))
  for (const rows of chunk(rollupRows, INSERT_CHUNK.rollups)) {
    await tx`
      INSERT INTO user_jurisdiction_hours ${tx(rows)}
      ON CONFLICT (user_id, jurisdiction_geoid)
      DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
    `
  }
}

export async function writeAll(tx: TransactionSql, data: SeedData): Promise<void> {
  await writeUsers(tx, data.users)
  await writeFollows(tx, data.follows)
  await writeEvents(tx, data.events, data.hours)
  await writeEventRosters(tx, data.events, data.now, data.hashFor)
  await writeReports(tx, data.reports)
  await writeReportLinks(tx, data.events, data.reports)
  await writePosts(tx, data.posts)
  await writeEngagement(tx, data.likes, data.saves)
  await writeHours(tx, data.hours)
}

// Runs inside the seed transaction, so a mismatch rolls the whole seed back.

async function verify(tx: TransactionSql, now: Date): Promise<string[]> {
  const lines: string[] = []
  const fail: string[] = []
  const checks: { label: string; rows: Promise<{ n: number | string }[]> }[] = [
    {
      label: "demo members of open events hold a registration",
      rows: tx`
        SELECT count(*)::int AS n FROM cleanup_members m
        JOIN cleanups c ON c.id = m.cleanup_id
        JOIN users u ON u.id = m.user_id
        WHERE u.email LIKE ${DEMO_EMAIL_PATTERN} AND c.status <> 'cancelled' AND c.ends_at > ${now}
          AND NOT EXISTS (SELECT 1 FROM cleanup_ticket_types t WHERE t.cleanup_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM cleanup_registrations r
            WHERE r.cleanup_id = c.id AND r.user_id = m.user_id AND r.status = 'registered'
          )`,
    },
    {
      label: "demo posts linked to a report or event carry its point",
      rows: tx`
        SELECT count(*)::int AS n FROM posts p JOIN users u ON u.id = p.author_id
        WHERE u.email LIKE ${DEMO_EMAIL_PATTERN} AND p.geom IS NULL
          AND (p.report_id IS NOT NULL OR p.event_id IS NOT NULL)`,
    },
    {
      label: "posts.like_count matches post_likes",
      rows: tx`SELECT count(*)::int AS n FROM posts p WHERE p.like_count <> (SELECT count(*) FROM post_likes l WHERE l.post_id = p.id)`,
    },
    {
      label: "posts.reply_count matches replies",
      rows: tx`SELECT count(*)::int AS n FROM posts p WHERE p.reply_count <> (SELECT count(*) FROM posts c WHERE c.reply_to_id = p.id AND c.deleted_at IS NULL)`,
    },
    {
      label: "posts.repost_count matches pure reposts",
      rows: tx`SELECT count(*)::int AS n FROM posts p WHERE p.repost_count <> (SELECT count(*) FROM posts c WHERE c.repost_of_id = p.id AND c.kind = 'repost' AND c.deleted_at IS NULL)`,
    },
    {
      label: "posts.save_count matches post_saves",
      rows: tx`SELECT count(*)::int AS n FROM posts p WHERE p.save_count <> (SELECT count(*) FROM post_saves s WHERE s.post_id = p.id)`,
    },
    {
      label: "users.follower_count matches follows_people",
      rows: tx`SELECT count(*)::int AS n FROM users u WHERE u.follower_count <> (SELECT count(*) FROM follows_people f WHERE f.followee_id = u.id)`,
    },
    {
      label: "users.following_count matches follows_people",
      rows: tx`SELECT count(*)::int AS n FROM users u WHERE u.following_count <> (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id)`,
    },
    {
      label: "jurisdiction rollups match volunteer_hours",
      rows: tx`
        SELECT count(*)::int AS n FROM user_jurisdiction_hours ujh
        WHERE ujh.total_hours <> COALESCE((
          SELECT sum(vh.hours) FROM volunteer_hours vh
          WHERE vh.user_id = ujh.user_id AND vh.jurisdiction_geoid = ujh.jurisdiction_geoid AND vh.voided_at IS NULL
        ), 0)`,
    },
    {
      label: "thread roots resolve to top-level posts",
      rows: tx`SELECT count(*)::int AS n FROM posts c JOIN posts r ON r.id = c.thread_root_id WHERE r.reply_to_id IS NOT NULL`,
    },
    {
      label: "slot claims stay within their event",
      rows: tx`SELECT count(*)::int AS n FROM cleanup_slot_claims c JOIN cleanup_slots s ON s.id = c.slot_id WHERE s.cleanup_id <> c.cleanup_id`,
    },
    {
      label: "no slot over capacity",
      rows: tx`
        SELECT count(*)::int AS n FROM cleanup_slots s
        WHERE s.capacity IS NOT NULL
          AND (SELECT count(*) FROM cleanup_slot_claims c WHERE c.slot_id = s.id) > s.capacity`,
    },
  ]
  for (const c of checks) {
    const [row] = await c.rows
    const n = Number(row?.n ?? -1)
    if (n === 0) lines.push(`  ok  ${c.label}`)
    else fail.push(`  BAD ${c.label}: ${n} mismatched rows`)
  }
  if (fail.length > 0) throw new Error(`verification failed:\n${fail.join("\n")}`)
  return lines
}

const PURGE_BLOCKER_SAMPLE = 20

// Real replies/reposts point at demo posts through ON DELETE RESTRICT, and real volunteer hours point
// at demo events and reports with no ON DELETE: purging would fail on the FK anyway, so name the rows
// the operator has to decide about instead. Real content is never rewritten here.
async function assertNothingRealDependsOnDemo(tx: TransactionSql): Promise<void> {
  const demo = tx`SELECT id FROM users WHERE email LIKE ${DEMO_EMAIL_PATTERN}`
  const blockers = await tx<{ kind: string; id: string }[]>`
    WITH demo_posts AS (SELECT id FROM posts WHERE author_id IN (${demo}))
    SELECT 'post' AS kind, p.id::text AS id
    FROM posts p
    WHERE p.author_id NOT IN (${demo})
      AND (
        p.reply_to_id IN (SELECT id FROM demo_posts)
        OR p.thread_root_id IN (SELECT id FROM demo_posts)
        OR p.repost_of_id IN (SELECT id FROM demo_posts)
      )
    UNION ALL
    SELECT 'volunteer_hours' AS kind, vh.id::text AS id
    FROM volunteer_hours vh
    WHERE vh.user_id NOT IN (${demo})
      AND (
        vh.cleanup_id IN (SELECT id FROM cleanups WHERE organizer_user_id IN (${demo}))
        OR vh.report_id IN (SELECT id FROM reports WHERE reporter_user_id IN (${demo}))
      )
    LIMIT ${PURGE_BLOCKER_SAMPLE}
  `
  if (blockers.length === 0) return
  const listed = blockers.map((b) => `${b.kind} ${b.id}`).join(", ")
  throw new Error(
    `purge refused: real users' content depends on demo content (first ${blockers.length}): ${listed}`,
  )
}

// Follows, likes, saves, replies and reposts by demo accounts on real accounts and posts vanish with
// the demo rows, so those real counters are recomputed from the remaining rows, with the same
// definitions verify() asserts.
async function recomputeRealCounters(
  tx: TransactionSql,
  users: readonly string[],
  posts: readonly string[],
): Promise<void> {
  if (users.length > 0) {
    await tx`
      UPDATE users u SET follower_count = (SELECT count(*) FROM follows_people f WHERE f.followee_id = u.id),
        following_count = (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id)
      WHERE u.id = ANY(${users as string[]}::uuid[])
    `
  }
  if (posts.length > 0) {
    await tx`
      UPDATE posts p SET like_count = (SELECT count(*) FROM post_likes l WHERE l.post_id = p.id),
        save_count = (SELECT count(*) FROM post_saves s WHERE s.post_id = p.id),
        reply_count = (SELECT count(*) FROM posts c WHERE c.reply_to_id = p.id AND c.deleted_at IS NULL),
        repost_count = (SELECT count(*) FROM posts c WHERE c.repost_of_id = p.id AND c.kind = 'repost' AND c.deleted_at IS NULL)
      WHERE p.id = ANY(${posts as string[]}::uuid[])
    `
  }
}

export async function purgeDemo(tx: TransactionSql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const del = async (label: string, q: PromiseLike<readonly unknown[]>) => {
    counts[label] = (await q).length
  }
  const demo = tx`SELECT id FROM users WHERE email LIKE ${DEMO_EMAIL_PATTERN}`
  await assertNothingRealDependsOnDemo(tx)
  const touchedUsers = await tx<{ id: string }[]>`
    SELECT DISTINCT x.id
    FROM (
      SELECT f.follower_id AS id FROM follows_people f WHERE f.followee_id IN (${demo})
      UNION
      SELECT f.followee_id AS id FROM follows_people f WHERE f.follower_id IN (${demo})
    ) x
    WHERE x.id NOT IN (${demo})
  `
  const touchedPosts = await tx<{ id: string }[]>`
    SELECT DISTINCT x.id
    FROM (
      SELECT l.post_id AS id FROM post_likes l WHERE l.user_id IN (${demo})
      UNION
      SELECT s.post_id AS id FROM post_saves s WHERE s.user_id IN (${demo})
      UNION
      SELECT p.reply_to_id AS id FROM posts p WHERE p.author_id IN (${demo}) AND p.reply_to_id IS NOT NULL
      UNION
      SELECT p.repost_of_id AS id FROM posts p WHERE p.author_id IN (${demo}) AND p.repost_of_id IS NOT NULL
    ) x
    JOIN posts target ON target.id = x.id
    WHERE target.author_id NOT IN (${demo})
  `
  await del(
    "volunteer_hours_audit",
    tx`DELETE FROM volunteer_hours_audit WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "volunteer_hours",
    tx`DELETE FROM volunteer_hours WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "user_jurisdiction_hours",
    tx`DELETE FROM user_jurisdiction_hours WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "cleanup_slot_claims",
    tx`DELETE FROM cleanup_slot_claims WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "cleanup_members",
    tx`DELETE FROM cleanup_members WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "cleanups",
    tx`DELETE FROM cleanups WHERE organizer_user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "reports",
    tx`DELETE FROM reports WHERE reporter_user_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "follows_people",
    tx`DELETE FROM follows_people WHERE follower_id IN (${demo}) OR followee_id IN (${demo}) RETURNING 1 AS one`,
  )
  await del(
    "notification_prefs",
    tx`DELETE FROM notification_prefs WHERE user_id IN (${demo}) RETURNING 1 AS one`,
  )
  // posts / likes / saves / mentions / timeline cascade from users + reports + cleanups.
  await del(
    "users",
    tx`DELETE FROM users WHERE email LIKE ${DEMO_EMAIL_PATTERN} RETURNING 1 AS one`,
  )
  await recomputeRealCounters(
    tx,
    touchedUsers.map((u) => u.id),
    touchedPosts.map((p) => p.id),
  )
  counts["real_users_recounted"] = touchedUsers.length
  counts["real_posts_recounted"] = touchedPosts.length
  return counts
}

async function runPurge(sql: Sql, commit: boolean): Promise<void> {
  const ROLLBACK = Symbol("rollback")
  const result = await sql
    .begin(async (tx) => {
      const counts = await purgeDemo(tx)
      if (!commit) throw ROLLBACK
      return counts
    })
    .catch((e: unknown) => {
      if (e === ROLLBACK) return null
      throw e
    })
  if (result) {
    console.log("purged:", result)
  } else {
    console.log("purge rehearsal complete, rolled back. Pass --yes to commit.")
  }
}

function generateCohort(
  userCount: number,
  now: Date,
  hashFor: (seatId: string) => string,
): SeedData {
  const start = new Date(now.getTime() - COHORT_HISTORY_DAYS * DAY)
  const users = makeUsers(userCount, start, new Date(now.getTime() - NEWEST_ACCOUNT_AGE_DAYS * DAY))
  const follows = makeFollows(users, now)
  const events = makeEvents(users, now)
  const reports = makeReports(users, Math.round(userCount * REPORTS_PER_USER), now)
  const posts = makePosts(users, events, reports, follows, now)
  const { likes, saves } = makeLikesAndSaves(users, posts, follows, now)
  const hours = makeHours(events, now)
  validate(users, follows, events, reports, posts, likes, saves)
  return { now, hashFor, users, follows, events, reports, posts, likes, saves, hours }
}

function logCohort(data: SeedData): void {
  const { users, follows, events, reports, posts, likes, saves, hours } = data
  const memberRows = events.reduce((n, e) => n + e.members.length, 0)
  const claimRows = events.reduce((n, e) => n + e.claims.length, 0)
  const postsOfKind = (kind: SeedPost["kind"]) => posts.filter((p) => p.kind === kind).length
  console.log(
    [
      `  users: ${users.length}  (hispanic ~${users.filter((u) => u.hispanic).length})`,
      `  follows: ${follows.length}`,
      `  events: ${events.length}  members: ${memberRows}  slot claims: ${claimRows}`,
      `  reports: ${reports.length}  timeline rows: ${reports.reduce((n, r) => n + r.timeline.length, 0)}`,
      `  posts: ${postsOfKind("post")} top-level, ${postsOfKind("reply")} replies, ` +
        `${postsOfKind("repost")} reposts, ${postsOfKind("quote")} quotes`,
      `  likes: ${likes.length}  saves: ${saves.length}  volunteer hour rows: ${hours.length}`,
    ].join("\n"),
  )
}

async function runSeed(
  sql: Sql,
  opts: { commit: boolean; userCount: number; prngSeed: number },
): Promise<void> {
  const hashFor = demoTicketTokenHasher()
  const now = new Date()

  console.log(`generating cohort (seed ${opts.prngSeed})...`)
  const data = generateCohort(opts.userCount, now, hashFor)
  logCohort(data)

  const ROLLBACK = Symbol("rollback")
  const verification = await sql
    .begin(async (tx) => {
      const [existing] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM users WHERE email LIKE ${DEMO_EMAIL_PATTERN}
        `
      if (Number(existing?.n ?? 0) > 0) {
        throw new Error(
          `found ${existing!.n} existing demo users (@${DEMO_EMAIL_DOMAIN}); run --purge --yes first`,
        )
      }
      console.log("writing...")
      await writeAll(tx, data)
      console.log("verifying...")
      const lines = await verify(tx, now)
      if (!opts.commit) throw ROLLBACK
      return lines
    })
    .catch((e: unknown) => {
      if (e === ROLLBACK) return "rolledback" as const
      throw e
    })

  if (verification === "rolledback") {
    console.log("rehearsal complete: all inserts + verification passed, transaction rolled back.")
    console.log("re-run with --yes to commit.")
  } else {
    for (const l of verification) console.log(l)
    console.log("committed.")
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const purgeMode = process.argv.includes("--purge")
  const userCount = Number(argValue("--users") ?? DEFAULT_USER_COUNT)
  const prngSeed = Number(argValue("--seed") ?? DEMO_PRNG_SEED)
  seedDemoRandom(prngSeed)

  const databaseUrl = requireDatabaseUrl()
  console.log(`target database: ${new URL(databaseUrl).host}`)
  console.log(
    commit
      ? "mode: COMMIT"
      : "mode: rehearsal (full run + verification, then ROLLBACK; pass --yes to commit)",
  )

  await runDbCli(
    async (_db, sql) => {
      if (purgeMode) await runPurge(sql, commit)
      else await runSeed(sql, { commit, userCount, prngSeed })
    },
    { databaseUrl },
  )
}

runIfMain(import.meta.url, "seed-demo-la", main)
