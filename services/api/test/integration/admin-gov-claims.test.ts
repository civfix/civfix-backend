/**
 * Admin gov-provisioning data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * GovClaimsRepository (makeDrizzleGovClaimsRepository) + the full approve flow through the service over
 * the REAL Postgres UserStore (PgAuthStores), against a live Postgres container via withPg (so gov_claims
 * / users / audit_log all exist with their real constraints, including the gov_claims status CHECK).
 *
 * Proven here against the real schema:
 *   - listPending pages pending claims newest-first with the keyset cursor + search (name/org);
 *   - getClaim parses the `checks` jsonb into the typed per-check map;
 *   - setCheck merges one check into the checks jsonb (preserving the others) + audits gov_claim.verified;
 *   - the SERVICE approve provisions the gov user by contact_email (find-or-create) with role gov_admin,
 *     links the user on the claim, sets status 'approved' + decided_at/by, and audits gov_claim.approved;
 *   - reject sets status 'rejected' + reject_reason + decided_at/by and audits gov_claim.rejected.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleGovClaimsRepository } from "../../src/services/admin/gov-claims-repository.drizzle.js"
import {
  makeGovClaimsService,
  type GovClaimsRepository,
  type GovClaimsService,
  type ProvisionedUser,
  type UserProvisioner,
} from "../../src/services/admin/gov-claims-service.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import type { UserStore } from "../../src/auth/stores.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

/**
 * The deciding operator's address. `actorId` is NON-NULL on the service's approve/reject (every caller is
 * an operator-guarded gov route), and it lands in `audit_log.actor_id` / `gov_claims.decided_by` — both
 * uuid columns REFERENCING users(id) — so the tests must pass a real user's id, not a placeholder string.
 * Kept off the '@lacity.gov' domain the per-test cleanup wipes so it cannot collide with a provisioned
 * gov user.
 */
const OPERATOR_EMAIL = "operator@civfix.test"

/** Adapt the real Pg UserStore into the narrow UserProvisioner seam (same shape the route uses). */
function provisionerFromUserStore(store: UserStore): UserProvisioner {
  return {
    async findByEmail(email: string): Promise<ProvisionedUser | null> {
      const u = await store.findByEmail(email)
      return u ? { id: u.id, email: u.email, role: u.role, emailVerified: u.emailVerified } : null
    },
    async create(email: string, displayName: string): Promise<ProvisionedUser> {
      const u = await store.create(email, { displayName, role: "gov_admin" })
      return { id: u.id, email: u.email, role: u.role, emailVerified: u.emailVerified }
    },
    async setRole(id: string, role: string): Promise<ProvisionedUser> {
      const u = await store.setRole(id, role as Parameters<UserStore["setRole"]>[1])
      return { id: u.id, email: u.email, role: u.role, emailVerified: u.emailVerified }
    },
  }
}

