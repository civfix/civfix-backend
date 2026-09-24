/**
 * revoke-certificate: the OPERATOR remedy for a service-hours transcript that must stop verifying.
 *
 *   pnpm --filter @civfix/api db:certificate:revoke CFX-A1B2-C3D4-E5F6 --dry-run
 *   pnpm --filter @civfix/api db:certificate:revoke CFX-A1B2-C3D4-E5F6
 *   pnpm --filter @civfix/api db:certificate:revoke A1B2C3D4E5F6 --reason ledger_corrected
 *   pnpm --filter @civfix/api db:certificate:revoke <code> --keep-object   # DB only, leave R2 alone
 *
 * WHY THIS EXISTS. The product's only revoke is HOLDER-gated: `POST /service-hours/certificates/:code/
 * revoke` runs `requireAuth`, the service hardcodes the reason `"holder"`, and the repository scopes its
 * UPDATE by `WHERE user_id = <session user>`. An operator cannot reach it (they are not the holder), and
 * even if they had the holder sign in, `verify()` would then publicly report `revokedReason: "holder"`,
 * i.e. that the VOLUNTEER withdrew their own record rather than that civfix corrected the ledger. This
 * script is the seam that makes the documented remedy real: same repository call, an operator reason, and
 * the same best-effort object delete the holder path performs.
 *
 * THE MOTIVATING CASE (`drizzle/0065_void_report_volunteer_hours.sql`): filing a report stopped being
 * volunteer service, so every historical `source='report'` credit was voided. A transcript issued before
 * that itemised those rows and OVERSTATES service. It cannot be corrected in place: the row is an
 * immutable snapshot, `verify()` reports it verbatim, and editing `snapshot`/`total_hours` would break
 * `document_sha256` against the stored PDF. Revoke, notify the holder, let them re-issue: after the void
 * their ledger fingerprint differs, so the `(user_id, ledger_fingerprint) WHERE revoked_at IS NULL`
 * idempotency index does not block the new document. The detection query is in the migration banner and in
 * docs/operator-runbook.md §1b.
 *
 * DELIBERATELY NOT AN HTTP ROUTE. An admin endpoint that revokes another person's signed document is a
 * standing capability on a public-verification surface; this is a rare, deliberate, per-code action, so it
 * lives where `refresh-boundaries.ts` lives: a `scripts/` tsx tool, never bundled into the API image.
 *
 * ENV. `DATABASE_URL` only (open your own SSH tunnel to prod Postgres and export it). The R2 delete is
 * skipped with a warning unless R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET are
 * also set. Skipping it is SAFE, never an exposure: `findLiveByFingerprint` filters `revoked_at IS NULL`
 * and is the only path that re-presigns an object, so a revoked certificate's PDF is unreachable through
 * the API either way; any already-issued URL simply expires. Deleting is still preferred, because the
 * object is otherwise an orphan nothing will ever collect.
 *
 * IDEMPOTENT. The repository's `revoked_reason = COALESCE(revoked_reason, …)` means re-running never
 * rewrites an earlier revocation's timestamp or reason; the script reports that it was already revoked.
 */

import { formatCertificateCode, normalizeCertificateCode } from "@civfix/shared"
import { R2Storage } from "../src/adapters/storage.r2.js"
import { makeDb } from "../src/db/client.js"
import { makeDrizzleCertificateRepository } from "../src/services/certificate-repository.drizzle.js"

const PREFIX = "revoke-certificate"
const log = (m: string): void => console.log(`${PREFIX}: ${m}`)
const warn = (m: string): void => console.warn(`${PREFIX}: ⚠ ${m}`)

/**
 * The reason string is echoed VERBATIM by the public `verify()` response, so it is read by whoever holds
 * the paper. Keep the set small and self-explaining, and keep it disjoint from the two the product writes
 * on its own (`holder` = the volunteer withdrew it; `account_closed` = erasure tombstoned the holder).
 */
const OPERATOR_REASONS = {
  /** The ledger the document was built from was itself wrong (the 0065 case). */
  ledger_corrected: "the underlying volunteer-hours ledger was corrected after issue",
  /** The document was issued from data obtained by fraud or abuse. */
  issued_in_error: "the document should never have been issued",
} as const

type OperatorReason = keyof typeof OPERATOR_REASONS

interface Args {
  code: string
  reason: OperatorReason
  dryRun: boolean
  keepObject: boolean
}

function usage(): never {
  console.error(
    [
      `usage: tsx scripts/revoke-certificate.ts <code> [--reason <reason>] [--dry-run] [--keep-object]`,
      ``,
      `  <code>          the printed certificate code, with or without the CFX- display prefix`,
      `  --reason        one of: ${Object.keys(OPERATOR_REASONS).join(", ")} (default: ledger_corrected)`,
      `  --dry-run       show the row and stop; changes nothing`,
      `  --keep-object   revoke in the database but leave the R2 object in place`,
      ``,
      ...Object.entries(OPERATOR_REASONS).map(([k, v]) => `  ${k}: ${v}`),
    ].join("\n"),
  )
  process.exit(2)
}

