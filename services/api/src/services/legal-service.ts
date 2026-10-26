import {
  AppError,
  ErrorCode,
  LEGAL_VERSION_OUTDATED,
  type AcceptLegalRequest,
  type AcceptLegalResponse,
  type GetLegalVersionsResponse,
  type LegalAcceptAction,
  type LegalAcceptanceDTO,
  type LegalDocumentDTO,
  type LegalDocumentMetaDTO,
  type LegalDocumentType,
  type LegalDocumentVersionDTO,
  type LegalVersionOutdatedDetails,
  type MyLegalStatusResponse,
} from "@civfix/contract"
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from "@civfix/contract/legal"
import {
  SERVED_LEGAL_TYPES,
  type LegalDocumentRecord,
  type LegalDocumentsRepository,
  type LegalVersionRecord,
} from "./legal-documents-repository.js"
import type {
  LegalAcceptanceRepository,
  LegalConsentSurface,
  LegalDocumentRef,
  VersionConsent,
} from "./legal-acceptance-repository.js"

export const LEGAL_VERSIONS_CACHE_SECONDS = 300

const STALE_CONSENT_MESSAGE =
  "The terms shown to you have been updated. Reload the page and review them before continuing."

/** The documents a person must accept; the others only ever need acknowledging (DECISIONS D4). */
const MUST_ACCEPT: ReadonlySet<LegalDocumentType> = new Set(["terms", "privacy"])

/** The admin page counts acceptances of these documents' current versions (DECISIONS D13). */
const COUNTED_TYPES: readonly LegalDocumentType[] = ["terms", "privacy"]

const DEFAULT_SURFACE: Record<LegalAcceptAction, LegalConsentSurface> = {
  accepted: "prompt",
  acknowledged: "notice",
}

// The versions DTO predates §66 and keeps `title`, `summary` and `material` optional, so a pre-§66 row
// leaves them out instead of sending null.
function storedVersionDTO(record: LegalVersionRecord): LegalDocumentVersionDTO {
  return {
    type: record.type,
    version: record.version,
    sha256: record.sha256,
    effectiveAt: record.effectiveAt.toISOString(),
    url: record.url,
    ...(record.title !== null ? { title: record.title } : {}),
    ...(record.summary !== null ? { summary: record.summary } : {}),
    ...(record.material !== null ? { material: record.material } : {}),
  }
}

function metaDTO(record: LegalVersionRecord): LegalDocumentMetaDTO {
  return {
    type: record.type,
    version: record.version,
    effectiveAt: record.effectiveAt.toISOString(),
    url: record.url,
    title: record.title,
    summary: record.summary,
    material: record.material,
    sha256: record.sha256,
  }
}

function documentDTO(record: LegalDocumentRecord): LegalDocumentDTO {
  return { ...metaDTO(record), blocks: record.blocks }
}

function keyOf(entry: { type: string; version: string }): string {
  return `${entry.type}@${entry.version}`
}

function lastIndexWhere<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i] as T)) return i
  return -1
}

function hasRecord(version: VersionConsent): boolean {
  return version.acceptedAt !== null || version.acknowledgedAt !== null
}

// The later record at that version; accepting wins a tie, being the stronger of the two.
function acceptanceOf(version: VersionConsent): LegalAcceptanceDTO | null {
  const { acceptedAt, acknowledgedAt } = version
  if (acceptedAt !== null && (acknowledgedAt === null || acceptedAt >= acknowledgedAt)) {
    return { version: version.version, action: "accepted", at: acceptedAt.toISOString() }
  }
  if (acknowledgedAt === null) return null
  return { version: version.version, action: "acknowledged", at: acknowledgedAt.toISOString() }
}

interface TypeStatus {
  current: VersionConsent
  required: boolean
  notice: boolean
  latest: LegalAcceptanceDTO | null
}

/**
 * DECISIONS D4 for one type, from its versions in effect, oldest first. "Last accepted" is the newest
 * version with a record, never the newest record: consenting at an event to the version before the
 * current one must not undo having accepted the current one.
 */
