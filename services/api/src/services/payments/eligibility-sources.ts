import type {
  EligibilitySourceValue,
  EligibilityVerdictContribution,
} from "../../db/schema/types-payments.js"

export type SourceContainer = "zip" | "plain"
export type SourceDelimiter = "|" | ","
export type SourceMatchKey = "ein" | "name"

export interface IrsAddress {
  line1: string | null
  city: string | null
  state: string | null
  postalCode: string | null
}

export interface DecodedRow {
  ein: string | null
  name: string | null
  deductibilityCode: string | null
  foundationCode: string | null
  address: IrsAddress | null
  groupExemptionSubordinate: boolean | null
  disqualifies: boolean
  detail: string | null
}

export type HeaderIndex = Readonly<Record<string, number>>

export interface SourceDecoder {
  bindHeader(headerFields: readonly string[]): HeaderIndex | null
  decode(fields: readonly string[], header: HeaderIndex | null): DecodedRow | null
}

export interface EligibilitySourceSpec {
  source: EligibilitySourceValue
  urls: readonly string[]
  contribution: EligibilityVerdictContribution
  retentionYears: number
  container: SourceContainer
  delimiter: SourceDelimiter
  hasHeader: boolean
  matchOn: SourceMatchKey
  minRows: number
  maxBytesPerPart: number
  decoder: SourceDecoder
}

export const DEFAULT_SOURCE_MAX_BYTES = 128 * 1024 * 1024

export const BMF_SOURCE_MAX_BYTES = 256 * 1024 * 1024

export const MIN_DECODE_RATIO = 0.9

export function normalizeEin(value: string): string | null {
  const digits = value.replace(/\D/g, "")
  return digits.length === 9 ? digits : null
}

const NAME_SUFFIXES: ReadonlySet<string> = new Set([
  "INC",
  "INCORPORATED",
  "LLC",
  "LTD",
  "LIMITED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
])

export function normalizeOrgName(value: string | null | undefined): string {
  if (value === null || value === undefined) return ""
  const tokens = value
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0)
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1] as string)) tokens.pop()
  if (tokens.length > 1 && tokens[0] === "THE") tokens.shift()
  return tokens.join(" ")
}

export function normalizeHeader(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
}