function parseArgs(argv: readonly string[]): Args {
  let rawCode: string | undefined
  let reason: string = "ledger_corrected"
  let dryRun = false
  let keepObject = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--dry-run") dryRun = true
    else if (arg === "--keep-object") keepObject = true
    else if (arg === "--reason") {
      const next = argv[++i]
      if (next === undefined) usage()
      reason = next
    } else if (arg.startsWith("--reason=")) reason = arg.slice("--reason=".length)
    else if (arg.startsWith("-")) usage()
    else if (rawCode === undefined) rawCode = arg
    else usage()
  }

  if (rawCode === undefined) usage()
  if (!(reason in OPERATOR_REASONS)) {
    console.error(`${PREFIX}: unknown --reason "${reason}"`)
    usage()
  }
  // The SAME normalizer the verify endpoint and the web page use, so a hand-typed dashed code from the
  // paper resolves identically here. Never strip "CFX-" by hand: those are valid alphabet symbols.
  const code = normalizeCertificateCode(rawCode)
  if (code === null) {
    console.error(`${PREFIX}: "${rawCode}" is not a valid certificate code`)
    process.exit(2)
  }
  return { code, reason: reason as OperatorReason, dryRun, keepObject }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      `${PREFIX}: DATABASE_URL is required (open a tunnel to prod Postgres and export it)`,
    )
    process.exit(2)
  }

  // Same posture as the db: CLIs: one connection, no statement timeout (this is an operator session, not
  // a request path).
  const handle = makeDb(databaseUrl, { max: 1, statementTimeoutMs: 0, idleInTxTimeoutMs: 0 })
  try {
    const repo = makeDrizzleCertificateRepository(handle.sql)
    const before = await repo.findByCode(args.code)
    if (before === null) {
      console.error(`${PREFIX}: no certificate with code ${formatCertificateCode(args.code)}`)
      process.exit(1)
    }

    log(`code          ${formatCertificateCode(before.code)}`)
    log(
      `holder        ${before.holderName} (${before.holderHandle ?? "no handle"}) ${before.userId}`,
    )
    log(`issued        ${before.issuedAt.toISOString()}`)
    log(`hours         ${before.totalHours} over ${before.entryCount} activities`)
    log(`object        ${before.r2Key}`)
    log(
      before.revokedAt === null
        ? `status        VALID`
        : `status        ALREADY REVOKED at ${before.revokedAt.toISOString()} (${before.revokedReason ?? "no reason"})`,
    )

    if (args.dryRun) {
      log(`dry run: nothing changed`)
      return
    }

    const row = await repo.revoke(before.userId, args.code, args.reason, new Date())
    if (row === null) {
      // Unreachable: findByCode just resolved this code, and revoke scopes by that row's own user_id.
      console.error(`${PREFIX}: revoke matched no row; did the certificate disappear mid-run?`)
      process.exit(1)
    }

    if (before.revokedAt !== null) {
      warn(
        `already revoked; COALESCE preserved the original timestamp and reason ` +
          `(${row.revokedReason ?? "no reason"}); "${args.reason}" was NOT written`,
      )
    } else {
      log(
        `revoked at ${row.revokedAt?.toISOString() ?? "?"} with reason "${row.revokedReason ?? "?"}"`,
      )
      log(`verify() now reports status "revoked" with that reason to anyone holding the paper`)
    }

    if (args.keepObject) {
      log(`--keep-object: leaving ${row.r2Key} in place`)
      return
    }
    await deleteObject(row.r2Key)

    log(
      `done. Notify the holder: after the ledger correction they can re-issue a corrected transcript.`,
    )
  } finally {
    await handle.close()
  }
}

/**
 * Best-effort, exactly like `certificate-service.ts`'s `bestEffortDelete`: the DB row is the revocation,
 * and a storage hiccup must never make a COMPLETED revocation look like a failure.
 */
async function deleteObject(key: string): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    warn(
      `R2_* not set; leaving ${key} in place. The certificate is revoked and no API path re-presigns ` +
        `a revoked row, so this is an orphaned object, not an exposure. Re-run with R2 credentials (or ` +
        `delete the key by hand) to reclaim it.`,
    )
    return
  }
  // NO publicBase: this adapter only ever deletes here, and passing one is how a presign silently
  // degrades to an unsigned permanent CDN URL elsewhere.
  const storage = new R2Storage({ accountId, accessKeyId, secretAccessKey, bucket })
  try {
    await storage.delete(key)
    log(`deleted ${key}`)
  } catch (err) {
    warn(`could not delete ${key}: ${String(err)} (revocation still applied)`)
  }
}

main().catch((err: unknown) => {
  console.error(`${PREFIX}: failed`)
  console.error(err)
  process.exit(1)
})
