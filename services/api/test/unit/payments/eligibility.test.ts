import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { FakeJobs, FakeStorage } from "@civfix/shared/fakes"
import {
  EligibilityScreeningError,
  makeEligibilityService,
} from "../../../src/services/payments/eligibility-service.js"
import {
  BMF_SUBORDINATE_AFFILIATION,
  ELIGIBILITY_SOURCES,
  complianceObjectKey,
  normalizeEin,
  normalizeOrgName,
  revisionFromHeaders,
  splitCsvLine,
  splitLine,
  type EligibilitySourceSpec,
} from "../../../src/services/payments/eligibility-sources.js"
import {
  EligibilityImportAbort,
  assertSanityFloor,
  indexTargets,
  scanRevision,
} from "../../../src/services/payments/eligibility-scan.js"
import {
  ZipFormatError,
  listZipEntries,
  selectListEntry,
  zipDataChunks,
} from "../../../src/services/payments/eligibility-zip.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import {
  makeMemoryEligibilityRepository,
  memoryEligibilityOrg,
  type MemoryEligibilityRepository,
} from "../../../src/services/payments/eligibility-repository.memory.js"
import type { AppendCheckInput } from "../../../src/services/payments/eligibility-repository.drizzle.js"
import type { EligibilitySourceValue } from "../../../src/db/schema/types-payments.js"
import { NOW, ORG_ID, USER_ID, accountRow, eligibilityRow, orgRow, settingsRow } from "./helpers.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const PAYMENTS_SRC = join(HERE, "../../../src/services/payments")

const EIN = "954327245"
const OTHER_ORG = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa"
const LAST_MODIFIED = "Wed, 20 May 2026 03:00:00 GMT"
const REVISION = "2026-05-20"

function zipOf(name: string, content: string, method: 0 | 8 = 8): Uint8Array {
  const data = Buffer.from(content, "utf8")
  const compressed = method === 8 ? deflateRawSync(data) : data
  const nameBytes = Buffer.from(name, "utf8")
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)
  const directoryOffset = local.length + nameBytes.length + compressed.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBytes.length, 12)
  eocd.writeUInt32LE(directoryOffset, 16)
  return new Uint8Array(Buffer.concat([local, nameBytes, compressed, central, nameBytes, eocd]))
}

async function textOf(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of chunks) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

function response(body: Uint8Array | string, contentType: string): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  return new Response(bytes, {
    status: 200,
    headers: { "last-modified": LAST_MODIFIED, "content-type": contentType },
  })
}

function fetchByUrl(table: Record<string, () => Response>): typeof fetch {
  return ((url: string | URL | Request) => {
    const key = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    const make = table[key]
    if (make === undefined) return Promise.resolve(new Response(null, { status: 404 }))
    return Promise.resolve(make())
  }) as typeof fetch
}

function lowFloor(source: EligibilitySourceValue, patch: Partial<EligibilitySourceSpec> = {}): EligibilitySourceSpec {
  return { ...ELIGIBILITY_SOURCES[source], minRows: 1, ...patch }
}

const PUB78_ROWS = [
  `${EIN}|Reach Out Los Angeles Inc|Los Angeles|CA|United States|PC`,
  "111111111|Some Other Charity|San Diego|CA|United States|PC",
  "222222222|A Foundation|Fresno|CA|United States|PF",
].join("\r\n")

const BMF_HEADER =
  "EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME"

function bmfRow(input: { ein: string; name: string; affiliation?: string; deductibility?: string }): string {
  return [
    input.ein,
    input.name,
    "% JANE DOE",
    "1 CIVIC WAY",
    "LOS ANGELES",
    "CA",
    "90012-0000",
    "0000",
    "03",
    input.affiliation ?? "3",
    "1000",
    "199905",
    input.deductibility ?? "1",
    "15",
    "000000000",
    "1",
    "01",
    "202312",
    "3",
    "3",
    "01",
    "0",
    "12",
    "100000",
    "50000",
    "50000",
    "P20",
    "",
  ].join(",")
}

const REVOCATION_ROW = (ein: string, reinstated: string) =>
  `${ein}|Some Name|DBA|1 Main St|Los Angeles|CA|90012|US|03|15-MAY-2011|09-JUN-2011|${reinstated}`

interface Harness {
  eligibility: MemoryEligibilityRepository
  orgs: ReturnType<typeof makeMemoryOrgPaymentsRepository>
  storage: FakeStorage
  jobs: FakeJobs
}

