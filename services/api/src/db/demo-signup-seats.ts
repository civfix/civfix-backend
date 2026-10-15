/**
 * Guard-free module (no runIfMain), shared by both demo CLIs: tsup (splitting: false) inlines imports
 * into each bundled entry, so a guard in an imported CLI would fire inside the importing bundle and run
 * the wrong main.
 */

import { randomUUID } from "node:crypto"
import type { Queryable } from "./client.js"
import { ensureSignupRegistrationIn } from "../services/cleanup-repository.drizzle.js"
import { makeTicketTokenSigner } from "../services/host/ticket-token.js"
import { loadRegistrationEnv } from "../env/registration-env.js"

const TICKET_TOKEN_SECRET_KEY = "TICKET_TOKEN_SECRET"

/**
 * Resolves the secret exactly as the API does (including its development fallback), because a seat
 * hashed with any other secret never scans at check-in.
 */
export function demoTicketTokenHasher(
  source: Record<string, string | undefined> = process.env,
): (seatId: string) => string {
  const errors: string[] = []
  const secret = loadRegistrationEnv(source, errors).TICKET_TOKEN_SECRET.trim()
  const secretErrors = errors.filter((error) => error.startsWith(`${TICKET_TOKEN_SECRET_KEY}:`))
  if (secretErrors.length > 0 || secret === "") {
    throw new Error(
      [
        `${TICKET_TOKEN_SECRET_KEY} must be the API's own secret so demo seats scan`,
        ...secretErrors,
      ].join("; "),
    )
  }
  const signer = makeTicketTokenSigner(secret)
  return (seatId) => signer.hashFor(seatId)
}

/** A no-op on ticketed events: only the free join path mints a registration. */
export async function mintDemoSignupSeats(
  tx: Queryable,
  args: {
    cleanupId: string
    members: readonly { user_id: string; joined_at: Date }[]
    hashFor: (seatId: string) => string
  },
): Promise<number> {
  let minted = 0
  for (const member of args.members) {
    const seatId = randomUUID()
    const registrationId = await ensureSignupRegistrationIn(tx, {
      cleanupId: args.cleanupId,
      userId: member.user_id,
      seatId,
      tokenHash: args.hashFor(seatId),
      now: member.joined_at,
    })
    if (registrationId !== null) minted += 1
  }
  return minted
}
