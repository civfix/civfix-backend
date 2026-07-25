/**
 * Email one-time-passcode sign-in (plan section 8).
 *
 * issueOtp(email, ip):
 *   - rate limits FIRST: 10 per hour per IP, THEN at most 1 request per 60s per email (Redis counters via
 *     the CacheClient seam, so the windows are testable with an injectable clock). The per-IP check comes
 *     first so an IP-cap rejection does not burn the per-email window (P1-7);
 *   - mints a 6-digit code with a cryptographically uniform, modulo-bias-free draw;
 *   - stores ONLY the argon2id hash of the code in email_otps (expires in 5 min, attempts 0);
 *   - invalidates any prior unconsumed codes for that email (resend supersedes);
 *   - sends the code through the Mailer seam (FakeMailer captures it in dev/test), in the account's saved
 *     locale when the address already has one. If storing/mailing fails, the per-email cooldown this call
 *     set is rolled back so the user is not locked out (P1-7).
 *
 * verifyOtp(email, code, ip):
 *   - THROTTLE (per-IP, then per-CODE): before touching the store it checks a per-IP failed-verify
 *     counter; once it exceeds its window cap, verification is LOCKED (generic unauthorized) so an
 *     attacker cannot keep guessing across freshly-issued codes. A second counter is scoped to the
 *     ISSUED CODE (never to the email address) — see the L2 note on OTP_VERIFY_CODE_FAIL_MAX: keying a
 *     lockout on the address let any third party lock the legitimate owner out of their own account by
 *     spending a handful of wrong guesses. These are the OUTER bounds that the per-code 3-attempt lock
 *     (below) sits inside.
 *   - loads the latest unconsumed, non-expired code; missing -> unauthorized;
 *   - enforces a 3-attempt ceiling ATOMICALLY: it increments attempts FIRST and gates on the returned
 *     value, so concurrent verifies cannot all slip past a stale read (TOCTOU-safe); a code that has
 *     used its attempts is locked even with the right code;
 *   - verifies with argon2 (constant-time);
 *   - every failure mode bumps the per-code + per-IP throttle counters; a success does not;
 *   - on success CLAIMS the code (a conditional consume, so concurrent verifies of one correct code
 *     cannot both mint a session), RELEASES the per-email resend cooldown (a consumed code proves inbox
 *     access, so the anti-mail-bomb window has done its job — see the G17 note in issueOtp) and
 *     find-or-creates the user, returning userId.
 */

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2"
import { AppError } from "@civfix/shared"
import { constantTimeStringEqual, generateNumericCode } from "./crypto.js"
import type { CacheClient } from "./cache.js"
import type { OtpStore, UserStore } from "./stores.js"
import type { Mailer } from "@civfix/shared/interfaces"

/** OTP code length (digits). */
export const OTP_CODE_LENGTH = 6
/** Code lifetime: 5 minutes. */
export const OTP_TTL_SECONDS = 5 * 60
/** Maximum verify attempts before a code is locked. */
export const OTP_MAX_ATTEMPTS = 3
/** Per-email resend cooldown: 1 request / 60s. */
export const OTP_EMAIL_WINDOW_SECONDS = 60
/** Per-IP cap: 10 requests / hour. */
export const OTP_IP_WINDOW_SECONDS = 60 * 60
export const OTP_IP_MAX_PER_WINDOW = 10