function harness(
  input: {
    ein?: string | null
    orgName?: string
    checks?: AppendCheckInput[]
    settingsEnabled?: boolean
    disabledReason?: "org" | "operator" | "eligibility" | null
    extraTargets?: { organizationId: string; ein: string; name: string }[]
    subordinate?: boolean
    centralConfirmedAt?: Date | null
  } = {},
): Harness {
  const ein = input.ein === undefined ? EIN : input.ein
  const eligibility = makeMemoryEligibilityRepository({
    orgs: [
      memoryEligibilityOrg({ organizationId: ORG_ID, name: input.orgName ?? "Reach Out LA" }),
      ...(input.extraTargets ?? []).map((target) =>
        memoryEligibilityOrg({ organizationId: target.organizationId, name: target.name, slug: target.name.toLowerCase() }),
      ),
    ],
    eligibility: [
      {
        organizationId: ORG_ID,
        ein,
        einSource: ein === null ? null : "org_verification",
        groupExemptionSubordinate: input.subordinate ?? false,
        centralOrgConfirmedAt: input.centralConfirmedAt ?? null,
      },
      ...(input.extraTargets ?? []).map((target) => ({
        organizationId: target.organizationId,
        ein: target.ein,
        einSource: "operator" as const,
      })),
    ],
    checks: input.checks ?? [],
  })
  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow()],
    accounts: [accountRow()],
    settings: [
      settingsRow({
        enabled: input.settingsEnabled ?? true,
        disabledReason: input.disabledReason ?? null,
      }),
    ],
    eligibility: [eligibilityRow()],
  })
  return { eligibility, orgs, storage: new FakeStorage(), jobs: new FakeJobs() }
}

function serviceOf(
  h: Harness,
  extra: {
    fetchImpl?: typeof fetch
    sources?: Partial<Record<EligibilitySourceValue, EligibilitySourceSpec>>
    reviewRequiredBlocks?: boolean
    withJobs?: boolean
  } = {},
) {
  return makeEligibilityService({
    eligibility: h.eligibility,
    orgs: h.orgs,
    storage: h.storage,
    now: () => NOW,
    ...(extra.withJobs === false ? {} : { jobs: h.jobs }),
    ...(extra.fetchImpl !== undefined ? { fetchImpl: extra.fetchImpl } : {}),
    ...(extra.sources !== undefined ? { sources: extra.sources } : {}),
    ...(extra.reviewRequiredBlocks !== undefined
      ? { reviewRequiredBlocks: extra.reviewRequiredBlocks }
      : {}),
  })
}

function check(patch: Partial<AppendCheckInput> & { source: EligibilitySourceValue }): AppendCheckInput {
  return {
    organizationId: ORG_ID,
    ein: EIN,
    irsLegalName: null,
    foundationCode: null,
    deductibilityCode: null,
    sourceRevisionDate: REVISION,
    rawReportSha256: null,
    rawReportKey: null,
    matched: false,
    verdictContribution: "neutral",
    detail: null,
    checkedAt: NOW,
    retentionUntil: new Date("2033-06-01T12:00:00.000Z"),
    ...patch,
  }
}