function typeStatus(
  type: LegalDocumentType,
  versions: readonly VersionConsent[],
): TypeStatus | null {
  const current = versions.at(-1)
  if (current === undefined) return null
  const lastAccepted = lastIndexWhere(versions, (v) => v.acceptedAt !== null)
  const lastRecorded = lastIndexWhere(versions, hasRecord)
  const required =
    MUST_ACCEPT.has(type) &&
    (lastAccepted === -1 || versions.slice(lastAccepted + 1).some((v) => v.material === true))
  const latestVersion = versions[lastRecorded]
  return {
    current,
    required,
    notice: !required && lastRecorded < versions.length - 1,
    latest: latestVersion === undefined ? null : acceptanceOf(latestVersion),
  }
}

function legalStatusOf(versions: readonly VersionConsent[]): MyLegalStatusResponse {
  const status: MyLegalStatusResponse = { required: [], notices: [], accepted: {} }
  for (const type of SERVED_LEGAL_TYPES) {
    const of = typeStatus(
      type,
      versions.filter((v) => v.type === type),
    )
    if (of === null) continue
    if (of.required) status.required.push(metaDTO(of.current))
    if (of.notice) status.notices.push(metaDTO(of.current))
    if (of.latest !== null) status.accepted[type] = of.latest
  }
  return status
}

function legalVersionOutdated(current: readonly LegalDocumentRef[]): AppError {
  if (current.length === 0) return AppError.internal("No legal document is in effect")
  const details: LegalVersionOutdatedDetails = {
    reason: LEGAL_VERSION_OUTDATED,
    current: current.map(({ type, version, sha256 }) => ({ type, version, sha256 })),
  }
  return new AppError(ErrorCode.CONFLICT, STALE_CONSENT_MESSAGE, { details })
}

/** Whether `err` is the CONFLICT a stale legal version answers, which a client acts on (DECISIONS D7). */
export function isLegalVersionOutdated(err: AppError): boolean {
  return err.code === ErrorCode.CONFLICT && err.details?.reason === LEGAL_VERSION_OUTDATED
}

function inServedOrder<T extends { type: LegalDocumentType }>(entries: readonly T[]): T[] {
  return SERVED_LEGAL_TYPES.flatMap((type) => entries.filter((entry) => entry.type === type))
}

export interface LegalServiceDeps {
  repo: LegalDocumentsRepository
  acceptances: LegalAcceptanceRepository
  now: () => Date
}

export interface LegalService {
  currentDocuments(): Promise<LegalDocumentDTO[]>
  document(type: LegalDocumentType, version: string): Promise<LegalDocumentDTO>
  currentVersions(): Promise<GetLegalVersionsResponse>
  allVersions(): Promise<GetLegalVersionsResponse>
  status(userId: string): Promise<MyLegalStatusResponse>
  accept(userId: string, request: AcceptLegalRequest): Promise<AcceptLegalResponse>
}

