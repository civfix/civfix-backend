import type { Sql } from "../../db/client.js"
import { registerHostExportBuilder, type HostExportContext } from "../host/export-builders.js"

export const DONATION_EXPORT_PAGE_SIZE = 1000

interface DonationExportRow {
  id: string
  reference: string
  charged_at: Date | null
  created_at: Date
  amount_minor: string | number
  fee_platform_minor: string | number
  fee_refunded_minor: string | number
  fee_stripe_minor: string | number | null
  net_minor: string | number | null
  refunded_total_minor: string | number
  status: string
  dispute_state: string
  share_identity_with_org: boolean
  donor_name: string | null
  donor_email: string | null
  event_title: string | null
  receipt_sent_at: Date | null
}

function iso(value: Date | null): string {
  return value === null ? "" : value.toISOString()
}

function minor(value: string | number | null): string {
  if (value === null) return ""
  return String(typeof value === "number" ? value : Number(value))
}

function dayOf(ctx: HostExportContext): string {
  return ctx.now.toISOString().slice(0, 10)
}

export function registerDonationExportBuilder(getSql: () => Sql): void {
  registerHostExportBuilder("donations", {
    filename: (ctx) => `civfix-donations-${(ctx.organizationId ?? "org").slice(0, 8)}-${dayOf(ctx)}.csv`,
    header: () =>
      Promise.resolve([
        "donation_id",
        "reference",
        "charged_at",
        "created_at",
        "amount_minor",
        "currency",
        "civfix_fee_minor",
        "civfix_fee_refunded_minor",
        "processing_fee_minor",
        "net_minor",
        "refunded_total_minor",
        "status",
        "dispute_state",
        "donor_shared_identity",
        "donor_name",
        "donor_email",
        "event",
        "receipt_sent_at",
      ]),
    provenance: (ctx) =>
      Promise.resolve([
        `civfix donation report for organization ${ctx.organizationId ?? ""}`,
        `generated ${ctx.now.toISOString()} by user ${ctx.requestedBy}`,
        `filters ${JSON.stringify(ctx.filters)}`,
        "donor identity is shown ONLY where the donor opted in; every other row has an empty name and email by design, not by omission",
        "all money columns are integer minor units (cents) in USD",
        "processing_fee_minor is the fee the payment processor charged the organization; civfix never receives it",
        "civfix_fee_refunded_minor is the platform fee returned proportionally when a donation was refunded",
      ]),
    rows: (ctx) => donationRows(getSql(), ctx),
  })
}

async function* donationRows(
  sql: Sql,
  ctx: HostExportContext,
): AsyncIterable<readonly string[]> {
  const organizationId = ctx.organizationId
  if (organizationId === null) return

  const status = typeof ctx.filters.status === "string" ? ctx.filters.status : null
  const from = typeof ctx.filters.from === "string" ? new Date(ctx.filters.from) : null
  const to = typeof ctx.filters.to === "string" ? new Date(ctx.filters.to) : null

  let afterAt: Date | null = null
  let afterId = ""

  for (;;) {
    const rows: DonationExportRow[] = await sql<DonationExportRow[]>`
      SELECT d.id, d.reference, d.charged_at, d.created_at, d.amount_minor, d.fee_platform_minor,
             d.fee_refunded_minor, d.fee_stripe_minor, d.net_minor, d.refunded_total_minor,
             d.status, d.dispute_state, d.share_identity_with_org, d.donor_name, d.donor_email,
             c.title AS event_title, d.receipt_sent_at
        FROM donations d
        LEFT JOIN cleanups c ON c.id = d.event_id
       WHERE d.organization_id = ${organizationId}
         AND d.status <> 'pending'
         AND (${status}::text IS NULL OR d.status = ${status})
         AND (${from}::timestamptz IS NULL OR d.charged_at >= ${from})
         AND (${to}::timestamptz IS NULL OR d.charged_at <= ${to})
         AND (
           ${afterId === ""}
           OR (d.created_at, d.id) < (${afterAt}::timestamptz, ${afterId === "" ? null : afterId}::uuid)
         )
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${DONATION_EXPORT_PAGE_SIZE}`

    if (rows.length === 0) return

    for (const row of rows) {
      const shared = row.share_identity_with_org
      yield [
        row.id,
        row.reference,
        iso(row.charged_at),
        iso(row.created_at),
        minor(row.amount_minor),
        "USD",
        minor(row.fee_platform_minor),
        minor(row.fee_refunded_minor),
        minor(row.fee_stripe_minor),
        minor(row.net_minor),
        minor(row.refunded_total_minor),
        row.status,
        row.dispute_state,
        shared ? "yes" : "no",
        shared ? (row.donor_name ?? "") : "",
        shared ? (row.donor_email ?? "") : "",
        row.event_title ?? "",
        iso(row.receipt_sent_at),
      ]
    }

    const last = rows[rows.length - 1]
    if (last === undefined || rows.length < DONATION_EXPORT_PAGE_SIZE) return
    afterAt = last.created_at
    afterId = last.id
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