describe("per-source decoders", () => {
  it("decodes a pipe-delimited Pub 78 row", () => {
    const row = ELIGIBILITY_SOURCES.irs_pub78.decoder.decode(splitLine(PUB78_ROWS.split("\r\n")[0] as string, "|"), null)
    expect(row?.ein).toBe(EIN)
    expect(row?.name).toBe("Reach Out Los Angeles Inc")
    expect(row?.deductibilityCode).toBe("PC")
    expect(row?.address?.city).toBe("Los Angeles")
    expect(row?.disqualifies).toBe(false)
  })

  it("binds EO BMF columns by header name and flags group-exemption subordinates", () => {
    const decoder = ELIGIBILITY_SOURCES.irs_eo_bmf.decoder
    const header = decoder.bindHeader(splitLine(BMF_HEADER, ","))
    expect(header).not.toBeNull()
    const independent = decoder.decode(splitLine(bmfRow({ ein: EIN, name: "REACH OUT LOS ANGELES INC" }), ","), header)
    expect(independent?.ein).toBe(EIN)
    expect(independent?.deductibilityCode).toBe("1")
    expect(independent?.foundationCode).toBe("15")
    expect(independent?.groupExemptionSubordinate).toBe(false)
    expect(independent?.address).toEqual({
      line1: "1 CIVIC WAY",
      city: "LOS ANGELES",
      state: "CA",
      postalCode: "90012-0000",
    })
    const subordinate = decoder.decode(
      splitLine(bmfRow({ ein: EIN, name: "X", affiliation: BMF_SUBORDINATE_AFFILIATION }), ","),
      header,
    )
    expect(subordinate?.groupExemptionSubordinate).toBe(true)
    expect(decoder.bindHeader(["EIN", "NAME", "CITY"])).toBeNull()
  })

  it("treats a reinstated auto-revocation row as non-disqualifying", () => {
    const decoder = ELIGIBILITY_SOURCES.irs_auto_revocation.decoder
    const revoked = decoder.decode(splitLine(REVOCATION_ROW(EIN, ""), "|"), null)
    expect(revoked?.disqualifies).toBe(true)
    expect(revoked?.detail).toBe("revoked=15-MAY-2011")
    const reinstated = decoder.decode(splitLine(REVOCATION_ROW(EIN, "01-FEB-2013"), "|"), null)
    expect(reinstated?.disqualifies).toBe(false)
    expect(reinstated?.detail).toBe("revoked=15-MAY-2011;reinstated=01-FEB-2013")
  })

  it("refuses an FTB or MNOS layout without an EIN column, and binds one that has it", () => {
    const ftb = ELIGIBILITY_SOURCES.ftb_revoked.decoder
    expect(ftb.bindHeader(["Entity ID", "Entity Name", "Revocation Date"])).toBeNull()
    const bound = ftb.bindHeader(["Entity ID", "Entity Name", "FEIN", "Revocation Date"])
    expect(bound).not.toBeNull()
    const row = ftb.decode(["C1234567", "Some Charity", "95-4327245", "2024-01-15"], bound)
    expect(row?.ein).toBe(EIN)
    expect(row?.disqualifies).toBe(true)
    expect(row?.detail).toBe("revoked=2024-01-15")

    const mnos = ELIGIBILITY_SOURCES.ca_ag_mnos.decoder
    const mnosHeader = mnos.bindHeader(["Organization Name", "Registration Number", "FEIN", "Status"])
    expect(mnosHeader).not.toBeNull()
    expect(mnos.decode(["Reach Out LA", "CT0012345", EIN, "Delinquent"], mnosHeader)?.detail).toBe(
      "registration=CT0012345;status=Delinquent",
    )
  })

  it("decodes an OFAC SDN row as a name entry, never an EIN", () => {
    const row = ELIGIBILITY_SOURCES.ofac_sdn.decoder.decode(
      splitCsvLine('12345,"REACH OUT LOS ANGELES, INC.",-0-,SDGT,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-'),
      null,
    )
    expect(row?.ein).toBeNull()
    expect(row?.name).toBe("REACH OUT LOS ANGELES, INC.")
    expect(row?.detail).toBe("sdn=12345;type=-0-;program=SDGT")
    expect(ELIGIBILITY_SOURCES.ofac_sdn.contribution).toBe("neutral")
  })

  it("normalizes names conservatively for the SDN screen", () => {
    expect(normalizeOrgName("Reach Out Los Angeles, Inc.")).toBe("REACH OUT LOS ANGELES")
    expect(normalizeOrgName("The Ballona Creek Trust")).toBe("BALLONA CREEK TRUST")
    expect(normalizeOrgName("Smith & Sons Foundation")).toBe("SMITH AND SONS FOUNDATION")
    expect(normalizeOrgName(null)).toBe("")
    expect(normalizeOrgName("Inc")).toBe("INC")
  })

  it("normalizes an EIN to nine digits or rejects it", () => {
    expect(normalizeEin("95-4327245")).toBe(EIN)
    expect(normalizeEin(" 954327245 ")).toBe(EIN)
    expect(normalizeEin("12345")).toBeNull()
  })

  it("fetches every EO BMF region as one revision and keeps OFAC evidence for ten years", () => {
    expect(ELIGIBILITY_SOURCES.irs_eo_bmf.urls).toHaveLength(4)
    expect(ELIGIBILITY_SOURCES.irs_pub78.container).toBe("zip")
    expect(ELIGIBILITY_SOURCES.irs_auto_revocation.container).toBe("zip")
    expect(ELIGIBILITY_SOURCES.ofac_sdn.retentionYears).toBe(10)
    expect(ELIGIBILITY_SOURCES.irs_pub78.minRows).toBeGreaterThanOrEqual(100_000)
  })

  it("derives the revision from Last-Modified and archives under a stable key", () => {
    expect(revisionFromHeaders(new Headers({ "last-modified": LAST_MODIFIED }), NOW)).toBe(REVISION)
    expect(revisionFromHeaders(new Headers(), NOW)).toBe("2026-06-01")
    expect(complianceObjectKey("irs_pub78", REVISION)).toBe("compliance/irs_pub78/2026-05-20.raw")
    expect(complianceObjectKey("irs_eo_bmf", REVISION, 3)).toBe(
      "compliance/irs_eo_bmf/2026-05-20.part3.raw",
    )
  })
})

