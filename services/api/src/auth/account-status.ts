import { AppError } from "@civfix/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AccountStatus } from "./stores.js"

declare module "fastify" {
  interface FastifyContextConfig {
    allowSuspended?: boolean
  }
}

export const SUSPENDED_MESSAGE =
  "This account is suspended. You can still read civfix, but you cannot post, message, or change anything until the suspension is lifted."

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

export function isSuspendedWrite(request: FastifyRequest): boolean {
  if (request.accountStatus !== "suspended") return false
  if (READ_ONLY_METHODS.has(request.method)) return false
  return request.routeOptions?.config?.allowSuspended !== true
}

export type SocketStatusCheck =
  | { kind: "live"; status: AccountStatus }
  | { kind: "revoked" }
  | { kind: "unknown" }

export type SocketWriteVerdict = "allow" | "suspended" | "revoked"

export interface RevalidatableSocketSession {
  accountStatus?: AccountStatus
  revalidateStatus?: () => Promise<SocketStatusCheck>
}

export async function socketWriteVerdict(
  session: RevalidatableSocketSession,
): Promise<SocketWriteVerdict> {
  if (session.revalidateStatus) {
    const check = await session.revalidateStatus()
    if (check.kind === "revoked") return "revoked"
    if (check.kind === "live") session.accountStatus = check.status
  }
  return session.accountStatus === "suspended" ? "suspended" : "allow"
}

export function registerAccountStatusGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    if (isSuspendedWrite(request)) throw AppError.forbidden(SUSPENDED_MESSAGE)
  })
}
