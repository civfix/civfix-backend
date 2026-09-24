/**
 * `parseOptions` are only DEFAULTS that @fastify/cookie applies when a setter omits a field. The session
 * and CSRF setters (auth/transport.ts, auth/csrf.ts) must still re-assert httpOnly/secure/sameSite on each
 * `setCookie`/`clearCookie`; these defaults are the safety net, not the guarantee.
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