/**
 * Verify-attempt throttle (P1-1): a per-IP AND per-CODE failed-verify lockout that bounds brute force
 * beyond the per-code 3-attempt lock. Window is 15 minutes. Only FAILED verifies count; a success never
 * consumes throttle budget.
 *
 * L2 — the throttle deliberately has NO per-EMAIL-ADDRESS key. A lockout keyed on the address is a
 * lockout an ATTACKER can trigger for a VICTIM: ten wrong guesses (which cost the attacker nothing and
 * require no access to the mailbox) denied the legitimate owner sign-in for the whole window, and could
 * be repeated indefinitely. The bound that actually matters against guessing is the ATTEMPT budget, and
 * that budget is a property of the ISSUED CODE, not of the address: a code carries at most
 * OTP_VERIFY_CODE_FAIL_MAX failures and then dies, while the owner can always request a fresh code
 * (itself capped at 1/60s per email and OTP_IP_MAX_PER_WINDOW/hour per IP) and sign in immediately.
 * Cross-code grinding is therefore bounded by ISSUANCE, not by locking out the human being attacked,
 * with the per-IP counter as the primary network-level bound.
 *
 * Anti-enumeration is preserved: no counter key is derived from an email address, so a caller can learn
 * nothing about whether an address is registered from which branch it lands in.
 */
export const OTP_VERIFY_FAIL_WINDOW_SECONDS = 15 * 60
/**
 * Failed verifies against ONE issued code before that code is locked, regardless of which caller,
 * process, or connection produced them. Sits just above OTP_MAX_ATTEMPTS: the durable attempts counter
 * is the primary per-code ceiling and this is the cache-side backstop covering failures that never
 * reached the row (and any store hiccup that loses an increment).
 */
export const OTP_VERIFY_CODE_FAIL_MAX = 5
/** Failed verifies per IP per window before OTP verification is locked from that network. */
export const OTP_VERIFY_IP_FAIL_MAX = 30

/**
 * argon2 algorithm id. The library exports `Algorithm` as a `const enum`, which `isolatedModules`
 * forbids referencing across modules, so we use its stable numeric value: Argon2id = 2.
 */
const ARGON2ID = 2

/**
 * argon2id parameters. Interactive-grade: a 6-digit code lives 5 minutes and is attempt-limited, so
 * we do not need the heaviest cost. These mirror sensible defaults (64 MiB, 3 passes).
 */
const ARGON_OPTS_FULL = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const

/**
 * Test-only argon2id parameters: the same algorithm through the same hash/verify code paths (no mock,
 * no branch inside issue/verify), at the argon2 minimum cost (8 KiB, 1 pass). The full-cost hash is
 * ~115 ms of CPU plus a 64 MiB memory-hard allocation, and every route-suite harness signs a user in
 * through the real OTP flow — so under full-suite worker concurrency (or host memory pressure, where a
 * 64 MiB random-access working set swap-thrashes) the unit suites degraded from seconds to minutes with
 * load-dependent 20 s per-test timeouts. Cost parameters are exactly what argon2id is designed to let
 * deployments tune, and verify() reads them back from the stored PHC string, so tests still exercise
 * real hashing end to end.
 *
 * The gate is a strict NODE_ENV === "test" module-scope read (vitest.config.ts forces NODE_ENV=test
 * into every worker; direct-read precedent: ws/handshake.ts, version.ts). Development and production
 * both keep ARGON_OPTS_FULL. A production deployment misconfigured to NODE_ENV=test is already
 * non-functional as a deployment (every USE_FAKE_* flag then defaults on, so no mail leaves the box and
 * no OTP can be delivered at all) — the weakened hash cost is unreachable before that far louder
 * failure, and the hash only ever protects a 5-minute, attempt-limited 6-digit code.
 */
const ARGON_OPTS_TEST = {
  algorithm: ARGON2ID,
  memoryCost: 8,
  timeCost: 1,
  parallelism: 1,
} as const

const ARGON_OPTS = process.env.NODE_ENV === "test" ? ARGON_OPTS_TEST : ARGON_OPTS_FULL

/**
 * Reviewer-OTP bypass (App Review): a known email that accepts ONE operator-supplied secret code,
 * signing in WITHOUT mailing or storing anything, so App Review can log into the build under review
 * without a new mobile release. On first use it find-or-creates a fully set-up citizen account
 * (profile_complete, @reviewer).
 *
 * C1 — the code is NOT a constant in this file and must never become one. A fixed code committed to the
 * repository is a universal, world-readable login to every deployment that has the bypass compiled in;
 * the whole security of this feature rests on the code being a high-entropy secret that exists only in
 * the deployment's environment and is rotated per review. The service therefore has no default: the
 * wiring must inject BOTH the email and a code (see reviewerOtpConfigFromEnv in auth-services.ts, which
 * refuses to wire anything unless an explicit opt-in flag AND a long enough env-supplied code are both
 * present). Omit the config and the address behaves like any other email.
 */
