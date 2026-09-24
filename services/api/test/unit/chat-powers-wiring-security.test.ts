import { describe, it, expect } from "vitest"
import type { FastifyInstance } from "fastify"
import type { Container } from "../../src/di.js"
import { wireChatPowers } from "../../src/routes/chat-powers-wiring.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

const REPORT = "cccccccc-cccc-cccc-cccc-cccccccccccc"
const FORMER_OPERATOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const ALLOWLISTED_EMAIL = "ops@civfix.org"

interface UserRow {
  role: "citizen" | "operator"
  email: string | null
}

function resolverFor(user: UserRow, reportChatRole: "owner" | "member" | null = null) {
  const { sql } = makeFakeSql([
    { match: /FROM report_chat_members/, rows: reportChatRole ? [{ role: reportChatRole }] : [] },
    { match: /FROM users/, rows: [user] },
  ])
  const container = {
    env: { ADMIN_EMAILS: [ALLOWLISTED_EMAIL] },
    getDb: () => ({ sql }),
  } as unknown as Container
  return wireChatPowers({} as FastifyInstance, container)
}

const reportPowers = (user: UserRow, reportChatRole: "owner" | "member" | null = null) =>
  resolverFor(
    user,
    reportChatRole,
  )({
    roomKind: "report",
    roomId: REPORT,
    userId: FORMER_OPERATOR,
  })

describe("report-chat operator powers follow the live ADMIN_EMAILS allowlist", () => {
  it("an operator whose email left ADMIN_EMAILS can neither pin nor delete others", async () => {
    await expect(
      reportPowers({ role: "operator", email: "former-ops@civfix.org" }),
    ).resolves.toEqual({ canPin: false, canDeleteOthers: false, isModerator: false })
  })

  it("an operator row with no email (anonymized) has no operator powers", async () => {
    await expect(reportPowers({ role: "operator", email: null })).resolves.toEqual({
      canPin: false,
      canDeleteOthers: false,
      isModerator: false,
    })
  })

  it("an allowlisted operator keeps pin and delete, matching emails like the admin guard", async () => {
    await expect(reportPowers({ role: "operator", email: "  Ops@CivFix.org " })).resolves.toEqual({
      canPin: true,
      canDeleteOthers: true,
      isModerator: true,
    })
  })

  it("an allowlisted email without the operator role grants nothing", async () => {
    await expect(reportPowers({ role: "citizen", email: ALLOWLISTED_EMAIL })).resolves.toEqual({
      canPin: false,
      canDeleteOthers: false,
      isModerator: false,
    })
  })

  it("an off-boarded operator who owns the report keeps only the owner's pin power", async () => {
    await expect(
      reportPowers({ role: "operator", email: "former-ops@civfix.org" }, "owner"),
    ).resolves.toEqual({ canPin: true, canDeleteOthers: false, isModerator: true })
  })
})