function blank(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function bindByCandidates(
  headerFields: readonly string[],
  wanted: Readonly<Record<string, readonly string[]>>,
  required: readonly string[],
): HeaderIndex | null {
  const normalized = headerFields.map(normalizeHeader)
  const index: Record<string, number> = {}
  for (const [key, candidates] of Object.entries(wanted)) {
    const position = normalized.findIndex((header) => candidates.includes(header))
    if (position >= 0) index[key] = position
  }
  for (const key of required) if (index[key] === undefined) return null
  return index
}

function field(fields: readonly string[], header: HeaderIndex | null, key: string): string | null {
  if (header === null) return null
  const position = header[key]
  return position === undefined ? null : blank(fields[position])
}

const pub78Decoder: SourceDecoder = {
  bindHeader: () => null,
  decode(fields) {
    if (fields.length < 2) return null
    const ein = normalizeEin(fields[0] as string)
    if (ein === null) return null
    const deductibility = blank(fields[5])
    return {
      ein,
      name: blank(fields[1]),
      deductibilityCode: deductibility,
      foundationCode: null,
      address: { line1: null, city: blank(fields[2]), state: blank(fields[3]), postalCode: null },
      groupExemptionSubordinate: null,
      disqualifies: false,
      detail: deductibility === null ? null : `deductibility=${deductibility}`,
    }
  },
}

const BMF_COLUMNS = {
  ein: ["EIN"],
  name: ["NAME"],
  street: ["STREET"],
  city: ["CITY"],
  state: ["STATE"],
  zip: ["ZIP"],
  affiliation: ["AFFILIATION"],
  deductibility: ["DEDUCTIBILITY"],
  foundation: ["FOUNDATION"],
  status: ["STATUS"],
} as const

export const BMF_SUBORDINATE_AFFILIATION = "9"

const bmfDecoder: SourceDecoder = {
  bindHeader(headerFields) {
    return bindByCandidates(headerFields, BMF_COLUMNS, Object.keys(BMF_COLUMNS))
  },
  decode(fields, header) {
    if (header === null) return null
    const raw = field(fields, header, "ein")
    if (raw === null) return null
    const ein = normalizeEin(raw)
    if (ein === null) return null
    const affiliation = field(fields, header, "affiliation")
    const status = field(fields, header, "status")
    return {
      ein,
      name: field(fields, header, "name"),
      deductibilityCode: field(fields, header, "deductibility"),
      foundationCode: field(fields, header, "foundation"),
      address: {
        line1: field(fields, header, "street"),
        city: field(fields, header, "city"),
        state: field(fields, header, "state"),
        postalCode: field(fields, header, "zip"),
      },
      groupExemptionSubordinate: affiliation === BMF_SUBORDINATE_AFFILIATION,
      disqualifies: false,
      detail: `affiliation=${affiliation ?? "?"};status=${status ?? "?"}`,
    }
  },
}

export const AUTO_REVOCATION_MIN_FIELDS = 12
const AUTO_REVOCATION_REVOKED_ON = 9
const AUTO_REVOCATION_REINSTATED_ON = 11

const autoRevocationDecoder: SourceDecoder = {
  bindHeader: () => null,
  decode(fields) {
    if (fields.length < AUTO_REVOCATION_MIN_FIELDS) return null
    const ein = normalizeEin(fields[0] as string)
    if (ein === null) return null
    const revokedOn = blank(fields[AUTO_REVOCATION_REVOKED_ON])
    const reinstatedOn = blank(fields[AUTO_REVOCATION_REINSTATED_ON])
    return {
      ein,
      name: blank(fields[1]),
      deductibilityCode: null,
      foundationCode: null,
      address: null,
      groupExemptionSubordinate: null,
      disqualifies: reinstatedOn === null,
      detail:
        reinstatedOn === null
          ? `revoked=${revokedOn ?? "?"}`
          : `revoked=${revokedOn ?? "?"};reinstated=${reinstatedOn}`,
    }
  },
}

const EIN_HEADERS: readonly string[] = [
  "FEIN",
  "EIN",
  "FEDERAL EIN",
  "FEDERAL ID",
  "FEDERAL ID NUMBER",
  "FEDERAL EMPLOYER IDENTIFICATION NUMBER",
  "FEDERAL EMPLOYER ID",
  "FEDERAL TAX ID",
]

function headerEinDecoder(
  nameHeaders: readonly string[],
  extra: Readonly<Record<string, readonly string[]>>,
): SourceDecoder {
  const wanted = { ein: EIN_HEADERS, name: nameHeaders, ...extra }
  return {
    bindHeader(headerFields) {
      return bindByCandidates(headerFields, wanted, ["ein", "name"])
    },
    decode(fields, header) {
      if (header === null) return null
      const raw = field(fields, header, "ein")
      if (raw === null) return null
      const ein = normalizeEin(raw)
      if (ein === null) return null
      const details = Object.keys(extra)
        .map((key) => [key, field(fields, header, key)] as const)
        .filter((entry): entry is readonly [string, string] => entry[1] !== null)
        .map(([key, value]) => `${key}=${value}`)
      return {
        ein,
        name: field(fields, header, "name"),
        deductibilityCode: null,
        foundationCode: null,
        address: null,
        groupExemptionSubordinate: null,
        disqualifies: true,
        detail: details.length === 0 ? null : details.join(";"),
      }
    },
  }
}

const OFAC_NULL = "-0-"

const ofacDecoder: SourceDecoder = {
  bindHeader: () => null,
  decode(fields) {
    if (fields.length < 4) return null
    const entryNumber = blank(fields[0])
    const name = blank(fields[1])
    if (entryNumber === null || name === null || name === OFAC_NULL) return null
    const type = blank(fields[2])
    const program = blank(fields[3])
    return {
      ein: null,
      name,
      deductibilityCode: null,
      foundationCode: null,
      address: null,
      groupExemptionSubordinate: null,
      disqualifies: false,
      detail: `sdn=${entryNumber};type=${type ?? "?"};program=${program ?? "?"}`,
    }
  },
}

const centralOrgDecoder: SourceDecoder = {
  bindHeader: () => null,
  decode: () => null,
}

export const ELIGIBILITY_SOURCES: Readonly<Record<EligibilitySourceValue, EligibilitySourceSpec>> = {
  irs_pub78: {
    source: "irs_pub78",
    urls: ["https://apps.irs.gov/pub/epostcard/data-download-pub78.zip"],
    contribution: "supports",
    retentionYears: 7,
    container: "zip",
    delimiter: "|",
    hasHeader: false,
    matchOn: "ein",
    minRows: 100_000,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: pub78Decoder,
  },
  irs_eo_bmf: {
    source: "irs_eo_bmf",
    urls: [
      "https://www.irs.gov/pub/irs-soi/eo1.csv",
      "https://www.irs.gov/pub/irs-soi/eo2.csv",
      "https://www.irs.gov/pub/irs-soi/eo3.csv",
      "https://www.irs.gov/pub/irs-soi/eo4.csv",
    ],
    contribution: "supports",
    retentionYears: 7,
    container: "plain",
    delimiter: ",",
    hasHeader: true,
    matchOn: "ein",
    minRows: 100_000,
    maxBytesPerPart: BMF_SOURCE_MAX_BYTES,
    decoder: bmfDecoder,
  },
  irs_auto_revocation: {
    source: "irs_auto_revocation",
    urls: ["https://apps.irs.gov/pub/epostcard/data-download-revocation.zip"],
    contribution: "disqualifies",
    retentionYears: 7,
    container: "zip",
    delimiter: "|",
    hasHeader: false,
    matchOn: "ein",
    minRows: 50_000,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: autoRevocationDecoder,
  },
  ftb_revoked: {
    source: "ftb_revoked",
    urls: [
      "https://www.ftb.ca.gov/about-ftb/newsroom/revoked-exempt-organizations/revoked-exempt-organizations.csv",
    ],
    contribution: "disqualifies",
    retentionYears: 7,
    container: "plain",
    delimiter: ",",
    hasHeader: true,
    matchOn: "ein",
    minRows: 1_000,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: headerEinDecoder(["ENTITY NAME", "ORGANIZATION NAME", "NAME", "ENTITY"], {
      revoked: ["REVOCATION DATE", "REVOKED DATE", "DATE REVOKED"],
    }),
  },
  ca_ag_mnos: {
    source: "ca_ag_mnos",
    urls: ["https://oag.ca.gov/system/files/media/may-not-operate-or-solicit.csv"],
    contribution: "disqualifies",
    retentionYears: 7,
    container: "plain",
    delimiter: ",",
    hasHeader: true,
    matchOn: "ein",
    minRows: 25,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: headerEinDecoder(["ORGANIZATION NAME", "NAME", "ENTITY NAME", "CHARITY NAME"], {
      registration: ["REGISTRATION NUMBER", "STATE CHARITY REGISTRATION NUMBER", "CT NUMBER"],
      status: ["STATUS", "REGISTRY STATUS"],
    }),
  },
  ofac_sdn: {
    source: "ofac_sdn",
    urls: ["https://www.treasury.gov/ofac/downloads/sdn.csv"],
    contribution: "neutral",
    retentionYears: 10,
    container: "plain",
    delimiter: ",",
    hasHeader: false,
    matchOn: "name",
    minRows: 1_000,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: ofacDecoder,
  },
  central_org_confirmation: {
    source: "central_org_confirmation",
    urls: [],
    contribution: "supports",
    retentionYears: 7,
    container: "plain",
    delimiter: ",",
    hasHeader: false,
    matchOn: "ein",
    minRows: 0,
    maxBytesPerPart: DEFAULT_SOURCE_MAX_BYTES,
    decoder: centralOrgDecoder,
  },
}

export const IMPORTABLE_SOURCES: readonly EligibilitySourceValue[] = [
  "irs_pub78",
  "irs_eo_bmf",
  "irs_auto_revocation",
  "ftb_revoked",
  "ca_ag_mnos",
  "ofac_sdn",
]

export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ",") {
      out.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  out.push(current.trim())
  return out
}

export function splitLine(line: string, delimiter: SourceDelimiter): string[] {
  if (delimiter === ",") return splitCsvLine(line)
  return line.split("|").map((value) => value.trim())
}

export function complianceObjectPrefix(source: EligibilitySourceValue, revision: string): string {
  return `compliance/${source}/${revision}`
}

export function complianceObjectKey(
  source: EligibilitySourceValue,
  revision: string,
  part: number | null = null,
): string {
  const prefix = complianceObjectPrefix(source, revision)
  return part === null ? `${prefix}.raw` : `${prefix}.part${part}.raw`
}

export function revisionFromHeaders(headers: Headers | undefined, fallback: Date): string {
  const lastModified = headers?.get("last-modified")
  if (lastModified !== null && lastModified !== undefined) {
    const parsed = new Date(lastModified)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  }
  return fallback.toISOString().slice(0, 10)
}
