/**
 * Admin jurisdiction-contacts service (Phase 2): the "Save & route" core action + the jurisdictions
 * directory.
 *
 * "Save & route" persists a per-category routing contact for a GEOID (upserts jurisdiction_contacts +
 * mirrors the legacy contact_emails[]/report_form_url), sets contact_updated_at, marks the geoid's open
 * discovery task done, ROUTES the waiting pins (every waiting report -> acknowledged with a routed
 * timeline entry), and enqueues throttled outreach. Audit is the in-tx repo's responsibility (H4); the
 * service returns the routing outcome so the route can audit + the test can assert. See endpoints
 * #13/#14/#15.
 *
 * The pure types live in jurisdiction-contacts-types.ts and the pure directory projectors in
 * jurisdiction-directory-projection.ts; this module re-exports both so external importers keep resolving.
 */

import { AppError } from "@civfix/shared"
import type { JurisdictionListQuery } from "@civfix/shared"
import { toDirectoryDTO, hasAnyContact } from "./jurisdiction-directory-projection.js"
import {
  OUTREACH_DIGEST_JOB,
  type JurisdictionContactsService,
  type JurisdictionContactsServiceDeps,
  type PatchContactsInput,
  type SaveAndRouteResult,
  type SaveContactsInput,
} from "./jurisdiction-contacts-types.js"

export * from "./jurisdiction-contacts-types.js"
export * from "./jurisdiction-directory-projection.js"

export function makeJurisdictionContactsService(
  deps: JurisdictionContactsServiceDeps,
): JurisdictionContactsService {
  const now = deps.now ?? (() => new Date())

  return {
    async saveAndRoute(
      geoid: string,
      input: SaveContactsInput,
      actorId: string | null,
    ): Promise<SaveAndRouteResult> {
      const exists = await deps.repo.jurisdictionExists(geoid)
      if (!exists) throw AppError.notFound("Jurisdiction not found")
      if (!hasAnyContact(input)) {
        throw AppError.validation({ contacts: "At least one contact is required to route." })
      }

      // The save + route + audit run atomically in the repo (H4); the outreach enqueue is a post-commit
      // action, audited separately by the worker on send.
      const { routedReports, taskResolved } = await deps.repo.saveAndRoute(geoid, input, { actorId })
      const outreachEnqueued = await maybeEnqueueOutreach(geoid)
      return { geoid, routedReports, taskResolved, outreachEnqueued }
    },

    async patch(geoid: string, input: PatchContactsInput, actorId: string | null): Promise<void> {
      const ok = await deps.repo.patch(geoid, input, { actorId })
      if (!ok) throw AppError.notFound("Jurisdiction not found")
    },

    async listDirectory(query: JurisdictionListQuery) {
      // query.filter is the shared Zod enum ("all"|"email"|"form"|"none") enforced at the wire boundary,
      // so it is structurally the ListDirectoryArgs filter union; default to "all" when omitted.
      const { records, nextCursor } = await deps.repo.listDirectory({
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: query.filter ?? "all",
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      })
      return { items: records.map(toDirectoryDTO), nextCursor }
    },
  }

  // maybeEnqueueOutreach is best-effort throttling: the worker's outreach_state stamp is the real guard,
  // so a lost race here only risks a redundant enqueue (deduped by the singletonKey under a deduping queue
  // policy), never a missed send.
  async function maybeEnqueueOutreach(geoid: string): Promise<boolean> {
    const state = await deps.repo.getOutreachState(geoid)
    if (state?.suppressed) return false
    if (state?.lastOutreachAt) {
      const windowMs = deps.throttleDays * 24 * 60 * 60 * 1000
      if (now().getTime() - state.lastOutreachAt.getTime() < windowMs) return false
    }
    await deps.jobs.enqueue(OUTREACH_DIGEST_JOB, { geoid }, { singletonKey: geoid })
    return true
  }
}
