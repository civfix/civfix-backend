/**
 * Cookie parsing/signing via @fastify/cookie. Signed with SESSION_SIGNING_KEY so later auth steps
 * can set tamper-evident session cookies without re-registering the plugin.
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
      // Validated env loader (not a raw process.env read) is the single source of truth for prod.
      secure: isProd(),
    },
  })
}
