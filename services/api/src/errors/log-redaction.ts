export const LOG_REDACTION_CENSOR = "[REDACTED]"

// Matched as whole key names (any case), not substrings like the error tracker's list: substring matching
// would also blank `code`, `statusCode`, `sessionId` and `title`, which every error log line needs.
const LOG_SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    "password",
    "token",
    "otp",
    "email",
    "phone",
    "tokenHash",
    "ticketToken",
    "ticketTokens",
    "manageToken",
    "accessCode",
    "attendeeName",
    "attendeeNames",
    "answer",
    "answers",
    "hostNote",
    "note",
    "einNumber",
    "ein_number",
    "invitedEmail",
    "maskedEmail",
    "recipientEmail",
    "replyTo",
    "to",
    "clientSecret",
    "client_secret",
    "card",
    "cvc",
    "pan",
    "last4",
    "cardLast4",
    "webhookSecret",
  ].map((key) => key.toLowerCase()),
)

// The verbatim SMTP reply echoes the recipient address; `response` is only sensitive under `smtp`.
const SMTP_KEY = "smtp"
const SMTP_RESPONSE_KEY = "response"

// Every log line pays for this walk, so it stops at a fixed depth and a fixed number of visited values;
// anything past either bound is dropped rather than written unredacted.
const MAX_REDACTION_DEPTH = 10
const MAX_REDACTION_NODES = 1_000
const TRUNCATED = "[Truncated]"
const CIRCULAR = "[Circular]"

function isSensitiveLogKey(key: string, parentKey: string | null): boolean {
  const lower = key.toLowerCase()
  if (LOG_SENSITIVE_KEYS.has(lower)) return true
  return lower === SMTP_RESPONSE_KEY && parentKey?.toLowerCase() === SMTP_KEY
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

interface Walk {
  depth: number
  visited: number
  ancestors: Set<object>
}

function budgetSpent(walk: Walk): boolean {
  walk.visited += 1
  return walk.visited > MAX_REDACTION_NODES
}

function redactArray(value: readonly unknown[], parentKey: string | null, walk: Walk): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < value.length; i++) {
    if (budgetSpent(walk)) {
      out.push(TRUNCATED)
      break
    }
    out.push(redactValue(value[i], parentKey, walk))
  }
  return out
}

function redactEntries(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  parentKey: string | null,
  walk: Walk,
  ownOnly: boolean,
): void {
  // for...in rather than Object.entries: a wide object is abandoned at the budget without first
  // materializing every entry. An error keeps its inherited enumerable keys, because the serializer
  // would otherwise read them unredacted through the shadow's shared prototype.
  for (const key in source) {
    if (ownOnly && !Object.prototype.hasOwnProperty.call(source, key)) continue
    if (budgetSpent(walk)) {
      target[key] = TRUNCATED
      break
    }
    target[key] = isSensitiveLogKey(key, parentKey)
      ? LOG_REDACTION_CENSOR
      : redactValue(source[key], key, walk)
  }
}

function redactValue(value: unknown, parentKey: string | null, walk: Walk): unknown {
  if (value === null || typeof value !== "object") return value
  if (walk.depth >= MAX_REDACTION_DEPTH) return TRUNCATED
  if (walk.ancestors.has(value)) return CIRCULAR
  if (!Array.isArray(value) && !(value instanceof Error) && !isPlainObject(value)) return value

  walk.ancestors.add(value)
  walk.depth += 1
  try {
    if (Array.isArray(value)) return redactArray(value, parentKey, walk)
    if (value instanceof Error) return shadowError(value, walk)
    const out: Record<string, unknown> = {}
    redactEntries(value, out, parentKey, walk, true)
    return out
  } finally {
    walk.depth -= 1
    walk.ancestors.delete(value)
  }
}

// The logger's err serializer runs after this pass and reads the constructor name, message, stack, cause,
// aggregate errors and every enumerable property. A same-prototype copy keeps all of that while the
// caller's error object, which is still being handled and reported, is never mutated.
function shadowError(error: Error, walk: Walk): Error {
  const shadow = Object.create(Object.getPrototypeOf(error) as object) as Error
  hideOn(shadow, "message", error.message)
  hideOn(shadow, "stack", error.stack)
  if ("cause" in error) hideOn(shadow, "cause", redactValue(error.cause, null, walk))
  if (error instanceof AggregateError)
    hideOn(shadow, "errors", redactValue(error.errors, null, walk))
  redactEntries(
    error as unknown as Record<string, unknown>,
    shadow as unknown as Record<string, unknown>,
    null,
    walk,
    false,
  )
  return shadow
}

function hideOn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

/**
 * The logger's `formatters.log` hook: returns a copy of the logged object with every sensitive key
 * censored at any depth, inside arrays and inside errors. Class instances other than errors (the request
 * and reply the framework logs) pass through untouched for their own serializers.
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactValue(object, null, { depth: 0, visited: 0, ancestors: new Set() }) as Record<
    string,
    unknown
  >
}
