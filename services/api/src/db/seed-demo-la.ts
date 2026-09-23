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
import { REPORT_TYPE_TO_CATEGORY, type ReportType } from "@civfix/shared"
import { makeDb, type Sql, type TransactionSql } from "./client.js"
import {
  allocateEventReferenceCode,
  allocateReportReferenceCode,
  resolveJurisdictionCode,
} from "./reference-code.js"
import { resolveJurisdiction } from "./sql/jurisdiction.js"
import { reportH3Cell } from "../services/report-clustering.js"
import { runIfMain } from "./cli.js"
import { DEMO_EMAIL_DOMAIN } from "./seed-demo-domain.js"
import { DEFAULT_EVENT_DURATION_MS, DEFAULT_EVENT_SLOT_TITLE } from "../services/cleanup-rules.js"
import { demoTicketTokenHasher, mintDemoSignupSeats } from "./demo-signup-seats.js"
import { touchUserActivity } from "./sql/user-activity.js"

// Seeded addresses are typed by hand, the provenance the live create paths record for that case.
const SEEDED_REPORT_ADDR_SOURCE = "user"
const SEEDED_EVENT_ADDRESS_SOURCE = "manual"

// Seeded so a rehearsal, the committed run and a re-run after purge generate the same cohort.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let rand = mulberry32(20260902)

function rint(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1))
}
function chance(p: number): boolean {
  return rand() < p
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]!
}
function pickWeighted<T>(items: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of items) total += w
  let roll = rand() * total
  for (const [v, w] of items) {
    roll -= w
    if (roll <= 0) return v
  }
  return items[items.length - 1]![0]
}
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}
function sampleWeighted<T>(
  items: readonly T[],
  weightOf: (t: T) => number,
  n: number,
  exclude: Set<T>,
): T[] {
  const out: T[] = []
  const taken = new Set(exclude)
  const pool = items.filter((i) => !taken.has(i))
  for (let k = 0; k < n && pool.length > 0; k++) {
    let total = 0
    for (const i of pool) total += weightOf(i)
    if (total <= 0) break
    let roll = rand() * total
    let idx = pool.length - 1
    for (let j = 0; j < pool.length; j++) {
      roll -= weightOf(pool[j]!)
      if (roll <= 0) {
        idx = j
        break
      }
    }
    out.push(pool[idx]!)
    pool.splice(idx, 1)
  }
  return out
}

// Timestamps get an LA-plausible time-of-day (evenings and weekends heavier), stored as UTC. The
// seeded window spans both PST and PDT, so the offset is resolved per date.

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const LA_TIME_ZONE = "America/Los_Angeles"
const LA_STANDARD_OFFSET_HOURS = -8

const LA_OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TIME_ZONE,
  timeZoneName: "shortOffset",
})

function laOffsetHoursAt(at: Date): number {
  const name = LA_OFFSET_FORMAT.formatToParts(at).find((p) => p.type === "timeZoneName")?.value
  const m = /^GMT([+-]\d{1,2})$/.exec(name ?? "")
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
  const span = Math.max(end.getTime() - start.getTime(), 60_000)
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = atLocalTime(start.getTime() + rand() * span)
    if (t.getTime() < start.getTime() || t.getTime() > end.getTime()) continue
    const dow = t.getUTCDay()
    if (dow === 0 || dow === 6 || chance(0.75)) return t
  }
  return new Date(start.getTime() + rand() * span)
}

