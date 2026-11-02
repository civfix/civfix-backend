/**
 * D12's reopen filing on PostGIS, through the real Fastify app: it is written in the status change's own
 * transaction, so a failed insert rolls the reporter's reopen and the operator's status change back.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"

const pg = await withPg()

const OPERATOR_EMAIL = "ops-reopen@civfix.test"
// Test-only: any reopen filing breaks a CHECK, so the insert fails inside the status change's transaction.
const FAILING_CHECK = "t37_reopen_filing_rejected"

interface Session {
  userId: string
  cookie: string
  csrfToken: string
}

describe.skipIf(!pg)("D12 reopen filing (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices
  let op: Session

  async function user(role: "citizen" | "operator", email: string | null = null): Promise<Session> {
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES (${`User ${handle}`}, ${handle}, ${email}, ${email !== null}, ${role})
      RETURNING id
    `
    const token = await authServices.sessions.createSession(u!.id, [role])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { userId: u!.id, cookie: `civfix_session=${token}`, csrfToken }
  }

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: h.uri,
      ADMIN_EMAILS: OPERATOR_EMAIL,
    })
    container = makeContainer(env)
    authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    app = await makeServer({ env, container, authServices })
    op = await user("operator", OPERATOR_EMAIL)
    await h.sql.unsafe(
      `ALTER TABLE report_filings ADD CONSTRAINT ${FAILING_CHECK}
         CHECK (reason IS DISTINCT FROM 'reopened_after_city_closed') NOT VALID`,
    )
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  /** A resolved report its reporter owns, whose portal filing the city closed (D12). */
  async function cityClosedReport(reporterId: string): Promise<string> {
    const geoid = `r${randomUUID().slice(0, 8)}`
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom)
      VALUES (${geoid}, ${`Reopen city ${geoid}`}, 'place', 0,
              ST_Multi(ST_MakeEnvelope(-141.01, 11.0, -141.0, 11.01, 4326)))
    `
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, type, title, status,
        visibility, h3_cell, jurisdiction_geoid
      ) VALUES (
        ${reporterId}, ${randomUUID()}, ST_SetSRID(ST_MakePoint(-141.005, 11.005), 4326),
        'device', 'graffiti', 'graffiti', 'Tagged wall', 'resolved', 'public', 'h0', ${geoid}
      )
      RETURNING id
    `
    await h.sql`
      INSERT INTO report_filings (report_id, geoid, category, channel, status, method, ticket_text,
                                  submitted_at, city_closed_at)
      VALUES (${row!.id}, ${geoid}, 'graffiti', 'portal', 'submitted', 'script', 'Tagged wall',
              now(), now())
    `
    return row!.id
  }

  async function state(reportId: string) {
    const [report] = await h.sql<{ status: string }[]>`
      SELECT status FROM reports WHERE id = ${reportId}
    `
    const [timeline] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM report_timeline WHERE report_id = ${reportId}
    `
    const [filings] = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM report_filings WHERE report_id = ${reportId}
    `
    return { status: report!.status, timeline: timeline!.n, filings: filings!.n }
  }

  function post(session: Session, url: string, payload: object): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "POST",
      url,
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      payload,
    })
  }

  it("T37: when the reopen filing's insert fails, the reporter's reopen and the operator's status change both fail and leave the report resolved", async () => {
    const reporter = await user("citizen")

    const viaReporter = await cityClosedReport(reporter.userId)
    const reporterBefore = await state(viaReporter)
    const reopen = await post(reporter, `/v1/reports/${viaReporter}/resolve`, { resolved: false })
    expect(reopen.statusCode).toBeGreaterThanOrEqual(500)
    expect(await state(viaReporter)).toEqual({ ...reporterBefore, status: "resolved", filings: 1 })

    const viaOperator = await cityClosedReport(reporter.userId)
    const operatorBefore = await state(viaOperator)
    const change = await post(op, `/v1/admin/reports/${viaOperator}/status`, {
      status: "in_progress",
    })
    expect(change.statusCode).toBeGreaterThanOrEqual(500)
    expect(await state(viaOperator)).toEqual({ ...operatorBefore, status: "resolved", filings: 1 })
  })
})
