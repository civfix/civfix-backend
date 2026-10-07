import type {
  JurisdictionDirectoryResponse,
  JurisdictionGeometryResponse,
  JurisdictionListQuery,
} from "@civfix/shared"
import type {
  JurisdictionContactsRepository,
  PatchContactsInput,
  SaveContactsInput,
} from "./jurisdiction-contacts-repository.js"

/**
 * Sentinel geoid for the synthetic directory row that aggregates waiting reports with no jurisdiction or
 * an orphaned geoid. The directory is sourced from jurisdictions, so without it those reports would be
 * invisible. It is read-only triage: Save & route and PATCH 404 on it. The admin frontend keeps a matching
 * constant (discovery-page.tsx UNMAPPED_GEOID).
 */
export const UNMAPPED_GEOID = "__unmapped__"
export const UNMAPPED_NAME = "Unmapped / Unknown jurisdiction"

export interface SaveAndRouteResult {
  geoid: string
  taskResolved: boolean
  outreachEnqueued: boolean
}

export interface OutreachEnqueuer {
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<string>
}

export interface JurisdictionContactsServiceDeps {
  repo: JurisdictionContactsRepository
  jobs: OutreachEnqueuer
  throttleDays: number
  outreachDigestEnabled: boolean
  now?: () => Date
}

/**
 * `actorId` is non-null because only operator-guarded routes call the mutations. The repository's audit
 * slot stays nullable: the outreach and autoforward jobs also drive its writes and have no operator.
 */
export interface JurisdictionContactsService {
  saveAndRoute(
    geoid: string,
    input: SaveContactsInput,
    actorId: string,
  ): Promise<SaveAndRouteResult>
  patch(geoid: string, input: PatchContactsInput, actorId: string): Promise<void>
  listDirectory(query: JurisdictionListQuery): Promise<JurisdictionDirectoryResponse>
  getGeometry(geoid: string): Promise<JurisdictionGeometryResponse>
}
