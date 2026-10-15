// "Save & route" does not touch the geoid's reports: nothing is mailed per report here, so nothing is
// marked routed. The types and directory projectors are re-exported so external importers keep resolving.

import { AppError } from "@civfix/shared"
import type { JurisdictionListQuery } from "@civfix/shared"
import { toDirectoryDTO, hasAnyContact } from "./jurisdiction-directory-projection.js"
import type { PatchContactsInput, SaveContactsInput } from "./jurisdiction-contacts-repository.js"
import { isReservedHandle } from "../../auth/reserved-handles.js"
import { clampLimit } from "./pagination.js"
import { isThrottled } from "./outreach-service.js"
import type {
  JurisdictionContactsService,
  JurisdictionContactsServiceDeps,
  SaveAndRouteResult,
} from "./jurisdiction-contacts-types.js"
import { OUTREACH_DIGEST_JOB } from "../../lib/queue-names.js"

export * from "./jurisdiction-contacts-types.js"
export * from "./jurisdiction-directory-projection.js"

const JURISDICTION_NOT_FOUND = "Jurisdiction not found"

export function makeJurisdictionContactsService(
  deps: JurisdictionContactsServiceDeps,
): JurisdictionContactsService {
  const now = deps.now ?? (() => new Date())

  return {
    async saveAndRoute(
      geoid: string,
      input: SaveContactsInput,
      actorId: string,
    ): Promise<SaveAndRouteResult> {
      const exists = await deps.repo.jurisdictionExists(geoid)
      if (!exists) throw AppError.notFound(JURISDICTION_NOT_FOUND)
      if (!hasAnyContact(input)) {
        throw AppError.validation({ contacts: "At least one contact is required to route." })
      }

      // The save and its audit commit together in the repo; the outreach enqueue is post-commit and is
      // audited separately by the worker on send.
      const { taskResolved } = await deps.repo.saveAndRoute(geoid, input, { actorId })
      const outreachEnqueued = await maybeEnqueueOutreach(geoid)
      return { geoid, taskResolved, outreachEnqueued }
    },

    async patch(geoid: string, input: PatchContactsInput, actorId: string): Promise<void> {
      // The same blocklist that bars user handles from impersonating system or jurisdiction names.
      // Uniqueness is checked in the repo, which needs the live table in-transaction.
      if (
        typeof input.handle === "string" &&
        input.handle !== "" &&
        isReservedHandle(input.handle)
      ) {
        throw AppError.validation({ handle: "That @handle is reserved." })
      }
      const ok = await deps.repo.patch(geoid, input, { actorId })
      if (!ok) throw AppError.notFound(JURISDICTION_NOT_FOUND)
    },

    async listDirectory(query: JurisdictionListQuery) {
      // The shared Zod enums enforced at the wire boundary are structurally the ListDirectoryArgs unions.
      const { records, nextCursor, total, facets } = await deps.repo.listDirectory({
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        filter: query.filter ?? "all",
        layer: query.layer ?? null,
        sort: query.sort ?? "population",
        cursor: query.cursor ?? null,
        limit: clampLimit(query.limit),
      })
      return {
        items: records.map(toDirectoryDTO),
        nextCursor,
        ...(total !== null ? { total } : {}),
        ...(facets !== null ? { facets } : {}),
      }
    },

    async getGeometry(geoid: string) {
      const record = await deps.repo.getGeometry(geoid)
      if (!record) throw AppError.notFound("Jurisdiction boundary not found")
      return record
    },
  }

  // Best-effort throttling: the worker's outreach_state stamp is the real guard, so a lost race here only
  // risks a redundant enqueue (deduped by singletonKey), never a missed send.
  async function maybeEnqueueOutreach(geoid: string): Promise<boolean> {
    if (!deps.outreachDigestEnabled) return false
    const state = await deps.repo.getOutreachState(geoid)
    if (state?.suppressed) return false
    if (isThrottled(state?.lastOutreachAt ?? null, now(), deps.throttleDays)) return false
    await deps.jobs.enqueue(OUTREACH_DIGEST_JOB, { geoid }, { singletonKey: geoid })
    return true
  }
}