function minutesAfter(d: Date, min: number, max: number): Date {
  return new Date(d.getTime() + rint(min, max) * 60_000)
}
function later(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

// About 70% of the cohort is Hispanic, with the rest reflecting LA's mix.

const HISPANIC_FIRST_M = [
  "Jose",
  "Juan",
  "Carlos",
  "Luis",
  "Jorge",
  "Miguel",
  "Pedro",
  "Rafael",
  "Javier",
  "Alejandro",
  "Fernando",
  "Ricardo",
  "Eduardo",
  "Sergio",
  "Hector",
  "Oscar",
  "Raul",
  "Marco",
  "Cesar",
  "Diego",
  "Emiliano",
  "Mateo",
  "Santiago",
  "Sebastian",
  "Andres",
  "Cristian",
  "Ivan",
  "Erick",
  "Kevin",
  "Brandon",
  "Anthony",
  "Angel",
  "Jesus",
  "Ernesto",
  "Gerardo",
  "Rodrigo",
  "Ruben",
  "Salvador",
  "Armando",
  "Alfredo",
  "Enrique",
] as const

const HISPANIC_FIRST_F = [
  "Maria",
  "Guadalupe",
  "Rosa",
  "Carmen",
  "Ana",
  "Leticia",
  "Veronica",
  "Claudia",
  "Adriana",
  "Gabriela",
  "Alejandra",
  "Daniela",
  "Mariana",
  "Valeria",
  "Ximena",
  "Camila",
  "Lucia",
  "Elena",
  "Isabel",
  "Sofia",
  "Paola",
  "Yesenia",
  "Marisol",
  "Araceli",
  "Esmeralda",
  "Karina",
  "Brenda",
  "Jessica",
  "Jasmine",
  "Vanessa",
  "Lorena",
  "Norma",
  "Silvia",
  "Patricia",
  "Sandra",
  "Monica",
  "Angelica",
  "Maribel",
  "Rocio",
  "Beatriz",
  "Josefina",
  "Cindy",
  "Nayeli",
  "Itzel",
  "Fatima",
  "Alondra",
  "Giselle",
  "Ashley",
  "Destiny",
  "Selena",
] as const

const HISPANIC_LAST = [
  "Garcia",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Perez",
  "Sanchez",
  "Ramirez",
  "Torres",
  "Flores",
  "Rivera",
  "Gomez",
  "Diaz",
  "Reyes",
  "Morales",
  "Cruz",
  "Ortiz",
  "Gutierrez",
  "Chavez",
  "Ramos",
  "Ruiz",
  "Alvarez",
  "Mendoza",
  "Vasquez",
  "Castillo",
  "Jimenez",
  "Moreno",
  "Romero",
  "Herrera",
  "Medina",
  "Aguilar",
  "Vargas",
  "Guzman",
  "Castro",
  "Fernandez",
  "Munoz",
  "Rojas",
  "Soto",
  "Contreras",
  "Silva",
  "Delgado",
  "Pena",
  "Rios",
  "Salazar",
  "Estrada",
  "Ortega",
  "Nunez",
  "Maldonado",
  "Vega",
  "Dominguez",
  "Cabrera",
  "Velasquez",
  "Ibarra",
  "Zavala",
  "Cervantes",
  "Fuentes",
  "Carrillo",
  "Trejo",
  "Solis",
  "Cardenas",
  "Villanueva",
  "Escobar",
  "Quintero",
  "Barrera",
  "Rosales",
  "Camacho",
  "Arellano",
  "Meza",
  "Palacios",
  "Navarro",
  "Padilla",
  "Miranda",
  "Bautista",
  "Orozco",
  "Zuniga",
  "Ochoa",
  "Duran",
  "Macias",
  "Renteria",
] as const

/** Display names only: handles and emails stay ASCII. */
const ACCENTED: Record<string, string> = {
  Jose: "José",
  Maria: "María",
  Jesus: "Jesús",
  Andres: "Andrés",
  Cesar: "César",
  Angel: "Ángel",
  Lucia: "Lucía",
  Sofia: "Sofía",
  Ivan: "Iván",
  Fatima: "Fátima",
  Munoz: "Muñoz",
  Nunez: "Núñez",
  Pena: "Peña",
  Zuniga: "Zúñiga",
}

const OTHER_POOLS: readonly {
  firstM: readonly string[]
  firstF: readonly string[]
  last: readonly string[]
  weight: number
}[] = [
  {
    // Korean American
    firstM: ["Daniel", "Brian", "Eric", "Andrew", "Joon", "David"],
    firstF: ["Grace", "Esther", "Hannah", "Julie", "Minji", "Susan"],
    last: ["Kim", "Park", "Lee", "Choi", "Kang", "Yoon", "Shin", "Cho"],
    weight: 5,
  },
  {
    // Armenian American
    firstM: ["Armen", "Narek", "Tigran", "Vahe"],
    firstF: ["Ani", "Lilit", "Mariam", "Sona"],
    last: ["Hakobyan", "Grigoryan", "Sarkissian", "Petrosyan", "Avetisyan", "Kasparian"],
    weight: 3,
  },
  {
    // Filipino American
    firstM: ["Angelo", "Mark", "JR", "Paolo"],
    firstF: ["Kristine", "Joanna", "Camille", "Divine"],
    last: ["Santos", "Dela Cruz", "Mercado", "Aquino", "Ocampo", "Villareal", "Manalo"],
    weight: 4,
  },
  {
    // Black and White American
    firstM: ["Marcus", "Darnell", "James", "Mike", "Tyler", "Jordan", "Chris", "Devin"],
    firstF: ["Keisha", "Tiffany", "Sarah", "Emily", "Aaliyah", "Megan", "Lauren", "Renee"],
    last: [
      "Johnson",
      "Williams",
      "Brown",
      "Smith",
      "Miller",
      "Davis",
      "Jackson",
      "Harris",
      "Thompson",
      "Robinson",
      "Walker",
      "Carter",
      "Mitchell",
      "Turner",
    ],
    weight: 10,
  },
  {
    // Chinese American
    firstM: ["Wei", "Kevin", "Jason", "Alan"],
    firstF: ["Amy", "Cindy", "Michelle", "Tina"],
    last: ["Chen", "Wang", "Liu", "Huang", "Lin", "Wu", "Zhang"],
    weight: 4,
  },
  {
    // Vietnamese American
    firstM: ["Minh", "Vincent", "Phong", "Tuan"],
    firstF: ["Linh", "Thao", "Kim-Ly", "Vy"],
    last: ["Nguyen", "Tran", "Pham", "Le", "Vo", "Dang"],
    weight: 3,
  },
]

// Neighborhood jitter radii are in degrees. Weighted toward the Eastside, Southeast LA and the harbor
// corridor.

interface Hood {
  name: string
  lat: number
  lng: number
  r: number
  weight: number
  streets: readonly string[]
}

const HOODS: readonly Hood[] = [
  {
    name: "Boyle Heights",
    lat: 34.0397,
    lng: -118.2077,
    r: 0.01,
    weight: 10,
    streets: [
      "Cesar Chavez Ave",
      "Soto St",
      "1st St",
      "4th St",
      "Whittier Blvd",
      "Lorena St",
      "Evergreen Ave",
      "St Louis St",
    ],
  },
  {
    name: "East LA",
    lat: 34.0239,
    lng: -118.1721,
    r: 0.012,
    weight: 9,
    streets: ["Whittier Blvd", "Atlantic Blvd", "3rd St", "Mednik Ave", "Arizona Ave", "Hammel St"],
  },
  {
    name: "Highland Park",
    lat: 34.1115,
    lng: -118.187,
    r: 0.01,
    weight: 7,
    streets: ["York Blvd", "Figueroa St", "Avenue 56", "Monte Vista St", "Marmion Way"],
  },
  {
    name: "El Sereno",
    lat: 34.0806,
    lng: -118.1763,
    r: 0.01,
    weight: 6,
    streets: ["Huntington Dr", "Eastern Ave", "Alhambra Ave", "Valley Blvd"],
  },
  {
    name: "Lincoln Heights",
    lat: 34.07,
    lng: -118.2,
    r: 0.008,
    weight: 6,
    streets: ["N Broadway", "Daly St", "Main St", "Avenue 26", "Workman St"],
  },
  {
    name: "City Terrace",
    lat: 34.057,
    lng: -118.183,
    r: 0.007,
    weight: 4,
    streets: ["City Terrace Dr", "Eastern Ave", "Herbert Ave"],
  },
  {
    name: "Huntington Park",
    lat: 33.9817,
    lng: -118.2251,
    r: 0.009,
    weight: 7,
    streets: ["Pacific Blvd", "Gage Ave", "Slauson Ave", "Florence Ave", "Santa Fe Ave"],
  },
  {
    name: "South Gate",
    lat: 33.9547,
    lng: -118.212,
    r: 0.01,
    weight: 5,
    streets: ["Tweedy Blvd", "Long Beach Blvd", "Firestone Blvd", "Atlantic Ave"],
  },
  {
    name: "Pacoima",
    lat: 34.2728,
    lng: -118.4201,
    r: 0.012,
    weight: 6,
    streets: ["Van Nuys Blvd", "Glenoaks Blvd", "Laurel Canyon Blvd", "Foothill Blvd", "Paxton St"],
  },
  {
    name: "Van Nuys",
    lat: 34.1899,
    lng: -118.4514,
    r: 0.012,
    weight: 5,
    streets: ["Van Nuys Blvd", "Victory Blvd", "Sherman Way", "Sepulveda Blvd", "Kester Ave"],
  },
  {
    name: "Sylmar",
    lat: 34.3078,
    lng: -118.4453,
    r: 0.012,
    weight: 3,
    streets: ["San Fernando Rd", "Maclay Ave", "Glenoaks Blvd", "Hubbard St"],
  },
  {
    name: "Sun Valley",
    lat: 34.217,
    lng: -118.37,
    r: 0.01,
    weight: 3,
    streets: ["San Fernando Rd", "Sunland Blvd", "Vineland Ave", "Lankershim Blvd"],
  },
  {
    name: "Wilmington",
    lat: 33.7801,
    lng: -118.2646,
    r: 0.01,
    weight: 5,
    streets: ["Avalon Blvd", "Anaheim St", "Pacific Coast Hwy", "Wilmington Blvd", "L St"],
  },
  {
    name: "San Pedro",
    lat: 33.7361,
    lng: -118.2922,
    r: 0.01,
    weight: 4,
    streets: ["Gaffey St", "Pacific Ave", "25th St", "Western Ave", "6th St"],
  },
  {
    name: "Watts",
    lat: 33.9425,
    lng: -118.2417,
    r: 0.008,
    weight: 5,
    streets: ["103rd St", "Central Ave", "Compton Ave", "Wilmington Ave", "Grandee Ave"],
  },
  {
    name: "South LA",
    lat: 34.0,
    lng: -118.292,
    r: 0.014,
    weight: 7,
    streets: [
      "Vermont Ave",
      "Western Ave",
      "Normandie Ave",
      "Slauson Ave",
      "Manchester Ave",
      "Figueroa St",
    ],
  },
  {
    name: "Koreatown",
    lat: 34.0577,
    lng: -118.3009,
    r: 0.009,
    weight: 5,
    streets: [
      "Wilshire Blvd",
      "Olympic Blvd",
      "Western Ave",
      "Vermont Ave",
      "8th St",
      "Normandie Ave",
    ],
  },
  {
    name: "Westlake",
    lat: 34.057,
    lng: -118.276,
    r: 0.007,
    weight: 5,
    streets: ["Alvarado St", "7th St", "Wilshire Blvd", "Union Ave", "Bonnie Brae St"],
  },
  {
    name: "Pico-Union",
    lat: 34.047,
    lng: -118.283,
    r: 0.007,
    weight: 5,
    streets: ["Pico Blvd", "Union Ave", "Hoover St", "Venice Blvd", "Alvarado St"],
  },
  {
    name: "Cypress Park",
    lat: 34.093,
    lng: -118.224,
    r: 0.006,
    weight: 3,
    streets: ["Cypress Ave", "Figueroa St", "San Fernando Rd", "Division St"],
  },
  {
    name: "Glassell Park",
    lat: 34.113,
    lng: -118.232,
    r: 0.007,
    weight: 3,
    streets: ["Eagle Rock Blvd", "Verdugo Rd", "San Fernando Rd", "Fletcher Dr"],
  },
  {
    name: "Echo Park",
    lat: 34.0782,
    lng: -118.2606,
    r: 0.007,
    weight: 4,
    streets: ["Sunset Blvd", "Echo Park Ave", "Glendale Blvd", "Alvarado St"],
  },
  {
    name: "Hollywood",
    lat: 34.0928,
    lng: -118.3287,
    r: 0.01,
    weight: 3,
    streets: ["Hollywood Blvd", "Sunset Blvd", "Santa Monica Blvd", "Western Ave", "Gower St"],
  },
  {
    name: "North Hollywood",
    lat: 34.172,
    lng: -118.377,
    r: 0.01,
    weight: 4,
    streets: ["Lankershim Blvd", "Magnolia Blvd", "Victory Blvd", "Vineland Ave"],
  },
  {
    name: "Panorama City",
    lat: 34.227,
    lng: -118.449,
    r: 0.009,
    weight: 4,
    streets: ["Van Nuys Blvd", "Roscoe Blvd", "Nordhoff St", "Woodman Ave"],
  },
  {
    name: "Harbor Gateway",
    lat: 33.86,
    lng: -118.29,
    r: 0.01,
    weight: 2,
    streets: ["Vermont Ave", "Figueroa St", "Gardena Blvd", "190th St"],
  },
]

const PARKS: readonly { name: string; hood: string; lat: number; lng: number }[] = [
  { name: "Hollenbeck Park", hood: "Boyle Heights", lat: 34.0367, lng: -118.2135 },
  { name: "Ruben Salazar Park", hood: "East LA", lat: 34.0236, lng: -118.1893 },
  { name: "Salt Lake Park", hood: "Huntington Park", lat: 33.9757, lng: -118.2172 },
  { name: "Hazard Park", hood: "Boyle Heights", lat: 34.0645, lng: -118.2005 },
  { name: "Lincoln Park", hood: "Lincoln Heights", lat: 34.0705, lng: -118.2028 },
  { name: "Sycamore Grove Park", hood: "Highland Park", lat: 34.0996, lng: -118.1998 },
  { name: "Ted Watkins Memorial Park", hood: "Watts", lat: 33.933, lng: -118.2379 },
  { name: "MacArthur Park", hood: "Westlake", lat: 34.059, lng: -118.2785 },
  { name: "Rio de Los Angeles State Park", hood: "Cypress Park", lat: 34.0994, lng: -118.2273 },
  { name: "Ernest E. Debs Regional Park", hood: "El Sereno", lat: 34.0873, lng: -118.1935 },
  { name: "Ken Malloy Harbor Regional Park", hood: "Wilmington", lat: 33.7863, lng: -118.2879 },
  { name: "Hansen Dam Recreation Area", hood: "Pacoima", lat: 34.2612, lng: -118.3898 },
  { name: "Sepulveda Basin", hood: "Van Nuys", lat: 34.1755, lng: -118.4838 },
  { name: "Point Fermin Park", hood: "San Pedro", lat: 33.706, lng: -118.2936 },
  { name: "Normandie Recreation Center", hood: "South LA", lat: 34.0261, lng: -118.3003 },
  { name: "Seoul International Park", hood: "Koreatown", lat: 34.0546, lng: -118.3082 },
  { name: "North Hollywood Park", hood: "North Hollywood", lat: 34.1638, lng: -118.3801 },
  { name: "Echo Park Lake", hood: "Echo Park", lat: 34.0723, lng: -118.2606 },
]

function hoodByName(name: string): Hood {
  return HOODS.find((h) => h.name === name) ?? HOODS[0]!
}

function jitterPoint(lat: number, lng: number, r: number): { lat: number; lng: number } {
  const angle = rand() * Math.PI * 2
  const dist = Math.sqrt(rand()) * r
  return {
    lat: +(lat + Math.sin(angle) * dist).toFixed(6),
    lng: +(lng + Math.cos(angle) * dist * 1.2).toFixed(6),
  }
}

// Deliberately casual: lowercase drift, loose punctuation, Spanish and Spanglish mixed in, occasional
// emoji, no long-form writing and no em dashes anywhere (validate() enforces the last).

const BIO_NEUTRAL: readonly string[] = [
  "{hood} born and raised",
  "trying to keep {hood} clean one block at a time",
  "east side til i die",
  "community first. {hood}",
  "if you see me picking up trash say hi",
  "small business owner on {street}",
  "youth soccer coach in {hood}",
  "keeping it clean in {hood} 🧹",
  "born in {hood}, still here, not leaving",
  "retired LAUSD. love my neighborhood",
  "just here to report potholes tbh",
  "organizing cleanups w my neighbors. dm me if you wanna help",
  "{hood} neighborhood watch",
]

const BIO_MALE: readonly string[] = [
  "dad of 3. tired of the dumping on our streets",
  "girl dad in {hood}",
  "dog dad, {hood}",
]
const BIO_FEMALE: readonly string[] = [
  "mom of 3. tired of the dumping on our streets",
  "{hood} resident, dog mom, 311 power user",
  "abuela energy. {hood}",
]

/** Only for Hispanic users; vecino/vecina gendered. */
const BIO_HISPANIC_NEUTRAL: readonly string[] = [
  "orgullosamente de {hood} 🇲🇽",
  "aqui puro {hood} 💪",
  "la comunidad es todo",
]
const BIO_HISPANIC_M: readonly string[] = ["vecino de {hood}, aqui para ayudar"]
const BIO_HISPANIC_F: readonly string[] = ["vecina de {hood}, aqui para ayudar"]

/** {street}/{street2}/{hood} slots are filled per author. */
const POST_TEMPLATES_EN: readonly string[] = [
  "third couch this month dumped on {street}. who keeps doing this",
  "the graffiti on the handball courts finally got painted over 🙏",
  "somebody left a whole entertainment center on the corner of {street} and {street2} lol",
  "shoutout to the crew that cleaned the alley behind {street} this weekend. looks brand new",
  "when is the city gonna fix the streetlight on {street}, its been out for like 2 months",
  "reported a mattress on {street} last tuesday and they actually picked it up friday. not bad",
  "ok whoever keeps dumping tires by the wash, we see you 🤨",
  "morning walk update: {street} is looking clean for once. small wins",
  "the bulky item pickup line had me on hold 40 mins. this app is way faster",
  "we need more trash cans on {street} near the bus stop. overflowing every weekend",
  "just moved to {hood} and joined this app, love seeing neighbors actually fix stuff",
  "anyone else notice the illegal dumping gets worse right after the first of the month",
  "picked up 3 bags on my street this morning before work. tired but worth it",
  "the mural on {street} got tagged again 😔 gonna organize a repaint",
  "city came and cleared the {street} underpass today. hope it stays clean this time",
  "psa: bulky item pickup is free, you dont have to dump your sofa on {street} 😤",
  "not all heroes wear capes, some just bring their own trash grabbers",
  "the sidewalk on {street} is basically an obstacle course. reported like 4 spots today",
  "my kids and i picked up trash at the park today. teach em young",
  "10/10 morning, coffee from the panaderia and a clean street for once",
  "does anyone know who to talk to about the abandoned car on {street}, been there 3 weeks",
  "the amount of fast food trash on {street} after friday night is wild",
  "shout out to the senora on my block who sweeps the whole sidewalk every morning",
  "found a shopping cart in the LA river again. classic",
  "neighbors really came through this weekend, {street} is spotless",
  "why do people dump paint cans in the alley. thats toxic waste man",
  "councilman's office actually called me back about the {street} dumping. progress??",
  "the little free library on {street} survived another year 🥹 love this block",
  "somebody stole the trash can from the bus stop?? lol only in LA",
  "green waste everywhere after the wind last night. be careful driving on {street}",
  "im convinced the same truck dumps on {street} every sunday night. gonna get a plate next time",
  "starting to see more people use this app in {hood}. keep reporting yall, it works",
  "cleaned up the parkway strip in front of my house. do your part people",
  "walking to the market and counted 6 illegal dump spots on {street}. all reported",
  "our block finally got the speed humps. now if we could get the trash handled",
  "sunday morning cleanups hit different. peaceful out here",
  "reminder that the storm drains go straight to the ocean. keep em clear",
  "big respect to the folks who do this every single week without any credit",
  "the empty lot on {street} needs some love, thinking of organizing something",
  "trash pickup skipped our street again this week?? anyone else on {street}",
  "if every block had 2 people who cared we could keep this whole neighborhood clean",
]

/** Drawn only by Hispanic authors. */
const POST_TEMPLATES_ES: readonly string[] = [
  "mucha basura en la calle otra vez. ya reporte, a ver si hacen algo",
  "el alley behind my place is getting bad again, gonna report it manana",
  "gracias a todos los que vinieron hoy, quedo bien limpio el parque 💪",
  "los fines de semana la gente tira basura como si nada. respeten el barrio",
  "vamos a limpiar {hood} este sabado, quien se apunta",
  "cada quien su bolsa. sabado 9am. no excuses",
  "hoy tocó limpiar la esquina de {street}. entre 4 lo hicimos en una hora",
  "esta app si funciona, reporte un colchon y en 3 dias lo recogieron",
  "que bonito se ve {hood} cuando todos ayudamos",
]

const REPORT_POST_EN: readonly string[] = [
  "reported this dump on {street}, yall check it out so the city sees it",
  "this has been here over a week. finally reported it",
  "look at this mess. reported. lets see how long it takes",
  "reported this one this morning, right by the school 😡",
  "adding this to the pile of reports on {street}. its bad out here",
  "cant even use the sidewalk. reported",
  "this is right in front of the panaderia. reported it, share so it gets fixed",
  "week 2 of this couch. reported again lol",
  "who does this?? reported",
]
const REPORT_POST_ES: readonly string[] = [
  "como es posible que dejen esto asi. ya lo reporte",
  "miren esto. reportado. compartan para que lo vean",
]

const EVENT_POST_EN: readonly string[] = [
  "hosting a cleanup this weekend, bring gloves if you got em. everyone welcome",
  "cleanup this saturday 🧹 kids welcome, we got extra grabbers",
  "we're doing another one. last time we filled 20 bags, lets beat that",
  "first cleanup im organizing, be nice lol. hope to see some of you there",
  "join us saturday morning, coffee and pan dulce for volunteers ☕",
  "one more cleanup before it gets too hot. roll thru",
  "big one this weekend. bring the whole family",
]
const EVENT_POST_ES: readonly string[] = [
  "vamos a limpiar este sabado, traigan agua y guantes. los espero",
  "este sabado nos toca limpiar. lleguenle con la familia",
]

const EVENT_RECAP_EN: readonly string[] = [
  "{bags} bags today. arms are dead but the block looks brand new. thank you everyone 🙏",
  "we got {bags} bags out of the park today. proud of this neighborhood",
  "another one done. {bags} bags, a couch, and somehow a car bumper lol. great turnout",
  "small crew today but we still pulled {bags} bags. every bit counts",
  "thank you to the {n} people who showed up today. {bags} bags collected",
]
const EVENT_RECAP_ES: readonly string[] = [
  "{bags} bolsas hoy!! gracias a todos los que vinieron 💪",
  "terminamos con {bags} bolsas. gracias a mi gente que llego temprano",
]

const REPLY_GENERIC_EN: readonly string[] = [
  "same thing on my street",
  "reported one like this last week, took 3 weeks but they picked it up",
  "this is why i love this app",
  "311 never picks up, this is faster fr",
  "ugh not again",
  "facts",
  "thank you for doing this",
  "we appreciate you 🙏",
  "same in {hood} honestly",
  "its been like this for weeks",
  "somebody has to say it",
  "100%",
  "we need cameras out there",
  "the city needs to do better",
  "keep us posted",
  "this made my day",
  "couldnt agree more",
  "im telling my landlord about this app lol",
  "the real MVP",
  "on my way to report the one by my house too",
  "hope they fix it soon",
  "lmk if you need help",
  "this block deserves better",
  "seen it, its worse in person",
]
const REPLY_GENERIC_ES: readonly string[] = [
  "gracias por reportar 🙏",
  "el respeto al barrio empieza por uno mismo",
  "asi es",
  "no manches",
  "que bueno que alguien hace algo",
  "orale, buen trabajo",
]

const REPLY_EVENT_EN: readonly string[] = [
  "i'll be there",
  "count me in",
  "what time does it start?",
  "can i bring my kids?",
  "do we need to bring our own gloves",
  "just signed up 🙌",
  "cant make this one but next time for sure",
  "bringing 2 friends",
  "is there parking nearby",
  "see you saturday",
  "my whole family is coming lol",
  "first time doing one of these, excited",
]
const REPLY_EVENT_ES: readonly string[] = ["yo tambien voy", "ahi estare", "llevare bolsas extra"]

const REPLY_REPORT_EN: readonly string[] = [
  "just liked it so it gets visibility",
  "reported the same spot last month, they cleared it but it came back",
  "thats right by my kids school 😡",
  "share it in the group chat too",
  "the city cleared one like this on my street in about a week",
  "took a pic of the same pile yesterday, glad you reported",
  "this intersection is always bad",
  "sad that it takes an app for the city to do their job",
]
const REPLY_REPORT_ES: readonly string[] = ["eso esta a una cuadra de mi casa", "gracias vecino"]

const QUOTE_EN: readonly string[] = [
  "this right here",
  "everyone in {hood} needs to see this",
  "and people say nobody cares about this neighborhood",
  "sharing for the morning crowd",
  "this is the kind of stuff that keeps me on this app",
  "proof that reporting works yall",
]
const QUOTE_ES: readonly string[] = ["lo que siempre digo", "mi gente 💪"]

/** [titles, descriptions]; slots: {street} {street2}. */
const REPORT_CONTENT: Record<
  ReportType,
  { titles: readonly string[]; descs: readonly string[]; descsEs?: readonly string[] }
> = {
  dump: {
    titles: [
      "mattress dumped on {street}",
      "couch left on the corner of {street} and {street2}",
      "pile of construction debris on {street}",
      "tv and boxes dumped by the alley",
      "furniture dumped on the sidewalk",
      "trash bags piling up on {street}",
      "tires dumped near {street}",
      "someone dumped a washer on {street}",
      "big pile of junk on the parkway",
      "shopping carts and trash on {street}",
    ],
    descs: [
      "been here over a week now. right in front of the laundromat. kids have to walk around it into the street",
      "keeps growing every day. started as one bag now its a whole pile",
      "someone dumped this overnight. blocking half the sidewalk",
      "third time this month at this exact spot. we need a camera or something",
      "smells terrible and there are flies everywhere. please pick up soon",
      "right next to the bus stop where people wait every morning",
      "wood with nails sticking out, dangerous for kids walking to school",
      "looks like a contractor dumped it, there are paint buckets and drywall",
      "elderly neighbors cant get around it with their carts",
      "its right by the storm drain, gonna wash into the river when it rains",
    ],
    descsEs: [
      "esta enfrente de mi casa desde el lunes. ya no podemos ni pasar por la banqueta",
      "la gente sigue tirando basura aqui, cada semana es lo mismo",
    ],
  },
  graffiti: {
    titles: [
      "tagging on the wall at {street}",
      "graffiti on the bus bench",
      "fresh tags on the store shutters",
      "graffiti covering the street sign",
      "wall on {street} tagged again",
      "tags all over the underpass",
    ],
    descs: [
      "whole wall got hit over the weekend. was just painted 2 months ago",
      "the stop sign is barely readable now, thats a safety issue",
      "small business owner already dealing with a lot, now this",
      "gang tags this time, neighbors are worried. please prioritize",
      "they tagged the mural too which is really sad, that mural took months",
      "same tags as the ones on {street2}, probably the same people",
    ],
    descsEs: ["rayaron toda la pared otra vez. apenas la habian pintado"],
  },
  encampment: {
    titles: [
      "encampment growing under the {street} overpass",
      "tents blocking the sidewalk on {street}",
      "encampment by the wash near {street}",
    ],
    descs: [
      "not trying to get anyone in trouble, they need services. but the sidewalk is fully blocked and theres a lot of debris",
      "its grown from 2 tents to about 8 in a month. trash is piling up around it",
      "requesting outreach services, theres an older man there who needs medical help",
      "kids walk this route to school and have to go into the street",
    ],
  },
  infrastructure: {
    titles: [
      "broken sprinkler flooding the sidewalk on {street}",
      "fire hydrant leaking on {street}",
      "water main leaking into the street",
      "broken streetlight on {street}",
      "exposed wiring on the light pole",
    ],
    descs: [
      "water has been running down the gutter for 3 days straight. huge waste",
      "the whole corner is flooded every morning. slipping hazard",
      "light has been out for weeks, its really dark on this block at night. safety issue",
      "you can hear the water hissing, probably losing hundreds of gallons",
    ],
    descsEs: ["el poste tiene cables colgando, esta peligroso"],
  },
  pavement: {
    titles: [
      "huge pothole on {street}",
      "sidewalk buckled by tree roots on {street}",
      "pothole damaging cars near {street} and {street2}",
      "cracked curb ramp on the corner",
      "street cracking apart on {street}",
    ],
    descs: [
      "hit it last night, almost lost a tire. its deep",
      "my neighbor in a wheelchair literally cannot use this sidewalk",
      "gets worse every week, and cars swerve into the other lane to miss it",
      "seniors trip here all the time, someone fell last week",
      "been reported before and patched but the patch is already gone",
    ],
    descsEs: ["el bache esta enorme, ya varios carros se han danado"],
  },
  vegetation: {
    titles: [
      "overgrown weeds blocking the sidewalk on {street}",
      "dead palm fronds hanging over {street}",
      "tree branch about to fall on {street}",
      "brush pile fire hazard by {street}",
    ],
    descs: [
      "the weeds are shoulder height, you cant see around the corner when driving",
      "big dead frond hanging right over the bus stop. someone is gonna get hurt",
      "branch cracked in the wind last week and is hanging by a thread",
      "dry brush right up against the fence, one spark and its a problem",
    ],
    descsEs: ["las ramas ya tapan toda la banqueta"],
  },
  other: {
    titles: [
      "abandoned car on {street}",
      "shopping carts collecting on the corner",
      "broken glass all over the sidewalk",
      "dead animal on {street}",
      "leaking dumpster behind the businesses",
    ],
    descs: [
      "hasnt moved in 3 weeks, flat tires, windows are smashed now",
      "at least 6 carts from the ranch market piling up",
      "please send someone, its been days and it smells really bad",
      "someone smashed bottles all over, dogs and kids walk here",
      "grease and trash water running into the gutter",
    ],
  },
}

const EVENT_TITLE_EN: readonly string[] = [
  "{park} cleanup",
  "{hood} community cleanup",
  "{street} alley cleanup",
  "adopt-a-block {hood}",
  "{hood} saturday sweep",
]
const EVENT_TITLE_ES: readonly string[] = ["limpieza comunitaria en {park}"]

const EVENT_DESC_EN: readonly string[] = [
  "meet at the main entrance. we'll split into teams and cover the park and the streets around it. bags and some grabbers provided, bring gloves and water if you can",
  "monthly cleanup with the neighbors. all ages welcome, we usually finish by noon and someone always brings tamales",
  "the alley has gotten bad again so we're getting a crew together. wear closed toe shoes, there might be glass",
  "quick 2 hour cleanup then tacos after for whoever can stay. first timers welcome, we'll show you the ropes",
  "bringing the community together to take care of our space. supplies provided by the neighborhood council",
]
const EVENT_DESC_ES: readonly string[] = [
  "juntandonos para limpiar el parque y las calles de alrededor. traigan guantes si tienen, nosotros ponemos las bolsas",
]

const BRING_POOL: readonly string[] = [
  "gloves",
  "water",
  "sunscreen",
  "hat",
  "trash grabbers",
  "closed toe shoes",
  "reusable water bottle",
]

const SLOT_SETS: readonly (readonly {
  title: string
  description: string | null
  capacity: number | null
}[])[] = [
  [
    {
      title: "Registration table",
      description: "check people in and hand out supplies",
      capacity: 2,
    },
    { title: "Supplies and water", description: "keep the water station stocked", capacity: 2 },
    { title: "Street team", description: "cover the blocks around the park", capacity: null },
  ],
  [
    { title: "8-10am shift", description: null, capacity: 12 },
    { title: "10-12 shift", description: null, capacity: 12 },
  ],
  [
    {
      title: "Heavy lifting crew",
      description: "for the big stuff, bring work gloves",
      capacity: 6,
    },
    { title: "General cleanup", description: null, capacity: null },
    { title: "Kids zone", description: "light duty for families with little ones", capacity: 8 },
  ],
]

const TIMELINE_ACK_NOTES: readonly string[] = [
  "Forwarded to LA Sanitation",
  "Routed to the responsible department",
  "Received by the city, reference logged",
]
const TIMELINE_RESOLVE_NOTES: readonly string[] = [
  "Crew confirmed pickup complete",
  "Marked resolved after site inspection",
  "Cleared by sanitation crew",
]

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

function makeUsers(count: number, start: Date, end: Date): SeedUser[] {
  const usedHandles = new Set<string>()
  const users: SeedUser[] = []
  for (let i = 0; i < count; i++) {
    const hispanic = chance(0.7)
    const female = chance(0.52)
    let first: string
    let last: string
    if (hispanic) {
      first = female ? pick(HISPANIC_FIRST_F) : pick(HISPANIC_FIRST_M)
      last = pick(HISPANIC_LAST)
    } else {
      const pool = pickWeighted(OTHER_POOLS.map((p) => [p, p.weight] as const))
      first = female ? pick(pool.firstF) : pick(pool.firstM)
      last = pick(pool.last)
    }

    const dFirst = hispanic && chance(0.35) ? (ACCENTED[first] ?? first) : first
    const dLast = hispanic && chance(0.2) ? (ACCENTED[last] ?? last) : last
    const displayName = pickWeighted<string>([
      [`${dFirst} ${dLast}`, 55],
      [`${dFirst} ${dLast[0]}.`, 15],
      [dFirst, 10],
      [`${dFirst.toLowerCase()} ${dLast.toLowerCase()}`, 10],
      [
        `${dFirst} ${dLast}`.toUpperCase() === `${dFirst} ${dLast}`
          ? `${dFirst} ${dLast}`
          : `${dFirst} ${dLast}`,
        10,
      ],
    ])

    // Must match HANDLE_REGEX (3-20 of [A-Za-z0-9_]).
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
    let handle = ""
    for (const c of shuffle(candidates)) {
      const h = c.slice(0, 20)
      if (h.length >= 3 && !usedHandles.has(h)) {
        handle = h
        break
      }
    }
    if (!handle) {
      let n = rint(10, 9999)
      while (usedHandles.has(`${fl}${n}`.slice(0, 20))) n++
      handle = `${fl}${n}`.slice(0, 20)
    }
    usedHandles.add(handle)

    const hood = pickWeighted(HOODS.map((h) => [h, h.weight] as const))
    const tier = pickWeighted<Tier>([
      ["power", 15],
      ["casual", 45],
      ["light", 28],
      ["lurker", 12],
    ])
    const popularity =
      Math.exp((rand() + rand() + rand() - 1.5) * 1.6) *
      (tier === "power" ? 3 : tier === "casual" ? 1.2 : 0.6)

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
    if (chance(0.62)) {
      const bioPool: string[] = [...BIO_NEUTRAL, ...(female ? BIO_FEMALE : BIO_MALE)]
      if (hispanic) {
        bioPool.push(...BIO_HISPANIC_NEUTRAL, ...(female ? BIO_HISPANIC_F : BIO_HISPANIC_M))
      }
      user.bio = fill(pick(bioPool), user, { street: pick(hood.streets) })
    }
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

function makeEvents(users: SeedUser[], now: Date): SeedEvent[] {
  const organizers = shuffle(users.filter((u) => u.tier === "power")).slice(0, 14)
  const events: SeedEvent[] = []
  const parkPool = shuffle([...PARKS])
  const count = 20
  for (let i = 0; i < count; i++) {
    const organizer = organizers[i % organizers.length]!
    const park = parkPool[i % parkPool.length]!
    const hood = hoodByName(park.hood)
    const kind: SeedEvent["status"] = i < 13 ? "done" : i === 13 ? "cancelled" : "upcoming"
    const scheduledAt =
      kind === "upcoming"
        ? nextSaturdayish(now, rint(3, 21))
        : nextSaturdayish(
            new Date(later(organizer.createdAt, new Date(now.getTime() - 150 * DAY)).getTime()),
            rint(7, 120),
            now,
          )
    // The create must land in the PAST even for upcoming events (scheduled_at - 2d can exceed now
    // when the event is less than 2 days out, which would backdate joins into the future).
    const createdCeiling = new Date(
      Math.min(scheduledAt.getTime() - 2 * DAY, now.getTime() - 6 * 3600_000),
    )
    const createdAt = randTimestamp(
      later(organizer.createdAt, new Date(scheduledAt.getTime() - 28 * DAY)),
      createdCeiling,
    )
    const { lat, lng } = jitterPoint(park.lat, park.lng, 0.0015)
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

    const memberTarget = kind === "cancelled" ? rint(3, 8) : rint(6, 26)
    const weight = (c: SeedUser) =>
      (c.hood.name === hood.name ? 4 : 1) *
      (c.tier === "lurker" ? 0.3 : 1) *
      Math.sqrt(c.popularity)
    const joiners = sampleWeighted(users, weight, memberTarget, new Set([organizer]))
    const joinEnd = kind === "upcoming" ? now : scheduledAt
    for (const [j, u] of joiners.entries()) {
      const joinedAt = randTimestamp(later(u.createdAt, createdAt), joinEnd)
      const role = j === 0 && chance(0.4) ? "cohost" : "member"
      if (role === "cohost") ev.cohost = u
      ev.members.push({ user: u, role, joinedAt })
    }

    // A richer board on ~40% of events and 0169's default slot on every other OPEN one (past and
    // cancelled keep the empty board it skips); claims from members only, capacity respected.
    if (chance(0.4)) {
      const set = pick(SLOT_SETS)
      ev.slots = set.map((s, idx) => ({ id: randomUUID(), ...s, sortOrder: idx }))
    } else if (kind === "upcoming") {
      ev.slots = [
        {
          id: randomUUID(),
          title: DEFAULT_EVENT_SLOT_TITLE,
          description: null,
          capacity: ev.capacity,
          sortOrder: 0,
        },
      ]
    }
    if (ev.slots.length > 0) {
      const claimed = new Set<string>()
      for (const m of ev.members) {
        if (m.role === "organizer" || !chance(0.5)) continue
        const open = ev.slots.filter(
          (s) =>
            s.capacity === null || ev.claims.filter((c) => c.slotId === s.id).length < s.capacity,
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
    events.push(ev)
  }
  return events
}

function nextSaturdayish(base: Date, minDays: number, latest?: Date): Date {
  let d = new Date(base.getTime() + minDays * DAY)
  for (let i = 0; i < 7; i++) {
    const dow = new Date(d.getTime() + i * DAY).getUTCDay()
    if (dow === 6 || (dow === 0 && chance(0.4))) {
      d = new Date(d.getTime() + i * DAY)
      break
    }
  }
  if (latest && d.getTime() >= latest.getTime()) d = new Date(latest.getTime() - DAY)
  return laLocalToUtc(d.getTime(), 9, pick([0, 0, 30]), 0)
}

function makeReports(users: SeedUser[], count: number, now: Date): SeedReport[] {
  const reports: SeedReport[] = []
  for (let i = 0; i < count; i++) {
    const reporter = pickWeighted(
      users.map(
        (u) =>
          [
            u,
            u.tier === "power" ? 4 : u.tier === "casual" ? 2 : u.tier === "light" ? 1 : 0.2,
          ] as const,
      ),
    )
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

    const timeline: SeedReport["timeline"] = [
      { status: "submitted", note: null, createdAt, actorId: reporter.id },
    ]
    let publishedAt: Date | null = null
    if (status !== "submitted") {
      publishedAt = minutesAfter(createdAt, 1, 10)
      timeline.push({ status: "published", note: null, createdAt: publishedAt, actorId: null })
    }
    let cursor = publishedAt ?? createdAt
    if (status === "acknowledged" || status === "in_progress" || status === "resolved") {
      cursor = randTimestamp(cursor, new Date(Math.min(cursor.getTime() + 10 * DAY, now.getTime())))
      timeline.push({
        status: "acknowledged",
        note: pick(TIMELINE_ACK_NOTES),
        createdAt: cursor,
        actorId: null,
      })
    }
    if (status === "in_progress" || (status === "resolved" && chance(0.5))) {
      cursor = randTimestamp(cursor, new Date(Math.min(cursor.getTime() + 12 * DAY, now.getTime())))
      timeline.push({ status: "in_progress", note: null, createdAt: cursor, actorId: null })
    }
    if (status === "resolved") {
      cursor = randTimestamp(cursor, new Date(Math.min(cursor.getTime() + 15 * DAY, now.getTime())))
      timeline.push({
        status: "resolved",
        note: chance(0.6) ? pick(TIMELINE_RESOLVE_NOTES) : null,
        createdAt: cursor,
        actorId: null,
      })
    }

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

function makePosts(
  users: SeedUser[],
  events: SeedEvent[],
  reports: SeedReport[],
  follows: SeedFollow[],
  now: Date,
): SeedPost[] {
  const posts: SeedPost[] = []
  const byId = new Map(users.map((u) => [u.id, u]))
  const followersOf = new Map<string, SeedUser[]>()
  for (const f of follows) {
    const arr = followersOf.get(f.followeeId) ?? []
    arr.push(byId.get(f.followerId)!)
    followersOf.set(f.followeeId, arr)
  }

  const addTop = (
    author: SeedUser,
    body: string,
    createdAt: Date,
    eventId: string | null,
    reportId: string | null,
  ) => {
    const p: SeedPost = {
      id: randomUUID(),
      author,
      kind: "post",
      body,
      replyTo: null,
      threadRoot: null,
      repostOf: null,
      eventId,
      reportId,
      createdAt,
      depth: 0,
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
      saveCount: 0,
      mentions: [],
    }
    posts.push(p)
    return p
  }

  for (const u of users) {
    const n =
      u.tier === "power"
        ? rint(4, 10)
        : u.tier === "casual"
          ? rint(1, 4)
          : u.tier === "light"
            ? rint(0, 2)
            : 0
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
      const recapAt = minutesAfter(ev.scheduledAt, 3 * 60, 30 * 60)
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

  for (const r of reports) {
    if (r.status === "submitted" || !chance(0.3)) continue
    const at = minutesAfter(r.publishedAt ?? r.createdAt, 5, 36 * 60)
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

  const topLevel = posts.filter((p) => p.depth === 0)
  for (const p of topLevel) {
    const base = p.eventId ? 2.2 : p.reportId ? 1.6 : 1
    const n = Math.min(
      14,
      Math.floor(Math.pow(rand(), 1.8) * 7 * base * Math.sqrt(p.author.popularity)),
    )
    // One reply per person per thread (the root author may answer their own thread), and no
    // repeated body text within a thread; both read as bots otherwise.
    const threadRepliers = new Set<string>()
    const threadBodies = new Set<string>()
    let parent: SeedPost = p
    for (let i = 0; i < n; i++) {
      parent = chance(0.75)
        ? p
        : posts[posts.length - 1]!.depth > 0 && chance(0.5)
          ? posts[posts.length - 1]!
          : p
      if (parent.depth >= 3) parent = p
      const followerPool = followersOf.get(parent.author.id) ?? []
      const replier =
        parent.depth > 0 && parent.author.id !== p.author.id && chance(0.4)
          ? p.author
          : followerPool.length > 0 && chance(0.65)
            ? pick(followerPool)
            : pickWeighted(users.map((u) => [u, u.tier === "lurker" ? 0.2 : 1] as const))
      if (replier.id === parent.author.id) continue
      if (replier.id !== p.author.id && threadRepliers.has(replier.id)) continue
      const start = later(replier.createdAt, parent.createdAt)
      const end = new Date(Math.min(parent.createdAt.getTime() + 5 * DAY, now.getTime()))
      if (start.getTime() >= end.getTime()) continue
      const [poolEn, poolEs] = parent.eventId
        ? [REPLY_EVENT_EN, REPLY_EVENT_ES]
        : parent.reportId
          ? [REPLY_REPORT_EN, REPLY_REPORT_ES]
          : [REPLY_GENERIC_EN, REPLY_GENERIC_ES]
      let body = fill(bilingual(replier, poolEn, poolEs), replier)
      if (threadBodies.has(body)) continue
      threadBodies.add(body)
      threadRepliers.add(replier.id)
      const mentions: string[] = []
      if (parent.depth > 0 && chance(0.3)) {
        body = `@${parent.author.handle} ${body}`
        mentions.push(parent.author.id)
      }
      const reply: SeedPost = {
        id: randomUUID(),
        author: replier,
        kind: "reply",
        body,
        replyTo: parent,
        threadRoot: parent.depth === 0 ? parent : (parent.threadRoot ?? parent),
        repostOf: null,
        eventId: null,
        reportId: null,
        createdAt: randTimestamp(start, end),
        depth: parent.depth + 1,
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        saveCount: 0,
        mentions,
      }
      parent.replyCount++
      posts.push(reply)
    }
  }

  const repostKeys = new Set<string>()
  const popularTargets = topLevel.filter((p) => (followersOf.get(p.author.id)?.length ?? 0) >= 3)
  for (const target of popularTargets) {
    const nReposts = chance(0.16) ? rint(1, 3) : 0
    const nQuotes = chance(0.07) ? rint(1, 2) : 0
    const pool = followersOf.get(target.author.id) ?? []
    for (let i = 0; i < nReposts && pool.length > 0; i++) {
      const reposter = pick(pool)
      const k = `${reposter.id}:${target.id}`
      if (reposter.id === target.author.id || repostKeys.has(k)) continue
      const start = later(reposter.createdAt, target.createdAt)
      const end = new Date(Math.min(target.createdAt.getTime() + 7 * DAY, now.getTime()))
      if (start.getTime() >= end.getTime()) continue
      repostKeys.add(k)
      posts.push({
        id: randomUUID(),
        author: reposter,
        kind: "repost",
        body: null,
        replyTo: null,
        threadRoot: null,
        repostOf: target,
        eventId: null,
        reportId: null,
        createdAt: randTimestamp(start, end),
        depth: 1,
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        saveCount: 0,
        mentions: [],
      })
      target.repostCount++ // pure reposts only, matching the live repost() path
    }
    for (let i = 0; i < nQuotes && pool.length > 0; i++) {
      const quoter = pick(pool)
      if (quoter.id === target.author.id) continue
      const start = later(quoter.createdAt, target.createdAt)
      const end = new Date(Math.min(target.createdAt.getTime() + 7 * DAY, now.getTime()))
      if (start.getTime() >= end.getTime()) continue
      posts.push({
        id: randomUUID(),
        author: quoter,
        kind: "quote",
        body: fill(bilingual(quoter, QUOTE_EN, QUOTE_ES), quoter),
        replyTo: null,
        threadRoot: null,
        repostOf: target,
        eventId: null,
        reportId: null,
        createdAt: randTimestamp(start, end),
        depth: 1,
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        saveCount: 0,
        mentions: [],
      })
      // Quotes do NOT bump repost_count (createPost has no bump for kind='quote').
    }
  }

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
  const byId = new Map(users.map((u) => [u.id, u]))
  const followersOf = new Map<string, SeedUser[]>()
  for (const f of follows) {
    const arr = followersOf.get(f.followeeId) ?? []
    arr.push(byId.get(f.followerId)!)
    followersOf.set(f.followeeId, arr)
  }
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
    const n = Math.min(Math.floor(base), 60)
    for (let i = 0; i < n; i++) {
      const liker =
        followerPool.length > 0 && chance(0.7)
          ? pick(followerPool)
          : pickWeighted(users.map((u) => [u, u.tier === "lurker" ? 0.6 : 1] as const))
      if (liker.id === p.author.id) continue
      const k = `${p.id}:${liker.id}`
      if (likeKeys.has(k)) continue
      const start = later(liker.createdAt, p.createdAt)
      const end = new Date(Math.min(p.createdAt.getTime() + 14 * DAY, now.getTime()))
      if (start.getTime() >= end.getTime()) continue
      likeKeys.add(k)
      likes.push({ postId: p.id, userId: liker.id, createdAt: randTimestamp(start, end) })
      p.likeCount++
      if (chance(0.06)) {
        const sk = `${p.id}:${liker.id}`
        if (!saveKeys.has(sk)) {
          saveKeys.add(sk)
          saves.push({ postId: p.id, userId: liker.id, createdAt: randTimestamp(start, end) })
          p.saveCount++
        }
      }
    }
  }
  return { likes, saves }
}

function makeHours(events: SeedEvent[], now: Date): SeedHours[] {
  const rows: SeedHours[] = []
  for (const ev of events) {
    if (ev.status !== "done") continue
    const loggedAt = minutesAfter(ev.scheduledAt, 4 * 60, 48 * 60)
    if (loggedAt.getTime() >= now.getTime()) continue
    for (const m of ev.members) {
      if (m.role !== "organizer" && !chance(0.85)) continue // a few no-shows never get credited
      const hours = (pick([1.5, 2, 2, 2.5, 2.5, 3, 3, 3.5, 4]) as number).toFixed(2)
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

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/

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
  const ids = new Set(users.map((u) => u.id))
  const handles = new Set<string>()
  const emails = new Set<string>()
  for (const u of users) {
    if (!HANDLE_RE.test(u.handle)) errors.push(`bad handle: ${u.handle}`)
    if (handles.has(u.handle.toLowerCase())) errors.push(`dup handle: ${u.handle}`)
    handles.add(u.handle.toLowerCase())
    if (emails.has(u.email)) errors.push(`dup email: ${u.email}`)
    emails.add(u.email)
    if (!u.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`))
      errors.push(`email outside demo domain: ${u.email}`)
  }
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
  const likeAgg = new Map<string, number>()
  for (const l of likes) likeAgg.set(l.postId, (likeAgg.get(l.postId) ?? 0) + 1)
  const saveAgg = new Map<string, number>()
  for (const s of saves) saveAgg.set(s.postId, (saveAgg.get(s.postId) ?? 0) + 1)
  const replyAgg = new Map<string, number>()
  const repostAgg = new Map<string, number>()
  const repostKeys = new Set<string>()
  for (const p of posts) {
    if (p.body && p.body.includes("\u2014"))
      errors.push(`em dash in post body: ${p.body.slice(0, 40)}`)
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
  for (const r of reports) {
    for (let i = 1; i < r.timeline.length; i++) {
      if (r.timeline[i]!.createdAt.getTime() < r.timeline[i - 1]!.createdAt.getTime())
        errors.push("timeline out of order")
    }
    if (r.description.includes("\u2014") || r.title.includes("\u2014"))
      errors.push("em dash in report")
  }
  if (errors.length > 0) {
    throw new Error(
      `seed validation failed (${errors.length}):\n  ${[...new Set(errors)].slice(0, 25).join("\n  ")}`,
    )
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function writeAll(
  tx: TransactionSql,
  data: {
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
  },
): Promise<void> {
  const { now, users, follows, events, reports, posts, likes, saves, hours } = data
  const resolver = tx as unknown as Sql

  for (const rows of chunk(users, 200)) {
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
  for (const rows of chunk(users, 300)) {
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

  for (const rows of chunk(follows, 500)) {
    await tx`INSERT INTO follows_people ${tx(
      rows.map((f) => ({
        follower_id: f.followerId,
        followee_id: f.followeeId,
        created_at: f.createdAt,
      })),
    )}`
  }

  // Per row, with the reference-code counter allocated first as in createCleanupTx (lock order).
  for (const ev of events) {
    const jur = await resolveJurisdiction(resolver, ev.lng, ev.lat)
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
        hashFor: data.hashFor,
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

  // Per row, with the reference-code counter allocated first (lock order).
  for (const r of reports) {
    const jur = await resolveJurisdiction(resolver, r.lng, r.lat)
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
  for (const rows of chunk(timelineRows, 500)) {
    await tx`INSERT INTO report_timeline ${tx(rows)}`
  }

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

  // Dependency waves: parents before replies, targets before reposts and quotes.
  const waves = new Map<number, SeedPost[]>()
  for (const p of posts) {
    const arr = waves.get(p.depth) ?? []
    arr.push(p)
    waves.set(p.depth, arr)
  }
  for (const depth of [...waves.keys()].sort((a, b) => a - b)) {
    for (const rows of chunk(waves.get(depth)!, 300)) {
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
  for (const ids of chunk(linkedPostIds, 500)) {
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
  for (const rows of chunk(mentionRows, 500)) {
    await tx`INSERT INTO post_mentions ${tx(rows)}`
  }
  for (const rows of chunk(likes, 800)) {
    await tx`INSERT INTO post_likes ${tx(
      rows.map((l) => ({ post_id: l.postId, user_id: l.userId, created_at: l.createdAt })),
    )}`
  }
  for (const rows of chunk(saves, 800)) {
    await tx`INSERT INTO post_saves ${tx(
      rows.map((s) => ({ post_id: s.postId, user_id: s.userId, created_at: s.createdAt })),
    )}`
  }

  for (const rows of chunk(hours, 300)) {
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
  for (const rows of chunk(rollupRows, 500)) {
    await tx`
      INSERT INTO user_jurisdiction_hours ${tx(rows)}
      ON CONFLICT (user_id, jurisdiction_geoid)
      DO UPDATE SET total_hours = user_jurisdiction_hours.total_hours + EXCLUDED.total_hours
    `
  }
}

// Runs inside the seed transaction, so a mismatch rolls the whole seed back.

async function verify(tx: TransactionSql, now: Date): Promise<string[]> {
  const lines: string[] = []
  const fail: string[] = []
  const demoEmail = "%@" + DEMO_EMAIL_DOMAIN
  const checks: { label: string; rows: Promise<{ n: number | string }[]> }[] = [
    {
      label: "demo members of open events hold a registration",
      rows: tx`
        SELECT count(*)::int AS n FROM cleanup_members m
        JOIN cleanups c ON c.id = m.cleanup_id
        JOIN users u ON u.id = m.user_id
        WHERE u.email LIKE ${demoEmail} AND c.status <> 'cancelled' AND c.ends_at > ${now}
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
        WHERE u.email LIKE ${demoEmail} AND p.geom IS NULL
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
  const demo = tx`SELECT id FROM users WHERE email LIKE ${"%@" + DEMO_EMAIL_DOMAIN}`
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
  const demo = tx`SELECT id FROM users WHERE email LIKE ${"%@" + DEMO_EMAIL_DOMAIN}`
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
    tx`DELETE FROM users WHERE email LIKE ${"%@" + DEMO_EMAIL_DOMAIN} RETURNING 1 AS one`,
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

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

export async function main(): Promise<void> {
  const commit = process.argv.includes("--yes")
  const purgeMode = process.argv.includes("--purge")
  const userCount = Number(argValue("--users") ?? 250)
  const prngSeed = Number(argValue("--seed") ?? 20260902)
  rand = mulberry32(prngSeed)

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required")
  }
  const host = new URL(databaseUrl).host
  console.log(`target database: ${host}`)
  console.log(
    commit
      ? "mode: COMMIT"
      : "mode: rehearsal (full run + verification, then ROLLBACK; pass --yes to commit)",
  )

  const handle = makeDb(databaseUrl, { max: 1, statementTimeoutMs: 0, idleInTxTimeoutMs: 0 })
  const ROLLBACK = Symbol("rollback")
  try {
    if (purgeMode) {
      const result = await handle.sql
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
      return
    }

    const hashFor = demoTicketTokenHasher()
    const now = new Date()
    const start = new Date(now.getTime() - 185 * DAY)

    console.log(`generating cohort (seed ${prngSeed})...`)
    const users = makeUsers(userCount, start, new Date(now.getTime() - 2 * DAY))
    const follows = makeFollows(users, now)
    const events = makeEvents(users, now)
    const reports = makeReports(users, Math.round(userCount * 0.62), now)
    const posts = makePosts(users, events, reports, follows, now)
    const { likes, saves } = makeLikesAndSaves(users, posts, follows, now)
    const hours = makeHours(events, now)
    validate(users, follows, events, reports, posts, likes, saves)

    const memberRows = events.reduce((n, e) => n + e.members.length, 0)
    const claimRows = events.reduce((n, e) => n + e.claims.length, 0)
    console.log(
      [
        `  users: ${users.length}  (hispanic ~${users.filter((u) => u.hispanic).length})`,
        `  follows: ${follows.length}`,
        `  events: ${events.length}  members: ${memberRows}  slot claims: ${claimRows}`,
        `  reports: ${reports.length}  timeline rows: ${reports.reduce((n, r) => n + r.timeline.length, 0)}`,
        `  posts: ${posts.filter((p) => p.kind === "post").length} top-level, ${posts.filter((p) => p.kind === "reply").length} replies, ` +
          `${posts.filter((p) => p.kind === "repost").length} reposts, ${posts.filter((p) => p.kind === "quote").length} quotes`,
        `  likes: ${likes.length}  saves: ${saves.length}  volunteer hour rows: ${hours.length}`,
      ].join("\n"),
    )

    const verification = await handle.sql
      .begin(async (tx) => {
        const [existing] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM users WHERE email LIKE ${"%@" + DEMO_EMAIL_DOMAIN}
        `
        if (Number(existing?.n ?? 0) > 0) {
          throw new Error(
            `found ${existing!.n} existing demo users (@${DEMO_EMAIL_DOMAIN}); run --purge --yes first`,
          )
        }
        console.log("writing...")
        await writeAll(tx, {
          now,
          hashFor,
          users,
          follows,
          events,
          reports,
          posts,
          likes,
          saves,
          hours,
        })
        console.log("verifying...")
        const lines = await verify(tx, now)
        if (!commit) throw ROLLBACK
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
  } finally {
    await handle.close()
  }
}

runIfMain(import.meta.url, "seed-demo-la", main)