describe("zip reader", () => {
  it("streams a deflated data file out of a ZIP container", async () => {
    const archive = zipOf("data-download-pub78.txt", PUB78_ROWS)
    const entries = listZipEntries(archive)
    expect(entries).toHaveLength(1)
    expect(selectListEntry(entries).name).toBe("data-download-pub78.txt")
    expect(await textOf(zipDataChunks(archive))).toBe(PUB78_ROWS)
  })

  it("reads a stored entry and rejects a non-archive", async () => {
    expect(await textOf(zipDataChunks(zipOf("list.txt", "a|b\n", 0)))).toBe("a|b\n")
    expect(() => listZipEntries(new TextEncoder().encode(PUB78_ROWS))).toThrow(ZipFormatError)
  })
})

describe("scan sanity floor", () => {
  it("aborts a revision below the row floor or with an unparseable layout", async () => {
    const targets = indexTargets([{ organizationId: ORG_ID, ein: EIN, irsLegalName: null, orgName: "Reach Out LA" }])
    const spec = ELIGIBILITY_SOURCES.irs_pub78
    const outcome = await scanRevision(
      spec,
      [{ key: "k", sha256: "s", bytes: zipOf("p.txt", PUB78_ROWS) }],
      targets,
    )
    expect(outcome.rowCount).toBe(3)
    expect(outcome.hits.get(ORG_ID)).toHaveLength(1)
    expect(() => assertSanityFloor(spec, outcome)).toThrow(EligibilityImportAbort)

    const garbage = await scanRevision(
      lowFloor("irs_pub78"),
      [{ key: "k", sha256: "s", bytes: zipOf("p.txt", "not|an|ein\nstill|not\n") }],
      targets,
    )
    expect(() => assertSanityFloor(lowFloor("irs_pub78"), garbage)).toThrow(/low_decode_ratio/)

    await expect(
      scanRevision(
        lowFloor("ftb_revoked"),
        [{ key: "k", sha256: "s", bytes: new TextEncoder().encode("Entity ID,Entity Name\n1,X\n") }],
        targets,
      ),
    ).rejects.toThrow(/unsupported_layout/)
  })
})