export const REVIEWER_OTP_EMAIL = "reviewer@civfix.org"
/** The reviewer account's @handle (also on the reserved blocklist so no real user can take it). */
export const REVIEWER_HANDLE = "reviewer"
/** The reviewer account's display name (registration composes "First Last"; both are "Reviewer"). */
export const REVIEWER_DISPLAY_NAME = "Reviewer Reviewer"

/** Reviewer-OTP bypass config injected at construction. Absent => the bypass is disabled. */
export interface ReviewerOtpConfig {
  /** The bypass email (compared case-insensitively against the normalized request email). */
  email: string
  /** The secret code that the bypass email accepts. Supplied by the environment; never a source constant. */
  code: string
}

/** Minimal logger seam (the pino instance satisfies it); defaults to a no-op when unwired. */
export interface OtpLogger {
  warn(obj: unknown, msg?: string): void
}

/**
 * The shared `Mailer.sendOtp(to, code)` type carries NO locale slot, but the production adapter already
 * accepts an optional third argument (adapters/mailer.oci.ts) and without it the four `email.otp.*`
 * catalogs are unreachable — every passcode email rendered in English even for a user whose
 * `users.locale` is es/de/ko. Widen STRUCTURALLY at this one seam instead of changing the contract
 * package: a 2-parameter sendOtp is assignable to a 3-parameter one, so every existing Mailer (OciMailer,
 * FakeMailer, any test double) still satisfies this type, and an adapter that ignores the argument simply
 * keeps rendering `en`.
 */
type LocaleAwareMailer = Mailer & {
  sendOtp(to: string, code: string, locale?: string): Promise<void>
}

export interface OtpServiceOptions {
  store: OtpStore
  users: UserStore
  cache: CacheClient
  mailer: Mailer
  now?: () => number
  logger?: OtpLogger
  /** Reviewer-OTP bypass; omit to disable (the default in the offline/test wiring). */
  reviewer?: ReviewerOtpConfig
}

export interface IssueResult {
  /** Seconds the caller must wait before a resend is allowed (the per-email window). */
  resendAfterSec: number
}

export class OtpService {
  private readonly store: OtpStore
  private readonly users: UserStore
  private readonly cache: CacheClient
  private readonly mailer: LocaleAwareMailer
  private readonly now: () => number
  private readonly logger?: OtpLogger
  /** Normalized reviewer-bypass config (email lowercased/trimmed); null when the bypass is disabled. */
  private readonly reviewer: ReviewerOtpConfig | null

  constructor(opts: OtpServiceOptions) {
    this.store = opts.store
    this.users = opts.users
    this.cache = opts.cache
    this.mailer = opts.mailer
    this.now = opts.now ?? Date.now
    this.logger = opts.logger
    this.reviewer = opts.reviewer
      ? { email: opts.reviewer.email.trim().toLowerCase(), code: opts.reviewer.code }
      : null
  }

  /** True when the bypass is enabled AND `normalizedEmail` is the reviewer email. */
  private isReviewerEmail(normalizedEmail: string): boolean {
    return this.reviewer !== null && normalizedEmail === this.reviewer.email
  }

