import type { Env } from "../env.js"

type WebPushEnv = Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">

export interface WebPushKeys {
  publicKey: string
  privateKey: string
  subject: string
}

// The one rule for "web push is configured": di.ts builds the web push sender from it, and
// getPushWebConfig gives browsers the public key only when that sender is built, so a browser never
// subscribes to pushes the backend cannot send.
export function webPushKeys(env: WebPushEnv): WebPushKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  }
}

export function webPushPublicKey(env: WebPushEnv & Pick<Env, "USE_FAKE_PUSH">): string | null {
  if (env.USE_FAKE_PUSH) return null
  return webPushKeys(env)?.publicKey ?? null
}
