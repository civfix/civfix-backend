/**
 * Cookie parsing/signing via @fastify/cookie. Signed with SESSION_SIGNING_KEY so later auth steps
 * can set tamper-evident session cookies without re-registering the plugin.
 *
 * `parseOptions` are DEFAULTS only: @fastify/cookie applies them when a setter omits a field. The
 * session/CSRF cookie setters (auth/transport.ts, auth/csrf.ts) must re-assert httpOnly/secure/sameSite
 * on each `setCookie`/`clearCookie` (they do) — these defaults are the safety net, not the guarantee.
 */

import fastifyCookie from "@fastify/cookie"
import type { FastifyInstance } from "fastify"
import { isProd } from "../env.js"

export async function registerCookie(app: FastifyInstance, signingKey: string): Promise<void> {
  await app.register(fastifyCookie, {
    secret: signingKey,
    parseOptions: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: isProd(),
    },
  })
}