  /**
   * Issue (or resend) a code to `email`. `ip` drives the per-IP hourly cap; pass null when unknown
   * (the per-IP limit is then skipped, e.g. trusted internal callers).
   *
   * ORDERING (P1-7): the per-IP cap is checked FIRST, so an IP-cap rejection never burns the per-email
   * window (a legitimate user behind a busy shared IP is not additionally penalized on their own email).
   * The per-email cooldown is then claimed atomically (incr), but if ANY downstream step fails (invalidate
   * / insert / mailer), the cooldown this call anchored is ROLLED BACK so the user is not locked out for
   * 60s with no code in their inbox - an immediate legitimate retry is allowed.
   */
  async issueOtp(email: string, ip: string | null): Promise<IssueResult> {
    const normalized = email.trim().toLowerCase()

    // Reviewer-OTP bypass: report success to the client without mailing, storing, or rate-limiting
    // anything. The reviewer signs in with the injected secret code (verifyOtp), never a mailed one.
    if (this.isReviewerEmail(normalized)) {
      return { resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }
    }

    // Per-IP hourly cap FIRST (so an IP rejection does not consume the per-email window).
    if (ip) {
      const ipKey = `otp:rl:ip:${ip}`
      const ipHits = await this.cache.incr(ipKey, OTP_IP_WINDOW_SECONDS)
      if (ipHits > OTP_IP_MAX_PER_WINDOW) {
        throw AppError.rateLimited("Too many code requests from this network.")
      }
    }

    // Per-email cooldown: the counter key carries the window TTL; a second hit inside 60s trips it. incr
    // is atomic so concurrent requests cannot both pass. emailHits === 1 means THIS call anchored the
    // window (so it is the one allowed to roll it back on a downstream failure).
    //
    // ONE NAMESPACE, RELEASED ON CONSUME (G17): account deletion re-proves the email through this SAME
    // endpoint (POST /auth/otp/request; users.routes' delete gate then verifies the code), so a user who
    // just signed in and immediately started deletion used to be told to wait — a 429 on a GDPR erasure
    // path. Splitting the key by PURPOSE is not available to the server: EmailOtpRequestRequestSchema has
    // no such field, and for bearer (mobile) clients no session is even presented on this public endpoint,
    // so a route-derived purpose would be inert exactly where it is needed. Instead verifyOtp DELETES this
    // key on a successful claim: the cooldown exists to bound how fast a third party can make us mail one
    // address, and a consumed code proves the requester reads that inbox, so the window has already done
    // its job. An attacker cannot reach that release for someone else's address, so the anti-mail-bomb
    // bound is unchanged for everyone but the mailbox owner (who stays bounded by the per-IP hourly cap
    // above and the route limiter).
    const emailKey = emailCooldownKey(normalized)
    const emailHits = await this.cache.incr(emailKey, OTP_EMAIL_WINDOW_SECONDS)
    if (emailHits > 1) {
      throw AppError.rateLimited("Please wait before requesting another code.")
    }

    try {
      // Supersede any prior unconsumed codes, then store the new one (hash only), then mail it.
      await this.store.invalidateActiveForEmail(normalized)
      const code = generateNumericCode(OTP_CODE_LENGTH)
      const codeHash = await argonHash(code, ARGON_OPTS)
      await this.store.insert({
        email: normalized,
        codeHash,
        expiresAt: new Date(this.now() + OTP_TTL_SECONDS * 1000),
      })
      // i18n: render the passcode email in the ACCOUNT's saved locale. `users.locale` is the source of
      // truth for server-generated copy, and this is the one user-facing email sent to an address that
      // may not have an account yet — an unknown address (first sign-up) passes undefined, which the
      // adapter clamps to `en`, exactly like an unsupported stored value. Read here, after the caps, so a
      // rate-limited request pays for no lookup; it reveals nothing (both branches mail and answer alike).
      const account = await this.users.findByEmail(normalized)
      await this.mailer.sendOtp(normalized, code, account?.locale)
    } catch (err) {
      // The code was never delivered: release the cooldown THIS call set so an immediate retry is not
      // locked out for 60s (P1-7). Only clear when we anchored it (emailHits === 1); a concurrent caller
      // that legitimately holds the window is untouched. Best-effort: a cache hiccup here is non-fatal,
      // but log it — a failed release silently locks the user out for the window with no signal.
      if (emailHits === 1) {
        await this.cache.del(emailKey).catch((delErr: unknown) => {
          this.logger?.warn({ err: delErr }, "otp: failed to release per-email cooldown after issue error")
        })
      }
      throw err
    }

    return { resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }
  }