/** Insert a pending gov claim and return its id. */
async function insertClaim(
  h: PgHarness,
  opts: { name?: string; org?: string; contactEmail?: string | null; geoid?: string | null },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO gov_claims (name, title, org, jurisdiction_geoid, method, contact_email, status)
    VALUES (
      ${opts.name ?? "Dana Lee"},
      'Public Works Director',
      ${opts.org ?? "City of LA"},
      ${opts.geoid === undefined ? GEOID : opts.geoid},
      'email',
      ${opts.contactEmail === undefined ? "dana@lacity.gov" : opts.contactEmail},
      'pending'
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)(
  "admin gov-claims repository + approve flow (integration: real schema)",
  () => {
    let h: PgHarness
    let repo: GovClaimsRepository
    let svc: GovClaimsService
    /** The operator row whose uuid the SERVICE approve/reject below decide as (re-inserted per test). */
    let operatorId: string

    beforeAll(() => {
      h = pg as PgHarness
      repo = makeDrizzleGovClaimsRepository(h.sql)
      const users = provisionerFromUserStore(new PgAuthStores(h.db).users)
      svc = makeGovClaimsService({ repo, users, revokeSessions: () => Promise.resolve(0) })
    })

    beforeEach(async () => {
      await h.sql`TRUNCATE gov_claims, audit_log RESTART IDENTITY CASCADE`
      // Remove any users a prior approve created (keep the schema's seeded data intact otherwise).
      await h.sql`DELETE FROM users WHERE email LIKE '%@lacity.gov'`
      // ... and the prior test's operator, so each test decides as a freshly inserted actor row.
      await h.sql`DELETE FROM users WHERE email = ${OPERATOR_EMAIL}`
      operatorId = (
        await h.sql<{ id: string }[]>`
          INSERT INTO users (display_name, email, role)
          VALUES ('Operator', ${OPERATOR_EMAIL}, 'operator')
          RETURNING id
        `
      )[0]!.id
    })

    afterAll(async () => {
      await h.teardown()
    })

    it("lists pending claims newest-first and searches by name/org", async () => {
      const a = await insertClaim(h, {
        name: "Dana Lee",
        org: "City of LA",
        contactEmail: "a@lacity.gov",
      })
      const b = await insertClaim(h, {
        name: "Sam Roe",
        org: "Town of Vienna",
        contactEmail: "b@lacity.gov",
        geoid: null,
      })

      const page = await repo.listPending({ q: null, filter: "all", cursor: null, limit: 25 })
      expect(page.records.map((r) => r.id)).toEqual([b, a]) // newest first

      const byName = await repo.listPending({ q: "dana", filter: "all", cursor: null, limit: 25 })
      expect(byName.records.map((r) => r.id)).toEqual([a])
      const byOrg = await repo.listPending({ q: "vienna", filter: "all", cursor: null, limit: 25 })
      expect(byOrg.records.map((r) => r.id)).toEqual([b])
    })

    it("setCheck merges a check into the jsonb and getClaim parses it", async () => {
      const id = await insertClaim(h, { contactEmail: "c@lacity.gov" })
      await repo.setCheck(id, {
        check: "linkedin",
        status: "verified",
        evidence: "https://linkedin.com/in/dana",
        note: "confirmed",
        actorId: null,
      })
      await repo.setCheck(id, {
        check: "directory",
        status: "verified",
        evidence: null,
        note: null,
        actorId: null,
      })
      const claim = await repo.getClaim(id)
      expect(claim?.checks.linkedin?.status).toBe("verified")
      expect(claim?.checks.linkedin?.evidence).toBe("https://linkedin.com/in/dana")
      expect(claim?.checks.directory?.status).toBe("verified")
      expect(claim?.checks.callback).toBeUndefined()

      const [audit] = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_log WHERE action = 'gov_claim.verified'
    `
      expect(Number(audit?.count)).toBe(2)
    })

    it("approve provisions a gov_admin user, links the jurisdiction, sets status approved", async () => {
      const id = await insertClaim(h, {
        name: "Dana Lee",
        contactEmail: "dana@lacity.gov",
        geoid: GEOID,
      })

      await svc.approve(id, { actorId: operatorId, note: "verified" })

      const claim = await repo.getClaim(id)
      expect(claim?.status).toBe("approved")
      expect(claim?.userId).not.toBeNull()
      expect(claim?.jurisdictionGeoid).toBe(GEOID)

      const [user] = await h.sql<{ id: string; role: string }[]>`
      SELECT id, role FROM users WHERE email = 'dana@lacity.gov'
    `
      expect(user?.role).toBe("gov_admin")
      expect(claim?.userId).toBe(user?.id)

      // The deciding operator is recorded on the claim AND on the audit row (uuid FKs to users).
      const [decided] = await h.sql<{ decided_by: string | null }[]>`
      SELECT decided_by FROM gov_claims WHERE id = ${id}
    `
      expect(decided?.decided_by).toBe(operatorId)

      const audits = await h.sql<{ actor_id: string | null }[]>`
      SELECT actor_id FROM audit_log WHERE action = 'gov_claim.approved'
    `
      expect(audits).toHaveLength(1)
      expect(audits[0]?.actor_id).toBe(operatorId)
    })

    it("reject sets status rejected + reason and audits it", async () => {
      const id = await insertClaim(h, { contactEmail: "rej@lacity.gov" })
      await svc.reject(id, { reason: "Could not verify authority", actorId: operatorId })

      const claim = await repo.getClaim(id)
      expect(claim?.status).toBe("rejected")
      expect(claim?.rejectReason).toBe("Could not verify authority")

      const [decided] = await h.sql<{ decided_by: string | null }[]>`
      SELECT decided_by FROM gov_claims WHERE id = ${id}
    `
      expect(decided?.decided_by).toBe(operatorId)

      const audits = await h.sql<{ actor_id: string | null }[]>`
      SELECT actor_id FROM audit_log WHERE action = 'gov_claim.rejected'
    `
      expect(audits).toHaveLength(1)
      expect(audits[0]?.actor_id).toBe(operatorId)
    })
  },
)
