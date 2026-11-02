/**
 * The public legal document reads through the real Fastify app on PostGIS, over the `legal_documents` the
 * harness's migrate + load wrote from the pinned contract. The read rules themselves are covered offline in
 * test/unit/legal-routes.test.ts; this case proves the pinned contract's texts reach the API.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance } from "fastify"
import { legalDocument } from "@civfix/contract/legal"
import { LEGAL_TEXTS } from "@civfix/contract/legal-texts"
import type { LegalDocumentDTO, LegalDocumentType } from "@civfix/contract"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

const pg = await withPg()

const TYPES: readonly LegalDocumentType[] = ["terms", "privacy", "cookies", "subprocessors"]

describe.skipIf(!pg)("legal documents (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    app = await makeServer({ env, container: makeContainer(env) })
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  it("T27: serves the contract's current version of each type with its blocks", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/legal/documents" })
    expect(list.statusCode).toBe(200)
    const { documents } = list.json<{ documents: LegalDocumentDTO[] }>()

    expect(documents.map((d) => d.type)).toEqual(TYPES)
    for (const [i, type] of TYPES.entries()) {
      const document = documents[i] as LegalDocumentDTO
      const current = legalDocument(type)
      const key = `${type}@${current.version}`
      expect(document, key).toMatchObject({
        version: current.version,
        sha256: current.sha256,
        effectiveAt: current.effectiveAt,
        url: current.url,
        title: current.title,
        summary: current.summary,
        material: current.material,
      })
      expect(document.blocks, key).not.toBeNull()
      expect(document.blocks, key).toEqual(LEGAL_TEXTS[key])

      const single = await app.inject({
        method: "GET",
        url: `/v1/legal/documents/${type}/${document.version}`,
      })
      expect(single.statusCode, key).toBe(200)
      expect(single.json(), key).toEqual({ document })
    }
  })
})
