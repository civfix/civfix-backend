/**
 * render-sample-certificate: write a set of sample service-hours transcripts to disk so a HUMAN can look
 * at them. Run once per layout change.
 *
 *   pnpm --filter @civfix/api exec tsx scripts/render-sample-certificate.ts [outDir]
 *
 * NOT a CI step, deliberately. The unit suite proves the structure (page count, byte band, Info
 * dictionary, the Hangul path); it cannot prove that the seal overlaps the QR, that a long Korean event
 * title collides with the Hours column, or that the totals rule lands on top of the footer. Nothing but a
 * pair of eyes catches those, and this is what puts something in front of them.
 *
 * Writes to /tmp/civfix-cert by default:
 *   sample-{en,es,de,ko}-3.pdf     one page each; the four locales share one ledger
 *   sample-en-250.pdf              pagination + the running header on continuation pages
 *   sample-en-1200.pdf             the 1000-row cap + the truncation banner under the totals
 *
 * This is a `scripts/` tsx tool: it is never bundled into the API image and touches no DB, no storage and
 * no network — the renderer is pure, so a sample needs nothing but the vendored fonts.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_CERTIFICATE_ENTRIES } from "@civfix/shared"
import {
  buildTranscriptModel,
  ledgerFingerprint,
  type TranscriptLedgerRow,
} from "../src/services/certificate-model.js"
import { buildServiceHoursPdf } from "../src/services/certificate-pdf.js"

const OUT_DIR = process.argv[2] ?? "/tmp/civfix-cert"
const ISSUED_AT = new Date("2026-07-27T18:22:04.000Z")
const CODE = "A1B2C3D4E5F6"

const HOLDER = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Jane Doe",
  handle: "janedoe",
  verified: true,
}

/** A Korean holder + Korean event titles, so the ko sample actually exercises the CJK fallback. */
const KO_HOLDER = { ...HOLDER, displayName: "홍길동", handle: "gildong" }

const COMMUNITIES = ["Los Angeles", "Santa Monica", "Long Beach", "Inglewood"]
const TITLES = [
  "Beach cleanup at the pier",
  "Neighborhood alley sweep and graffiti removal on the east block",
  "Storm drain clearing",
]
const KO_TITLES = ["강남구 정화 활동", "한강 공원 쓰레기 줍기", "동네 골목 청소"]

function ledger(count: number, korean = false): TranscriptLedgerRow[] {
  return Array.from({ length: count }, (_, i) => {
    const source = i % 7 === 3 ? "report" : i % 11 === 5 ? "manual" : "event"
    const titles = korean ? KO_TITLES : TITLES
    return {
      id: `row-${String(i).padStart(5, "0")}`,
      source,
      hours: source === "report" ? 0.1 : ((i % 5) + 1) * 0.75,
      occurredAt: new Date(Date.UTC(2024, 0, 3) + i * 43_200_000).toISOString(),
      eventTitle: source === "event" ? titles[i % titles.length] : null,
      reportReferenceCode: source === "report" ? `R-2026-${String(i).padStart(4, "0")}` : null,
      jurisdictionName:
        i % 9 === 4 ? null : korean ? "강남구" : COMMUNITIES[i % COMMUNITIES.length],
      creditedByName: source === "event" ? (korean ? "김호스트" : "Ada Host") : "Ops Operator",
    }
  })
}

async function write(name: string, locale: string, count: number, korean = false): Promise<void> {
  const model = buildTranscriptModel({
    holder: korean ? KO_HOLDER : HOLDER,
    locale,
    rows: ledger(count, korean),
  })
  const bytes = await buildServiceHoursPdf({
    model,
    code: CODE,
    issuedAt: ISSUED_AT,
    fingerprint: ledgerFingerprint(model),
  })
  const path = join(OUT_DIR, name)
  writeFileSync(path, bytes)
  const printed = Math.min(count, MAX_CERTIFICATE_ENTRIES)
  console.log(`${path}  ${(bytes.length / 1024).toFixed(1)} KB  ${printed} rows`)
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const locale of ["en", "es", "de", "ko"]) {
    await write(`sample-${locale}-3.pdf`, locale, 3, locale === "ko")
  }
  await write("sample-en-250.pdf", "en", 250)
  await write("sample-en-1200.pdf", "en", 1200)
  console.log(`\nOpen them: open ${OUT_DIR}`)
  console.log(
    "Look for: seal vs QR overlap, column collisions, the totals rule against the footer band,",
  )
  console.log(
    "the truncation banner in sample-en-1200, and the running header on every continuation page.",
  )
}

await main()
