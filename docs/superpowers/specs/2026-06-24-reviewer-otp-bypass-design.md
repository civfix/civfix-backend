# Reviewer-OTP bypass (backend) — design

Date: 2026-06-24
Status: approved

## Problem

The mobile app is in App Review and a new build cannot be uploaded without restarting
the review clock. App Review needs a working login, but the OTP sign-in requires a real
emailed code. We need a backend-only way for a reviewer to sign in with a known
credential we can paste into the App Review notes, without sending any email and without
shipping a new mobile build.

## Goal

A reviewer signs in with email `reviewer@civfix.org` and code `000000`:

- `POST /auth/otp/request` for that email returns `{ sent: true, resendAfterSec: 60 }`
  but sends **no email**, stores **no code**, and consumes **no rate-limit budget**.
- `POST /auth/otp/verify` with `000000` succeeds and issues a normal session; any other
  code returns the standard "Invalid or expired code." On first success it find-or-creates
  a fully set-up citizen account and never touches the OTP store / throttles.

The created account is a normal account, created via the existing `UserStore.create`
path, but born past first-run setup:

| field           | value                                              |
| --------------- | -------------------------------------------------- |
| email           | `reviewer@civfix.org` (`emailVerified: true`)      |
| handle          | `reviewer`                                          |
| displayName     | `Reviewer Reviewer` (first "Reviewer" + last "Reviewer") |
| profileComplete | `true` (skips the first-run registration gate)     |
| role            | `citizen`                                           |

Terms-acceptance and the 13+ checkbox are **client-only** in registration and are not
persisted in any column, so there is nothing to store for them.

## Enablement

On by default; disable via env. New env var `REVIEWER_OTP_BYPASS` (boolean, default
`true` in all environments via the real DI wiring). Setting `REVIEWER_OTP_BYPASS=false`
in prod makes `reviewer@civfix.org` behave like any other email (normal OTP flow), with
no code redeploy. The offline/test wiring leaves the bypass off unless a test opts in.

## Implementation

1. **`services/api/src/auth/otp.ts`**
   - Add exported constants `REVIEWER_OTP_EMAIL = "reviewer@civfix.org"`,
     `REVIEWER_OTP_CODE = "000000"`, plus the reviewer handle/display name.
   - `OtpService` constructor accepts optional `reviewer?: { email: string; code: string }`
     (email stored normalized). When absent, behavior is unchanged.
   - `issueOtp`: if the bypass is configured and the normalized email equals the reviewer
     email, return `{ resendAfterSec: OTP_EMAIL_WINDOW_SECONDS }` immediately — before any
     rate-limit, store, or mailer work.
   - `verifyOtp`: if configured and the normalized email equals the reviewer email, accept
     only the reviewer code (find-or-create the reviewer account, return userId) and reject
     anything else with `AppError.unauthorized("Invalid or expired code.")` — before any
     throttle/store work.
   - Private `ensureReviewerUser()`: `findByEmail` → return existing id, else `create(...)`
     with the full reviewer profile.

2. **`services/api/src/auth/stores.ts` + `pg-stores.ts`**
   - Extend `CreateUserInput` with optional `handle?: string` and
     `profileComplete?: boolean`. Defaults preserve today's behavior (generated placeholder
     handle, `profileComplete = false`). Both the in-memory and Pg `create` honor them. This
     keeps account creation on the single existing code path.

3. **`services/api/src/auth/reserved-handles.ts`**
   - Add `"reviewer"` to `RESERVED_HANDLES` so no real user can take `@reviewer` and the
     reviewer `create` insert cannot collide on the handle unique index.

4. **`services/api/src/env/types.ts` + `env.ts`**
   - Add `REVIEWER_OTP_BYPASS: boolean` (default `true`).

5. **`services/api/src/auth/auth-services.ts`**
   - `BuildAuthServicesOptions` gains optional `reviewer`. `buildAuthServices` forwards it
     to `OtpService`. `buildAuthServicesFromContainer` passes the reviewer config unless
     `env.REVIEWER_OTP_BYPASS === false`.

## Safety properties

- `000000` only ever works for exactly `reviewer@civfix.org` (normalized compare).
- `reviewer@civfix.org` only ever accepts `000000`; no real code is ever mailed/stored for it.
- Disabling is one env flip, no code redeploy.
- The reviewer account is an ordinary citizen — monitor or soft-delete anytime.

## Tests (TDD, in-memory stores)

- `issueOtp(reviewer)` → returns `resendAfterSec`, mails nothing, stores nothing, and can be
  called repeatedly without rate limiting.
- `verifyOtp(reviewer, "000000")` → creates a user with the exact fields above; returns id.
- `verifyOtp(reviewer, "000000")` twice → same id, exactly one user (idempotent).
- `verifyOtp(reviewer, "123456")` → unauthorized; no user created.
- `verifyOtp(non-reviewer, "000000")` → normal flow (unauthorized: no active code).
- Bypass not configured → reviewer email behaves like a normal email (no short-circuit).
- `isReservedHandle("reviewer")` → true.