  /**
   * Verify a presented code for `email`. Returns the userId on success (find-or-create). Throws an
   * AppError for every failure mode: throttle lockout, no active code, locked (attempts exhausted), or
   * wrong code. `ip` drives the per-IP verify-failure throttle; pass null when unknown.
   */
  async verifyOtp(email: string, code: string, ip: string | null): Promise<string> {
    const normalized = email.trim().toLowerCase()
    const now = new Date(this.now())

    // OUTER bound (P1-1): per-IP failed-verify throttle. If the network is already over its cap,
    // verification is locked - an attacker cannot keep guessing across newly-issued codes. Checked
    // BEFORE any store work (no row read and no argon2 hash is spent for a locked-out caller), and
    // BEFORE the reviewer branch (C1): the bypass used to short-circuit ahead of every throttle, so the
    // one credential most worth grinding was the one credential with no brute-force bound at all.
    if (await this.ipThrottleTripped(ip)) {
      throw AppError.unauthorized("Too many attempts. Try again later.")
    }

    // Reviewer-OTP bypass: the reviewer email only ever accepts the injected secret code (no stored or
    // mailed code is ever consulted), and that code only ever works for the reviewer email. The compare
    // is constant-time - the code is a secret, so a byte-by-byte early exit would leak it. On success,
    // find-or-create the fully set-up reviewer account; a failure spends per-IP throttle budget exactly
    // like any other wrong code.
    if (this.isReviewerEmail(normalized)) {
      if (this.reviewer !== null && constantTimeStringEqual(code, this.reviewer.code)) {
        return this.ensureReviewerUser(normalized)
      }
      await this.bumpVerifyFailure(null, ip)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    const record = await this.store.findLatestActive(normalized, now)
    if (!record) {
      await this.bumpVerifyFailure(null, ip)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    // OUTER bound, per-CODE half (L2): failures accrued against THIS issued code. Scoped to the code
    // rather than the address so a third party cannot lock the owner out - see the constant's note.
    if ((await this.readCounter(codeFailKey(record.id))) >= OTP_VERIFY_CODE_FAIL_MAX) {
      await this.store.markConsumed(record.id, now)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    // INNER bound (P1-3, TOCTOU-safe): increment attempts FIRST and gate on the RETURNED count, so two
    // concurrent verifies cannot both read a stale pre-increment value and both slip past the ceiling.
    // The Nth attempt (1..MAX) is allowed to verify; once the count EXCEEDS MAX the code is locked.
    const attempts = await this.store.incrementAttempts(record.id)
    if (attempts > OTP_MAX_ATTEMPTS) {
      // Already exhausted by prior (possibly concurrent) attempts: lock it, even with the right code.
      await this.store.markConsumed(record.id, now)
      await this.bumpVerifyFailure(record.id, ip)
      throw AppError.unauthorized("Too many incorrect attempts. Request a new code.")
    }

    const ok = await argonVerify(record.codeHash, code)
    if (!ok) {
      // This attempt consumed a slot; lock the code once the ceiling is reached.
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.store.markConsumed(record.id, now)
      }
      await this.bumpVerifyFailure(record.id, ip)
      throw AppError.unauthorized("Invalid or expired code.")
    }

    // Success: CLAIM the code (single-use), then find-or-create the account. A verified OTP proves the
    // email, so a newly created account is marked email_verified. A success spends no throttle budget.
    //
    // The claim is what makes single-use hold under racing: two concurrent verifies of the same correct
    // code both clear the attempt ceiling (incrementAttempts returns 1 and 2, both <= MAX) and both pass
    // argon2, so without a conditional consume both would mint a session off one emailed code. Only the
    // caller whose write actually flipped consumed_at proceeds; the loser is refused exactly like a
    // replay of an already-spent code, and spends no throttle budget (it is not a wrong guess).
    const claimed = await this.store.markConsumed(record.id, now)
    if (!claimed) {
      throw AppError.unauthorized("Invalid or expired code.")
    }
    // Release the per-email RESEND cooldown this address is holding (G17, see issueOtp): the claim proves
    // inbox access, so the window's anti-mail-bomb purpose is spent and holding it only blocks the owner's
    // legitimate next step — concretely the account-deletion gate, which re-requests a code through the
    // same public endpoint immediately after sign-in. Best-effort AFTER the claim: a cache hiccup here
    // only means the owner waits out the remaining window, so it is logged and never fails the verify.
    await this.cache.del(emailCooldownKey(normalized)).catch((err: unknown) => {
      this.logger?.warn({ err }, "otp: failed to release per-email cooldown after successful verify")
    })
    const existing = await this.users.findByEmail(normalized)
    if (existing) return existing.id
    const created = await this.users.create(normalized, {
      displayName: defaultDisplayName(normalized),
      role: "citizen",
      emailVerified: true,
    })
    return created.id
  }

  /**
   * Find-or-create the reviewer account. Creates it the SAME way a normal account is created (one
   * UserStore.create, idempotent on email) but born fully set up: verified email, @reviewer handle,
   * "Reviewer Reviewer" name, profile_complete (skips first-run registration), citizen role.
   */
  private async ensureReviewerUser(normalizedEmail: string): Promise<string> {
    const existing = await this.users.findByEmail(normalizedEmail)
    if (existing) return existing.id
    const created = await this.users.create(normalizedEmail, {
      displayName: REVIEWER_DISPLAY_NAME,
      role: "citizen",
      emailVerified: true,
      handle: REVIEWER_HANDLE,
      profileComplete: true,
    })
    return created.id
  }

  /**
   * Whether the per-IP failed-verify counter is already at/over its cap for the current window. Reads
   * (does not increment) so a legitimate verify is not itself penalized.
   */
  private async ipThrottleTripped(ip: string | null): Promise<boolean> {
    if (!ip) return false
    return (await this.readCounter(ipFailKey(ip))) >= OTP_VERIFY_IP_FAIL_MAX
  }

  /**
   * Increment the failed-verify counters (window-anchored on first hit): the per-IP counter always, and
   * the per-CODE counter when the failure could be attributed to a specific issued code. `codeId` is
   * null for failures with no code behind them (unknown address, no live code, wrong reviewer code) -
   * those only spend network budget, so they cannot be aimed at a victim's account.
   */
  private async bumpVerifyFailure(codeId: string | null, ip: string | null): Promise<void> {
    if (codeId !== null) {
      await this.cache.incr(codeFailKey(codeId), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
    if (ip) {
      await this.cache.incr(ipFailKey(ip), OTP_VERIFY_FAIL_WINDOW_SECONDS)
    }
  }

  /** Read an integer counter from the cache (0 when absent / unparseable). */
  private async readCounter(key: string): Promise<number> {
    const raw = await this.cache.get(key)
    if (raw === null) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
}

/**
 * Cache key for the per-email 60s RESEND cooldown. Written by issueOtp (which also rolls it back when
 * delivery fails) and deleted by verifyOtp on a successful claim — one helper so both sides cannot drift.
 */
function emailCooldownKey(normalizedEmail: string): string {
  return `otp:rl:email:${normalizedEmail}`
}

/** Cache key for the failed-verify counter of ONE issued code (never keyed on an email address). */
function codeFailKey(codeId: string): string {
  return `otp:vf:code:${codeId}`
}

/** Cache key for the per-network failed-verify counter. */
function ipFailKey(ip: string): string {
  return `otp:vf:ip:${ip}`
}

/** Derive a default display name from an email local-part (the part before `@`). */
function defaultDisplayName(email: string): string {
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.length > 0 ? local : "citizen"
}