describe("eligibility import", () => {
  it("archives the zipped Pub 78 list, screens every verified nonprofit and appends evidence in both directions", async () => {
    const h = harness({ extraTargets: [{ organizationId: OTHER_ORG, ein: "333333333", name: "Unlisted Org" }] })
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.irs_pub78.urls[0] as string]: () =>
          response(zipOf("data-download-pub78.txt", PUB78_ROWS), "application/zip"),
      }),
      sources: { irs_pub78: lowFloor("irs_pub78") },
    })

    const result = await service.importSource("irs_pub78")
    expect(result).toMatchObject({ skipped: false, revision: REVISION, rowCount: 3, matchedCount: 1 })
    expect(result.organizationsTouched.sort()).toEqual([ORG_ID, OTHER_ORG].sort())

    expect(await h.storage.head("compliance/irs_pub78/2026-05-20.raw")).not.toBeNull()
    const matched = h.eligibility.checks.find((row) => row.organizationId === ORG_ID)
    expect(matched).toMatchObject({
      matched: true,
      verdictContribution: "supports",
      irsLegalName: "Reach Out Los Angeles Inc",
      deductibilityCode: "PC",
      rawReportKey: "compliance/irs_pub78/2026-05-20.raw",
    })
    expect(matched?.rawReportSha256).toMatch(/^[0-9a-f]{64}$/)
    const unmatched = h.eligibility.checks.find((row) => row.organizationId === OTHER_ORG)
    expect(unmatched).toMatchObject({ matched: false, verdictContribution: "neutral", ein: "333333333" })
    expect(h.eligibility.revisions[0]).toMatchObject({ source: "irs_pub78", sourceRevisionDate: REVISION, rowCount: 3 })
  })

  it("fetches every BMF region, matches an org in a later region and records its IRS address", async () => {
    const h = harness()
    const urls = ELIGIBILITY_SOURCES.irs_eo_bmf.urls
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [urls[0] as string]: () => response(`${BMF_HEADER}\n${bmfRow({ ein: "111111111", name: "ELSEWHERE" })}\n`, "text/csv"),
        [urls[1] as string]: () => response(`${BMF_HEADER}\n${bmfRow({ ein: "222222222", name: "ELSEWHERE 2" })}\n`, "text/csv"),
        [urls[2] as string]: () => response(`${BMF_HEADER}\n${bmfRow({ ein: EIN, name: "REACH OUT LOS ANGELES INC", affiliation: BMF_SUBORDINATE_AFFILIATION })}\n`, "text/csv"),
        [urls[3] as string]: () => response(`${BMF_HEADER}\n${bmfRow({ ein: "444444444", name: "ELSEWHERE 4" })}\n`, "text/csv"),
      }),
      sources: { irs_eo_bmf: lowFloor("irs_eo_bmf") },
    })

    const result = await service.importSource("irs_eo_bmf")
    expect(result.rowCount).toBe(4)
    expect(result.matchedCount).toBe(1)
    for (const part of [1, 2, 3, 4]) {
      expect(await h.storage.head(`compliance/irs_eo_bmf/2026-05-20.part${part}.raw`)).not.toBeNull()
    }
    const row = h.eligibility.checks[0]
    expect(row).toMatchObject({ matched: true, rawReportKey: "compliance/irs_eo_bmf/2026-05-20.part3.raw", deductibilityCode: "1" })
    const state = h.eligibility.eligibility.get(ORG_ID)
    expect(state?.irsAddress).toEqual({ line1: "1 CIVIC WAY", city: "LOS ANGELES", state: "CA", postalCode: "90012-0000" })
    expect(state?.groupExemptionSubordinate).toBe(true)
  })

  it("records a reinstated auto-revocation listing as neutral evidence, a live one as disqualifying", async () => {
    const run = async (reinstated: string) => {
      const h = harness()
      const service = serviceOf(h, {
        fetchImpl: fetchByUrl({
          [ELIGIBILITY_SOURCES.irs_auto_revocation.urls[0] as string]: () =>
            response(zipOf("data-download-revocation.txt", `${REVOCATION_ROW(EIN, reinstated)}\n${REVOCATION_ROW("111111111", "")}\n`), "application/zip"),
        }),
        sources: { irs_auto_revocation: lowFloor("irs_auto_revocation") },
      })
      await service.importSource("irs_auto_revocation")
      return h.eligibility.checks[0]
    }
    expect(await run("01-FEB-2013")).toMatchObject({ matched: true, verdictContribution: "neutral" })
    expect(await run("")).toMatchObject({ matched: true, verdictContribution: "disqualifies" })
  })

  it("screens OFAC by normalized legal name: a hit is neutral review evidence, a miss is an honest not-matched row", async () => {
    const sdn = [
      '10001,"REACH OUT LOS ANGELES, INC.",-0-,SDGT,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-',
      '10002,"SOMEONE ELSE",individual,SDNTK,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-',
    ].join("\n")
    const withHit = harness({
      checks: [check({ source: "irs_pub78", matched: true, verdictContribution: "supports", irsLegalName: "Reach Out Los Angeles Inc" })],
    })
    withHit.eligibility.eligibility.get(ORG_ID)!.irsLegalName = "Reach Out Los Angeles Inc"
    const fetchImpl = fetchByUrl({
      [ELIGIBILITY_SOURCES.ofac_sdn.urls[0] as string]: () => response(sdn, "text/csv"),
    })
    await serviceOf(withHit, { fetchImpl, sources: { ofac_sdn: lowFloor("ofac_sdn") } }).importSource("ofac_sdn")
    const hit = withHit.eligibility.checks.find((row) => row.source === "ofac_sdn")
    expect(hit).toMatchObject({ matched: true, verdictContribution: "neutral", detail: "sdn=10001;type=-0-;program=SDGT" })
    expect(hit?.retentionUntil.getUTCFullYear()).toBe(NOW.getUTCFullYear() + 10)

    const noHit = harness({ orgName: "Ballona Creek Trust" })
    await serviceOf(noHit, { fetchImpl, sources: { ofac_sdn: lowFloor("ofac_sdn") } }).importSource("ofac_sdn")
    expect(noHit.eligibility.checks[0]).toMatchObject({ source: "ofac_sdn", matched: false })
  })

  it("ABORTS without archiving, appending or recording when a revision parses below the floor", async () => {
    const h = harness()
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.irs_pub78.urls[0] as string]: () =>
          response(zipOf("data-download-pub78.txt", PUB78_ROWS), "application/zip"),
      }),
    })
    await expect(service.importSource("irs_pub78")).rejects.toBeInstanceOf(EligibilityImportAbort)
    expect(h.eligibility.checks).toHaveLength(0)
    expect(h.eligibility.revisions).toHaveLength(0)
    expect(h.storage.objects.size).toBe(0)
  })

  it("ABORTS on an FTB revision whose header no longer carries an EIN column", async () => {
    const h = harness()
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.ftb_revoked.urls[0] as string]: () =>
          response("Entity ID,Entity Name,Revocation Date\nC1,Some Charity,2024-01-01\n", "text/csv"),
      }),
      sources: { ftb_revoked: lowFloor("ftb_revoked") },
    })
    await expect(service.importSource("ftb_revoked")).rejects.toThrow(/unsupported_layout/)
    expect(h.eligibility.checks).toHaveLength(0)
    expect(h.storage.objects.size).toBe(0)
  })

  it("ABORTS a revision that shrank by more than half against the last archived one", async () => {
    const h = harness()
    let modified = LAST_MODIFIED
    let body = PUB78_ROWS
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.irs_pub78.urls[0] as string]: () =>
          new Response(zipOf("data-download-pub78.txt", body), {
            status: 200,
            headers: { "last-modified": modified, "content-type": "application/zip" },
          }),
      }),
      sources: { irs_pub78: lowFloor("irs_pub78") },
    })
    await service.importSource("irs_pub78")
    modified = "Sat, 20 Jun 2026 03:00:00 GMT"
    body = PUB78_ROWS.split("\r\n")[0] as string
    await expect(service.importSource("irs_pub78")).rejects.toThrow(/revision_drift/)
    expect(h.eligibility.revisions).toHaveLength(1)
    expect(await h.storage.head("compliance/irs_pub78/2026-06-20.raw")).toBeNull()
  })

  it("records which normalized names an OFAC miss was screened under", async () => {
    const h = harness({ orgName: "Ballona Creek Trust" })
    await serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.ofac_sdn.urls[0] as string]: () =>
          response('1,"SOMEONE ELSE",individual,SDNTK,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-', "text/csv"),
      }),
      sources: { ofac_sdn: lowFloor("ofac_sdn") },
    }).importSource("ofac_sdn")
    expect(h.eligibility.checks[0]).toMatchObject({ matched: false, detail: "screened=BALLONA CREEK TRUST" })
  })

  it("is a no-op on an unchanged revision", async () => {
    const h = harness()
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.ca_ag_mnos.urls[0] as string]: () =>
          response(`Organization Name,FEIN,Status\nReach Out LA,${EIN},Delinquent\n`, "text/csv"),
      }),
      sources: { ca_ag_mnos: lowFloor("ca_ag_mnos") },
    })
    await service.importSource("ca_ag_mnos")
    const appended = h.eligibility.checks.length
    expect((await service.importSource("ca_ag_mnos")).skipped).toBe(true)
    expect(h.eligibility.checks).toHaveLength(appended)
  })
})

