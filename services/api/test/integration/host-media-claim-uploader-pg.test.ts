import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { seedMediaAsset, type SeededMedia } from "../helpers/media-pg.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../../src/services/cleanup-repository.js"
import { makeDrizzleOrganizationRepository } from "../../src/services/host/organization-repository.drizzle.js"
import type { OrganizationRepository } from "../../src/services/host/organization-repository.js"
import { userUploader } from "../../src/services/media-uploader.js"

const pg = await withPg()
const FUTURE = new Date(Date.now() + 7 * 86_400_000)
const rejects422 = { httpStatus: 422, code: "VALIDATION" }

describe.skipIf(!pg)(
  "event and organization media claims (integration: the actor's own uploads)",
  () => {
    let h: PgHarness
    let cleanups: CleanupRepository
    let orgs: OrganizationRepository

    beforeAll(() => {
      h = pg as PgHarness
      cleanups = makeDrizzleCleanupRepository(h.sql)
      orgs = makeDrizzleOrganizationRepository(h.sql)
    })

    afterAll(async () => {
      await h.teardown()
    })

    async function newUser(name: string): Promise<string> {
      const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
      return u!.id
    }

    async function uploadBy(userId: string): Promise<SeededMedia> {
      return await seedMediaAsset(h.sql, { uploader: userUploader(userId) })
    }

    async function purposeOf(mediaId: string): Promise<string> {
      const [row] = await h.sql<{ purpose: string }[]>`
      SELECT purpose FROM media_assets WHERE id = ${mediaId}
    `
      return row!.purpose
    }

    function newEvent(organizerUserId: string, coverMediaId: string) {
      return cleanups.createCleanupTx({
        cleanupId: randomUUID(),
        organizerUserId,
        type: "site",
        eventKind: "cleanup",
        title: "Claimed cover sweep",
        description: null,
        lat: 34.05,
        lng: -118.25,
        scheduledAt: FUTURE,
        status: "upcoming",
        bring: null,
        address: null,
        addressSource: null,
        jurisdictionGeoid: null,
        jurCode: 0,
        linkedReportIds: [],
        slots: [],
        host: { endsAt: new Date(FUTURE.getTime() + 3_600_000), coverMediaId },
      })
    }

    function newOrg(createdBy: string, logoMediaId: string | null) {
      const slug = `claim-${randomUUID().slice(0, 8)}`
      return orgs.createOrganizationTx({
        organizationId: randomUUID(),
        slug,
        name: `Org ${slug}`,
        description: null,
        websiteUrl: null,
        logoMediaId,
        socialLinks: null,
        createdBy,
        now: new Date(),
      })
    }

    it("a new event refuses another account's upload as its cover", async () => {
      const host = await newUser("event host")
      const foreign = await uploadBy(await newUser("uploader"))

      await expect(newEvent(host, foreign.id)).rejects.toMatchObject(rejects422)
      expect(await purposeOf(foreign.id)).toBe("report")
    })

    it("a new event claims the organizer's own upload as its cover", async () => {
      const host = await newUser("event host")
      const own = await uploadBy(host)

      const created = await newEvent(host, own.id)

      expect(created.record.id).toBeDefined()
      expect(await purposeOf(own.id)).toBe("event_cover")
    })

    it("an event edit refuses another account's upload for the gallery", async () => {
      const host = await newUser("event host")
      const cleanupId = await seedCleanup(h.sql, {
        organizerUserId: host,
        title: "Gallery sweep",
        lng: -118.25,
        lat: 34.05,
        scheduledAt: FUTURE,
      })
      const foreign = await uploadBy(await newUser("uploader"))

      await expect(
        cleanups.updateCleanup(cleanupId, { galleryMediaIds: [foreign.id] }, host),
      ).rejects.toMatchObject(rejects422)

      const [row] = await h.sql<{ gallery_media_ids: string[] }[]>`
      SELECT gallery_media_ids FROM cleanups WHERE id = ${cleanupId}
    `
      expect(row!.gallery_media_ids).toEqual([])
      expect(await purposeOf(foreign.id)).toBe("report")
    })

    it("a new organization refuses another account's upload as its logo", async () => {
      const creator = await newUser("org creator")
      const foreign = await uploadBy(await newUser("uploader"))

      await expect(newOrg(creator, foreign.id)).rejects.toMatchObject(rejects422)
      expect(await purposeOf(foreign.id)).toBe("report")
    })

    it("an organization edit refuses another account's upload as its logo", async () => {
      const owner = await newUser("org owner")
      const created = await newOrg(owner, null)
      if (created === "slug_taken") throw new Error("slug unexpectedly taken")
      const foreign = await uploadBy(await newUser("uploader"))

      await expect(
        orgs.updateOrganizationTx(created.id, { logoMediaId: foreign.id }, new Date(), owner),
      ).rejects.toMatchObject(rejects422)

      const [row] = await h.sql<{ logo_media_id: string | null }[]>`
      SELECT logo_media_id FROM organizations WHERE id = ${created.id}
    `
      expect(row!.logo_media_id).toBeNull()
    })

    it("an organization edit claims the editor's own upload as its logo", async () => {
      const owner = await newUser("org owner")
      const created = await newOrg(owner, null)
      if (created === "slug_taken") throw new Error("slug unexpectedly taken")
      const own = await uploadBy(owner)

      await orgs.updateOrganizationTx(created.id, { logoMediaId: own.id }, new Date(), owner)

      expect(await purposeOf(own.id)).toBe("org_logo")
    })

    it("a verification application refuses another account's upload as a document", async () => {
      const owner = await newUser("org owner")
      const created = await newOrg(owner, null)
      if (created === "slug_taken") throw new Error("slug unexpectedly taken")
      const foreign = await uploadBy(await newUser("uploader"))

      await expect(
        orgs.applyVerificationTx({
          verificationId: randomUUID(),
          organizationId: created.id,
          kind: "nonprofit",
          einNumber: null,
          documentMediaIds: [foreign.id],
          note: null,
          submittedBy: owner,
          now: new Date(),
        }),
      ).rejects.toMatchObject(rejects422)

      expect(await purposeOf(foreign.id)).toBe("report")
      const applications = await h.sql`
      SELECT id FROM org_verifications WHERE organization_id = ${created.id}
    `
      expect(applications).toHaveLength(0)
    })
  },
)