/** Serves legal documents from `legal_documents`, never from the contract constant (DECISIONS §66). */
export function makeLegalService({ repo, acceptances, now }: LegalServiceDeps): LegalService {
  return {
    async currentDocuments() {
      return (await repo.current(now())).map(documentDTO)
    },

    async document(type, version) {
      const record = await repo.find(type, version)
      if (record === null) throw AppError.notFound("Legal document not found")
      return documentDTO(record)
    },

    async currentVersions() {
      const at = now()
      const documents = (await repo.current(at)).map(storedVersionDTO)
      return { documents, generatedAt: at.toISOString() }
    },

    async allVersions() {
      const at = now()
      const versions = await repo.listVersions()
      // Newest first, so the first version in effect of a type is its current one.
      const counted = COUNTED_TYPES.flatMap((type) => {
        const current = versions.find((v) => v.type === type && v.effectiveAt <= at)
        return current === undefined ? [] : [current]
      })
      const counts = counted.length === 0 ? null : await acceptances.acceptanceCounts(counted)
      const countedKeys = new Set(counted.map(keyOf))
      const documents = versions.map((version) => {
        const dto = storedVersionDTO(version)
        if (counts === null || !countedKeys.has(keyOf(version))) return dto
        return {
          ...dto,
          acceptedCount: counts.accepted.get(keyOf(version)) ?? 0,
          activeAccounts: counts.activeAccounts,
        }
      })
      return { documents, generatedAt: at.toISOString() }
    },

    async status(userId) {
      return legalStatusOf(await acceptances.versionsFor(userId, now()))
    },

    async accept(userId, request) {
      const at = now()
      return acceptances.withUserLock(userId, async (tx) => {
        const versions = await tx.versionsFor(userId, at)
        const status = legalStatusOf(versions)
        const current = new Map(
          SERVED_LEGAL_TYPES.flatMap((type) => {
            const latest = versions[lastIndexWhere(versions, (v) => v.type === type)]
            return latest === undefined ? [] : [[type, latest] as const]
          }),
        )

        const stale = request.items.some((item) => {
          const shown = current.get(item.type)
          return shown?.version !== item.version || shown.sha256 !== item.sha256
        })
        if (stale) {
          throw legalVersionOutdated(
            inServedOrder(request.items).flatMap((item) => current.get(item.type) ?? []),
          )
        }

        if (request.surface === "signup" && versions.some(hasRecord)) {
          throw AppError.validation({
            surface: "is only for a new account, before anything else is accepted",
          })
        }

        const required = new Set(status.required.map((document) => document.type))
        const fields: Record<string, string> = {}
        request.items.forEach((item, index) => {
          if (item.action === "acknowledged" && required.has(item.type)) {
            fields[`items.${index}.action`] = `must be accepted: the ${item.type} need accepting`
          }
        })
        if (Object.keys(fields).length > 0) throw AppError.validation(fields)

        const fresh = request.items.filter((item) => {
          const recorded = current.get(item.type)
          return (
            (item.action === "accepted" ? recorded?.acceptedAt : recorded?.acknowledgedAt) == null
          )
        })
        if (fresh.length === 0) return status
        await tx.insert(
          userId,
          fresh.map((item) => ({
            type: item.type,
            version: item.version,
            sha256: item.sha256,
            action: item.action,
            surface: request.surface ?? DEFAULT_SURFACE[item.action],
          })),
          at,
        )
        return legalStatusOf(await tx.versionsFor(userId, at))
      })
    },
  }
}

export interface EventConsentClaim {
  termsVersion: string
  disclosureVersion: string
}

function acceptedForEvent(
  type: LegalDocumentType,
  claimed: string,
  versions: readonly LegalDocumentVersion[],
  now: Date,
): { current: LegalDocumentVersion | undefined; match: LegalDocumentVersion | undefined } {
  const inEffect = versions.filter(
    (v) => v.type === type && Date.parse(v.effectiveAt) <= now.getTime(),
  )
  const current = inEffect.at(-1)
  const previous = inEffect.at(-2)
  if (current?.version === claimed) return { current, match: current }
  if (current?.material === false && previous?.version === claimed)
    return { current, match: previous }
  return { current, match: undefined }
}

/**
 * DECISIONS D7: event registration and guest RSVP accept the current Terms and Privacy versions, or the
 * one just before when the current one is not material, so a minor change never breaks an older build.
 * Reads the contract's metadata, which the loader guarantees matches `legal_documents`, so it adds no
 * query. Returns the accepted versions with their sha256, Terms then Privacy.
 */
export function eventConsentDocuments(
  claim: EventConsentClaim,
  now: Date,
  versions: readonly LegalDocumentVersion[] = LEGAL_DOCUMENTS,
): LegalDocumentRef[] {
  const terms = acceptedForEvent("terms", claim.termsVersion, versions, now)
  const privacy = acceptedForEvent("privacy", claim.disclosureVersion, versions, now)
  if (terms.match === undefined || privacy.match === undefined) {
    throw legalVersionOutdated([terms.current, privacy.current].flatMap((current) => current ?? []))
  }
  return [terms.match, privacy.match].map(({ type, version, sha256 }) => ({
    type,
    version,
    sha256,
  }))
}
