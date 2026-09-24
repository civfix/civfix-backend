export const OUTBOUND_SEND_PHASE_BUDGET_MS = 45_000

const OUTBOUND_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024

export const OUTBOUND_SEND_MIN_THROUGHPUT_BPS = 256 * 1024

const OUTBOUND_SEND_MIN_THROUGHPUT_FLOOR_BPS = 1024

const OUTBOUND_SMTP_TIMEOUT_CEILING_MS = 60_000

export const OUTBOUND_SEND_MAX_DEADLINE_MS = 2 ** 31 - 1

const BASE64_EXPANSION_NUMERATOR = 4

const BASE64_EXPANSION_DENOMINATOR = 3

const OUTBOUND_INFLIGHT_SLACK_SECONDS = 120

// nodemailer's connect, greeting and socket timeouts are each the full SMTP timeout and are inactivity
// timeouts, so the phase budget allows all three before the transfer time is added.
const SMTP_TIMEOUT_PHASES = 3

const ROUTE_INFLIGHT_FLOOR_SECONDS = 15 * 60

// The default OCI_EMAIL_SMTP_TIMEOUT_MS. The floor dominates at this timeout, and assertOutboundSendPolicy
// refuses to boot a configuration whose largest deadline would outlive the resulting window.
const ROUTE_GUARD_SMTP_TIMEOUT_MS = OUTBOUND_SMTP_TIMEOUT_CEILING_MS / 4

export function base64Bytes(rawBytes: number): number {
  return Math.ceil(
    (Math.max(0, rawBytes) * BASE64_EXPANSION_NUMERATOR) / BASE64_EXPANSION_DENOMINATOR,
  )
}

export function outboundSendDeadlineMs(input: {
  bytes: number
  phaseBudgetMs: number
  minThroughputBytesPerSec: number
}): number {
  const throughput = Math.max(
    OUTBOUND_SEND_MIN_THROUGHPUT_FLOOR_BPS,
    input.minThroughputBytesPerSec,
  )
  const phase = Math.max(0, input.phaseBudgetMs)
  const transfer = Math.ceil((Math.max(0, input.bytes) / throughput) * 1000)
  return Math.min(phase + transfer, OUTBOUND_SEND_MAX_DEADLINE_MS)
}

export function maxOutboundSendDeadlineMs(input: {
  smtpTimeoutMs: number
  minThroughputBytesPerSec: number
}): number {
  return outboundSendDeadlineMs({
    bytes: base64Bytes(OUTBOUND_PAYLOAD_BUDGET_BYTES),
    phaseBudgetMs: phaseBudgetFor(input.smtpTimeoutMs),
    minThroughputBytesPerSec: input.minThroughputBytesPerSec,
  })
}

export function phaseBudgetFor(smtpTimeoutMs: number): number {
  return Math.max(0, smtpTimeoutMs) * SMTP_TIMEOUT_PHASES
}

export function inflightWindowSeconds(input: {
  smtpTimeoutMs: number
  minThroughputBytesPerSec: number
}): number {
  return Math.ceil(maxOutboundSendDeadlineMs(input) / 1000) + OUTBOUND_INFLIGHT_SLACK_SECONDS
}

export const ROUTE_DEADLINE_INFLIGHT_SECONDS = Math.max(
  ROUTE_INFLIGHT_FLOOR_SECONDS,
  inflightWindowSeconds({
    smtpTimeoutMs: ROUTE_GUARD_SMTP_TIMEOUT_MS,
    minThroughputBytesPerSec: OUTBOUND_SEND_MIN_THROUGHPUT_BPS,
  }),
)

/** @alias */
export const ROUTE_CLAIM_STALE_SECONDS = ROUTE_DEADLINE_INFLIGHT_SECONDS

export function assertOutboundSendPolicy(input: {
  smtpTimeoutMs: number
  minThroughputBytesPerSec: number
}): string[] {
  const errors: string[] = []
  if (input.minThroughputBytesPerSec < OUTBOUND_SEND_MIN_THROUGHPUT_FLOOR_BPS) {
    errors.push(
      `OUTBOUND_SEND_MIN_THROUGHPUT_BPS: must be >= ${OUTBOUND_SEND_MIN_THROUGHPUT_FLOOR_BPS} ` +
        `(a lower floor lets one send outlive the ${ROUTE_DEADLINE_INFLIGHT_SECONDS}s in-flight guard, ` +
        `which is what stops a second packet going to a jurisdiction)`,
    )
  }
  if (input.smtpTimeoutMs > OUTBOUND_SMTP_TIMEOUT_CEILING_MS) {
    errors.push(
      `OCI_EMAIL_SMTP_TIMEOUT_MS: must be <= ${OUTBOUND_SMTP_TIMEOUT_CEILING_MS} ` +
        `(a larger phase budget lets one send outlive the ${ROUTE_DEADLINE_INFLIGHT_SECONDS}s in-flight guard)`,
    )
  }
  if (errors.length === 0 && inflightWindowSeconds(input) > ROUTE_DEADLINE_INFLIGHT_SECONDS) {
    errors.push(
      `OCI_EMAIL_SMTP_TIMEOUT_MS / OUTBOUND_SEND_MIN_THROUGHPUT_BPS: the largest computable send ` +
        `deadline exceeds the ${ROUTE_DEADLINE_INFLIGHT_SECONDS}s in-flight guard`,
    )
  }
  return errors
}
