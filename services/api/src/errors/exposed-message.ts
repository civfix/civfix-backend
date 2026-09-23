import type { AppError } from "@civfix/shared"

// A 5xx message is hidden from production clients by default because most carry operator diagnostics
// (vendor responses, env var names). The few written for end users opt in here. The brand lives in the
// backend so the shared AppError contract stays unchanged.
const exposed = new WeakSet<AppError>()

export function exposeMessage<E extends AppError>(error: E): E {
  exposed.add(error)
  return error
}

export function isMessageExposed(error: AppError): boolean {
  return exposed.has(error)
}