describe("on-demand screening against archived revisions", () => {
  it("screens a newly bootstrapped org from the archived list without waiting for the next import", async () => {
    const h = harness({ ein: null })
    const service = serviceOf(h, {
      fetchImpl: fetchByUrl({
        [ELIGIBILITY_SOURCES.irs_pub78.urls[0] as string]: () =>
          response(zipOf("data-download-pub78.txt", PUB78_ROWS), "application/zip"),
      }),
      sources: { irs_pub78: lowFloor("irs_pub78") },
    })
    const imported = await service.importSource("irs_pub78")
    expect(imported.organizationsTouched).toEqual([])

    const set = await service.setEin({ organizationId: ORG_ID, ein: "95-4327245", source: "operator", actorUserId: USER_ID })
    expect(set).toEqual({ ein: EIN, changed: true, queued: true })
    expect(h.jobs.enqueued[0]).toMatchObject({ name: "eligibility.evaluate", data: { organizationId: ORG_ID } })

    const evaluated = await service.evaluate(ORG_ID)
    expect(evaluated.screening?.screened).toEqual(["irs_pub78"])
    expect(evaluated.verdict).toBe("eligible")
    expect(h.eligibility.checks.find((row) => row.organizationId === ORG_ID)).toMatchObject({
      source: "irs_pub78",
      matched: true,
      sourceRevisionDate: REVISION,
    })

    const again = await service.evaluate(ORG_ID)
    expect(again.screening?.screened).toEqual([])
    expect(h.eligibility.checks.filter((row) => row.source === "irs_pub78")).toHaveLength(1)
  })

  it("fails closed when an archived revision cannot be read: no verdict, donations untouched", async () => {
    const h = harness({
      checks: [check({ source: "irs_pub78", matched: true, verdictContribution: "supports" })],
    })
    h.eligibility.revisions.push({
      source: "irs_auto_revocation",
      sourceRevisionDate: "2026-06-01",
      sha256: "a".repeat(64),
      r2Key: "compliance/irs_auto_revocation/2026-06-01.raw",
      rowCount: 1,
      matchedCount: 0,
      retentionUntil: new Date("2033-06-01T00:00:00.000Z"),
    })
    const service = serviceOf(h)
    await expect(service.evaluate(ORG_ID)).rejects.toBeInstanceOf(EligibilityScreeningError)
    expect(h.eligibility.eligibility.get(ORG_ID)?.evaluatedAt).toBeNull()
    expect(h.orgs.state.settings[0]?.enabled).toBe(true)
    expect((await service.evaluate(ORG_ID, { screen: false })).verdict).toBe("eligible")
  })

  it("names the remediation when nothing has been screened yet instead of a false negative", async () => {
    const h = harness()
    const result = await serviceOf(h).evaluate(ORG_ID)
    expect(result.verdict).toBe("unknown")
    expect(result.reasons).toEqual(["positive_sources_not_yet_checked"])
  })

  it("resets the verdict and stops reading old evidence when the EIN changes", async () => {
    const h = harness({
      checks: [check({ source: "irs_pub78", matched: true, verdictContribution: "supports" })],
    })
    const service = serviceOf(h)
    expect((await service.evaluate(ORG_ID)).verdict).toBe("eligible")
    const changed = await service.setEin({ organizationId: ORG_ID, ein: "11-1111111", source: "operator", actorUserId: USER_ID })
    expect(changed.changed).toBe(true)
    expect(h.eligibility.eligibility.get(ORG_ID)?.verdict).toBe("unknown")
    const after = await service.evaluate(ORG_ID)
    expect(after.verdict).toBe("unknown")
    expect(h.orgs.state.settings[0]?.enabled).toBe(false)
    expect(h.orgs.state.settings[0]?.disabledReason).toBe("eligibility")
  })

  it("does not queue an evaluation when no job queue is wired (payments off)", async () => {
    const h = harness()
    const result = await serviceOf(h, { withJobs: false }).setEin({ organizationId: ORG_ID, ein: EIN, source: "operator", actorUserId: USER_ID })
    expect(result.queued).toBe(false)
    expect(h.jobs.enqueued).toHaveLength(0)
  })

  it("rejects a malformed EIN", async () => {
    await expect(
      serviceOf(harness()).setEin({ organizationId: ORG_ID, ein: "12345", source: "operator", actorUserId: USER_ID }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

describe("eligibility verdict transitions", () => {
  const positive = () => check({ source: "irs_pub78", matched: true, verdictContribution: "supports", irsLegalName: "REACH OUT LOS ANGELES INC" })

  it("is eligible on a positive Pub 78 listing", async () => {
    expect((await serviceOf(harness({ checks: [positive()] })).evaluate(ORG_ID)).verdict).toBe("eligible")
  })

  it("keeps a REINSTATED organization eligible and blocks a live revocation without Pub 78", async () => {
    const reinstated = harness({
      checks: [positive(), check({ source: "irs_auto_revocation", matched: true, verdictContribution: "neutral" })],
    })
    expect((await serviceOf(reinstated).evaluate(ORG_ID)).verdict).toBe("eligible")
    const revoked = harness({
      checks: [check({ source: "irs_auto_revocation", matched: true, verdictContribution: "disqualifies" })],
    })
    expect((await serviceOf(revoked).evaluate(ORG_ID)).verdict).toBe("ineligible")
  })

  it("blocks a group-exemption subordinate until an operator confirms the central organization", async () => {
    const h = harness({ checks: [positive()], subordinate: true })
    const service = serviceOf(h)
    expect((await service.evaluate(ORG_ID)).verdict).toBe("ineligible")
    const confirmed = await service.setCentralOrgConfirmation({ organizationId: ORG_ID, confirmed: true, actorUserId: USER_ID, note: "letter on file" })
    expect(confirmed.centralOrgConfirmedAt).toEqual(NOW)
    expect(h.eligibility.checks.find((row) => row.source === "central_org_confirmation")).toMatchObject({
      matched: true,
      verdictContribution: "supports",
      detail: "letter on file",
      ein: null,
    })
    expect((await service.evaluate(ORG_ID)).verdict).toBe("eligible")
    await service.setCentralOrgConfirmation({ organizationId: ORG_ID, confirmed: false, actorUserId: USER_ID, note: null })
    expect((await service.evaluate(ORG_ID)).verdict).toBe("ineligible")
  })

  it("blocks an FTB-revoked organization", async () => {
    const h = harness({ checks: [positive(), check({ source: "ftb_revoked", matched: true, verdictContribution: "disqualifies" })] })
    expect((await serviceOf(h).evaluate(ORG_ID)).verdict).toBe("ineligible")
  })

  it("flags an OFAC name match for review and, by default policy, leaves donations on", async () => {
    const h = harness({ checks: [positive(), check({ source: "ofac_sdn", matched: true, verdictContribution: "neutral" })] })
    const result = await serviceOf(h).evaluate(ORG_ID)
    expect(result.verdict).toBe("review_required")
    expect(h.orgs.state.settings[0]?.enabled).toBe(true)
    expect(h.eligibility.eligibility.get(ORG_ID)?.contributionsDeductible).toBe(true)

    const unlisted = harness({
      checks: [
        check({ source: "irs_pub78", matched: false }),
        check({ source: "ofac_sdn", matched: true, verdictContribution: "neutral" }),
      ],
    })
    const unlistedResult = await serviceOf(unlisted).evaluate(ORG_ID)
    expect(unlistedResult.verdict).toBe("unknown")
    expect(unlistedResult.reasons).toContain("ofac_sdn_match")
    expect(unlisted.orgs.state.settings[0]?.enabled).toBe(false)
    expect(unlisted.eligibility.eligibility.get(ORG_ID)?.contributionsDeductible).toBe(false)

    const blocking = harness({ checks: [positive(), check({ source: "ofac_sdn", matched: true, verdictContribution: "neutral" })] })
    await serviceOf(blocking, { reviewRequiredBlocks: true }).evaluate(ORG_ID)
    expect(blocking.orgs.state.settings[0]?.enabled).toBe(false)
    expect(blocking.orgs.state.settings[0]?.disabledReason).toBe("eligibility")
  })

  it("grants a grace window on a fresh MNOS listing and expires it", async () => {
    const fresh = harness({ checks: [positive(), check({ source: "ca_ag_mnos", matched: true, verdictContribution: "disqualifies" })] })
    const result = await serviceOf(fresh).evaluate(ORG_ID)
    expect(result.verdict).toBe("grace")
    expect(result.graceExpiresAt).not.toBeNull()
    expect(fresh.eligibility.eligibility.get(ORG_ID)?.mnosFirstSeenOn).toBe("2026-06-01")

    const stale = harness({ checks: [positive(), check({ source: "ca_ag_mnos", matched: true, verdictContribution: "disqualifies" })] })
    stale.eligibility.eligibility.get(ORG_ID)!.mnosFirstSeenOn = "2026-01-01"
    expect((await serviceOf(stale).evaluate(ORG_ID)).verdict).toBe("ineligible")
  })

  it("switches donations off with an eligibility reason when the verdict turns bad", async () => {
    const h = harness({ checks: [check({ source: "irs_auto_revocation", matched: true, verdictContribution: "disqualifies" })] })
    await serviceOf(h).evaluate(ORG_ID)
    expect(h.orgs.state.settings[0]?.enabled).toBe(false)
    expect(h.orgs.state.settings[0]?.disabledReason).toBe("eligibility")
  })

  it("re-enables ONLY what eligibility disabled", async () => {
    const byEligibility = harness({ checks: [positive()], settingsEnabled: false, disabledReason: "eligibility" })
    await serviceOf(byEligibility).evaluate(ORG_ID)
    expect(byEligibility.orgs.state.settings[0]?.enabled).toBe(true)

    for (const reason of ["org", "operator"] as const) {
      const byOther = harness({ checks: [positive()], settingsEnabled: false, disabledReason: reason })
      await serviceOf(byOther).evaluate(ORG_ID)
      expect(byOther.orgs.state.settings[0]?.enabled).toBe(false)
      expect(byOther.orgs.state.settings[0]?.disabledReason).toBe(reason)
    }
  })

  it("reports the previous verdict so a change can be logged and alerted", async () => {
    const service = serviceOf(harness({ checks: [positive()] }))
    expect((await service.evaluate(ORG_ID)).previous).toBe("unknown")
    expect((await service.evaluate(ORG_ID)).previous).toBe("eligible")
  })
})

describe("eligibility evidence is append-only", () => {
  const sources = ["eligibility-repository.drizzle.ts", "eligibility-service.ts", "eligibility-scan.ts", "eligibility-bootstrap.ts"]
    .map((name) => readFileSync(join(PAYMENTS_SRC, name), "utf8"))
    .join("\n")

  it("never issues an UPDATE or a DELETE against org_eligibility_checks outside retention", () => {
    expect(sources).not.toMatch(/UPDATE\s+org_eligibility_checks/i)
    expect(sources).not.toMatch(/INSERT\s+INTO\s+org_eligibility_checks[\s\S]{0,400}ON CONFLICT[\s\S]{0,80}DO UPDATE/i)

    const deletes = [...sources.matchAll(/DELETE\s+FROM\s+org_eligibility_checks/gi)]
    expect(deletes).toHaveLength(1)
    const retentionWindow = sources.slice(
      Math.max(0, (deletes[0]?.index ?? 0) - 400),
      (deletes[0]?.index ?? 0) + 200,
    )
    expect(retentionWindow).toContain("retention_until")
  })

  it("never issues an UPDATE against eligibility_source_revisions", () => {
    expect(sources).not.toMatch(/UPDATE\s+eligibility_source_revisions/i)
  })
})
