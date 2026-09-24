import { AppError, avatarGradient } from "@civfix/shared"
import type {
  CleanupDTO,
  ConnectionsListQuery,
  ListPeopleRequest,
  ListPeopleResponse,
  PaginationQuery,
  PersonDTO,
  ProfileEventsResponse,
  SocialLinks,
  UserProfileDTO,
} from "@civfix/shared"
import { toCleanupDTO, type CleanupRecord } from "./cleanup-service.js"
import { attachAffiliations, type AffiliationLoader } from "./affiliation.js"
import { officialPersonFlag } from "../auth/official-account.js"

const PEOPLE_DEFAULT_LIMIT = 20

const SUGGESTIONS_CACHE_LIMIT = 20
const SUGGESTIONS_CACHE_TTL_SEC = 5 * 60
const SUGGESTIONS_CACHE_KEY_PREFIX = "social:suggest:v1:"

export const PERSON_NOT_FOUND_MESSAGE = "Person not found"

export function suggestionsCacheKey(viewerId: string): string {
  return `${SUGGESTIONS_CACHE_KEY_PREFIX}${viewerId}`
}

export async function dropSuggestionsFor(
  cache: SuggestionsCache | undefined,
  viewerIds: readonly string[],
  logger?: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  if (cache === undefined) return
  for (const viewerId of new Set(viewerIds)) {
    try {
      await cache.del(suggestionsCacheKey(viewerId))
    } catch (err) {
      logger?.warn({ err }, "follow suggestions cache invalidation failed (ignored)")
    }
  }
}

export const PROFILE_PAST_EVENTS_LIMIT = 20

const PROFILE_UPCOMING_EVENTS_LIMIT = 20

export type ProfileWithBlock = UserProfileDTO & { blockedByMe?: boolean }

export interface PersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  avatarR2Key: string | null
  avatarUrl: string | null
  socialLinks: SocialLinks | null
  donationUrl: string | null
  showVolunteerHours: boolean | null
}

export interface ProfileStats {
  reports: number
  fixed: number
  cleanups: number
}

export interface ProfileEventsPageArgs {
  cursor: string | null
  limit: number
}

export interface ProfileEventsPage {
  items: CleanupRecord[]
  nextCursor: string | null
}

export interface UpcomingEventsArgs {
  includeAttending: boolean
  limit: number
}

export interface PeoplePage {
  items: Array<PersonView & { isFollowing: boolean }>
  nextCursor: string | null
}

export interface ConnectionsArgs {
  id: string
  viewerId: string | null
  cursor: string | null
  limit: number
}

export interface SocialRepository {
  listPeople(args: {
    viewerId: string | null
    q: string | null
    cursor: string | null
    limit: number
  }): Promise<PeoplePage>

  listFollowers(args: ConnectionsArgs): Promise<PeoplePage>

  listFollowing(args: ConnectionsArgs): Promise<PeoplePage>

  suggestFollows(args: {
    viewerId: string
    limit: number
  }): Promise<Array<PersonView & { isFollowing: boolean }>>

  findPersonById(id: string): Promise<PersonView | null>

  findPersonByHandle(handle: string): Promise<PersonView | null>

  isFollowing(followerId: string, followeeId: string): Promise<boolean>

  addFollow(followerId: string, followeeId: string): Promise<{ exists: boolean; created: boolean }>

  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }>

  followerCount(userId: string): Promise<number>

  pastEventsPageFor(userId: string, args: ProfileEventsPageArgs): Promise<ProfileEventsPage>

  upcomingEventsFor(userId: string, args: UpcomingEventsArgs): Promise<CleanupRecord[]>

  statsFor(userId: string): Promise<ProfileStats>
}

export interface SocialNotifier {
  onNewFollower(args: { followeeId: string; follower: PersonView }): Promise<void>
}

export interface SocialViewer {
  userId: string | null
}

export interface SuggestionsCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
}

export interface SocialServiceDeps {
  repo: SocialRepository
  suggestionsCache?: SuggestionsCache
  notifier?: SocialNotifier
  isBlockedEitherWay?: (viewerId: string, targetId: string) => Promise<boolean>
  blockState?: (
    viewerId: string,
    targetId: string,
  ) => Promise<{ blockedByViewer: boolean; blockedByTarget: boolean }>
  presignAvatar?: (avatarKey: string) => Promise<string>
  affiliations?: AffiliationLoader
  volunteerHoursTotalFor?: (userId: string) => Promise<number>
  logger?: { warn(obj: unknown, msg: string): void }
}

export interface SocialService {
  listPeople(req: ListPeopleRequest, viewer: SocialViewer): Promise<ListPeopleResponse>
  followSuggestions(viewerId: string, limit: number): Promise<{ results: PersonDTO[] }>
  listFollowers(
    id: string,
    viewer: SocialViewer,
    req: ConnectionsListQuery,
  ): Promise<ListPeopleResponse>
  listFollowing(
    id: string,
    viewer: SocialViewer,
    req: ConnectionsListQuery,
  ): Promise<ListPeopleResponse>
  followPerson(
    viewerId: string,
    targetId: string,
  ): Promise<{ isFollowing: boolean; followers: number }>
  unfollowPerson(
    viewerId: string,
    targetId: string,
  ): Promise<{ isFollowing: boolean; followers: number }>
  getProfile(id: string, viewer: SocialViewer): Promise<{ profile: ProfileWithBlock }>
  getProfileByHandle(handle: string, viewer: SocialViewer): Promise<{ profile: ProfileWithBlock }>
  getMyProfile(viewerId: string): Promise<{ profile: ProfileWithBlock }>
  listProfileEvents(
    id: string,
    viewer: SocialViewer,
    req: PaginationQuery,
  ): Promise<ProfileEventsResponse>
  resolveHandleToId(handle: string): Promise<string>
}

export function toPersonDTO(view: PersonView, isFollowing: boolean): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    ...(view.avatarUrl !== null ? { avatarUrl: view.avatarUrl } : {}),
    followers: view.followers,
    following: view.following,
    isFollowing,
    ...(view.donationUrl !== null ? { donationUrl: view.donationUrl } : {}),
    ...officialPersonFlag(view.id),
  }
}

export function makeSocialService(deps: SocialServiceDeps): SocialService {
  const presignAvatar = deps.presignAvatar ?? ((avatarKey: string) => Promise.resolve(avatarKey))

  async function readSuggestionsCache(viewerId: string): Promise<PersonDTO[] | null> {
    const cache = deps.suggestionsCache
    if (cache === undefined) return null
    try {
      const raw = await cache.get(suggestionsCacheKey(viewerId))
      if (raw === null) return null
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PersonDTO[]) : null
    } catch (err) {
      deps.logger?.warn({ err }, "follow suggestions cache read failed (recomputing)")
      return null
    }
  }

  async function writeSuggestionsCache(viewerId: string, results: PersonDTO[]): Promise<void> {
    const cache = deps.suggestionsCache
    if (cache === undefined) return
    try {
      await cache.set(
        suggestionsCacheKey(viewerId),
        JSON.stringify(results),
        SUGGESTIONS_CACHE_TTL_SEC,
      )
    } catch (err) {
      deps.logger?.warn({ err }, "follow suggestions cache write failed (ignored)")
    }
  }

  async function viewerFollows(targetId: string, viewer: SocialViewer): Promise<boolean> {
    if (viewer.userId === null || viewer.userId === targetId) return false
    return deps.repo.isFollowing(viewer.userId, targetId)
  }

  // A viewer who blocked the subject gets an empty listing; one the subject blocked gets the same
  // not-found as a missing person, so the block is not disclosed.
  async function listingHiddenByBlock(id: string, viewer: SocialViewer): Promise<boolean> {
    if (viewer.userId === null || viewer.userId === id || !deps.blockState) return false
    const { blockedByViewer, blockedByTarget } = await deps.blockState(viewer.userId, id)
    if (blockedByViewer) return true
    if (blockedByTarget) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
    return false
  }

  async function pageConnections(
    fn: (args: ConnectionsArgs) => Promise<PeoplePage>,
    id: string,
    viewer: SocialViewer,
    req: ConnectionsListQuery,
  ): Promise<ListPeopleResponse> {
    if (await listingHiddenByBlock(id, viewer)) return { items: [], nextCursor: null }
    const { items, nextCursor } = await fn({
      id,
      viewerId: viewer.userId,
      cursor: req.cursor ?? null,
      limit: req.limit ?? PEOPLE_DEFAULT_LIMIT,
    })
    const people = await attachAffiliations(
      deps.affiliations,
      items.map((it) => toPersonDTO(it, it.isFollowing)),
      viewer.userId,
    )
    return { items: people, nextCursor }
  }

  async function buildProfile(
    view: PersonView,
    viewer: SocialViewer,
    isSelf: boolean,
  ): Promise<UserProfileDTO> {
    const hoursHidden = !isSelf && view.showVolunteerHours === false
    const [isFollowing, pastEventsPage, upcomingEventRecords, stats, volunteerHours] =
      await Promise.all([
        isSelf ? Promise.resolve(false) : viewerFollows(view.id, viewer),
        deps.repo.pastEventsPageFor(view.id, {
          cursor: null,
          limit: PROFILE_PAST_EVENTS_LIMIT,
        }),
        deps.repo.upcomingEventsFor(view.id, {
          includeAttending: isSelf,
          limit: PROFILE_UPCOMING_EVENTS_LIMIT,
        }),
        deps.repo.statsFor(view.id),
        deps.volunteerHoursTotalFor && !hoursHidden
          ? deps.volunteerHoursTotalFor(view.id)
          : Promise.resolve(undefined),
      ])
    const pastEvents: CleanupDTO[] = pastEventsPage.items.map((r) => toCleanupDTO(r, isSelf))
    const upcomingEvents: CleanupDTO[] = upcomingEventRecords.map((r) => toCleanupDTO(r, isSelf))
    const avatarUrl =
      view.avatarR2Key !== null
        ? await presignAvatar(view.avatarR2Key)
        : (view.avatarUrl ?? undefined)
    const affiliations = deps.affiliations
      ? await deps.affiliations([view.id], viewer.userId)
      : undefined
    const organization = affiliations?.get(view.id) ?? null
    return {
      id: view.id,
      name: view.displayName,
      handle: view.handle,
      bio: view.bio,
      avatar: avatarGradient(view.id),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      followers: view.followers,
      following: view.following,
      isFollowing,
      organization,
      ...officialPersonFlag(view.id),
      ...(view.socialLinks ? { socialLinks: view.socialLinks } : {}),
      ...(view.donationUrl !== null ? { donationUrl: view.donationUrl } : {}),
      pastEvents,
      upcomingEvents,
      ...(pastEventsPage.nextCursor !== null
        ? { pastEventsCursor: pastEventsPage.nextCursor }
        : {}),
      stats,
      ...(volunteerHours !== undefined ? { volunteerHours } : {}),
      ...(view.showVolunteerHours !== null ? { showVolunteerHours: view.showVolunteerHours } : {}),
    }
  }

  function blockedProfileShell(view: PersonView): ProfileWithBlock {
    return {
      id: view.id,
      name: view.displayName,
      handle: view.handle,
      bio: null,
      avatar: avatarGradient(view.id),
      followers: 0,
      following: 0,
      isFollowing: false,
      ...officialPersonFlag(view.id),
      pastEvents: [],
      upcomingEvents: [],
      stats: { reports: 0, fixed: 0, cleanups: 0 },
      blockedByMe: true,
    }
  }

  async function resolveProfile(view: PersonView, viewer: SocialViewer): Promise<ProfileWithBlock> {
    const isSelf = viewer.userId === view.id
    if (!isSelf && viewer.userId !== null && deps.blockState) {
      const { blockedByViewer, blockedByTarget } = await deps.blockState(viewer.userId, view.id)
      if (blockedByViewer) return blockedProfileShell(view)
      if (blockedByTarget) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
    }
    return buildProfile(view, viewer, isSelf)
  }

  return {
    async listPeople(req: ListPeopleRequest, viewer: SocialViewer): Promise<ListPeopleResponse> {
      const q = req.q !== undefined && req.q.trim() !== "" ? req.q.trim() : null
      const { items, nextCursor } = await deps.repo.listPeople({
        viewerId: viewer.userId,
        q,
        cursor: req.cursor ?? null,
        limit: req.limit ?? PEOPLE_DEFAULT_LIMIT,
      })
      return {
        items: await attachAffiliations(
          deps.affiliations,
          items.map((it) => toPersonDTO(it, it.isFollowing)),
          viewer.userId,
        ),
        nextCursor,
      }
    },

    async followSuggestions(viewerId: string, limit: number): Promise<{ results: PersonDTO[] }> {
      const cached = await readSuggestionsCache(viewerId)
      if (cached !== null) return { results: cached.slice(0, limit) }
      const items = await deps.repo.suggestFollows({
        viewerId,
        limit: Math.max(limit, SUGGESTIONS_CACHE_LIMIT),
      })
      const results = await attachAffiliations(
        deps.affiliations,
        items.map((it) => toPersonDTO(it, it.isFollowing)),
        viewerId,
      )
      await writeSuggestionsCache(viewerId, results)
      return { results: results.slice(0, limit) }
    },

    async listFollowers(
      id: string,
      viewer: SocialViewer,
      req: ConnectionsListQuery,
    ): Promise<ListPeopleResponse> {
      return pageConnections((a) => deps.repo.listFollowers(a), id, viewer, req)
    },

    async listFollowing(
      id: string,
      viewer: SocialViewer,
      req: ConnectionsListQuery,
    ): Promise<ListPeopleResponse> {
      return pageConnections((a) => deps.repo.listFollowing(a), id, viewer, req)
    },

    async followPerson(
      viewerId: string,
      targetId: string,
    ): Promise<{ isFollowing: boolean; followers: number }> {
      if (viewerId === targetId) {
        throw AppError.validation({ targetId: "You cannot follow yourself." })
      }
      if (deps.isBlockedEitherWay && (await deps.isBlockedEitherWay(viewerId, targetId))) {
        throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      }
      const { exists, created } = await deps.repo.addFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)

      await dropSuggestionsFor(deps.suggestionsCache, [viewerId], deps.logger)
      const followers = await deps.repo.followerCount(targetId)

      if (created && deps.notifier) {
        const follower = await deps.repo.findPersonById(viewerId)
        if (follower) {
          try {
            await deps.notifier.onNewFollower({ followeeId: targetId, follower })
          } catch (err) {
            deps.logger?.warn(
              { err, viewerId, targetId },
              "social: new-follower notification failed (suppressed; the follow stands)",
            )
          }
        } else {
          deps.logger?.warn(
            { viewerId, targetId },
            "social: new follower row missing, notification skipped",
          )
        }
      }

      return { isFollowing: true, followers }
    },

    async unfollowPerson(
      viewerId: string,
      targetId: string,
    ): Promise<{ isFollowing: boolean; followers: number }> {
      if (viewerId === targetId) {
        throw AppError.validation({ targetId: "You cannot unfollow yourself." })
      }
      if (deps.blockState && (await deps.blockState(viewerId, targetId)).blockedByTarget) {
        throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      }
      const { exists } = await deps.repo.removeFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      await dropSuggestionsFor(deps.suggestionsCache, [viewerId], deps.logger)
      const followers = await deps.repo.followerCount(targetId)
      return { isFollowing: false, followers }
    },

    async getProfile(id: string, viewer: SocialViewer): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonById(id)
      if (!view) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      return { profile: await resolveProfile(view, viewer) }
    },

    async getProfileByHandle(
      handle: string,
      viewer: SocialViewer,
    ): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonByHandle(handle)
      if (!view) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      return { profile: await resolveProfile(view, viewer) }
    },

    async getMyProfile(viewerId: string): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonById(viewerId)
      if (!view) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      return { profile: await buildProfile(view, { userId: viewerId }, true) }
    },

    async listProfileEvents(
      id: string,
      viewer: SocialViewer,
      req: PaginationQuery,
    ): Promise<ProfileEventsResponse> {
      if (await listingHiddenByBlock(id, viewer)) return { items: [], nextCursor: null }
      const { items, nextCursor } = await deps.repo.pastEventsPageFor(id, {
        cursor: req.cursor ?? null,
        limit: req.limit ?? PROFILE_PAST_EVENTS_LIMIT,
      })
      const isSelf = viewer.userId === id
      return { items: items.map((r) => toCleanupDTO(r, isSelf)), nextCursor }
    },

    async resolveHandleToId(handle: string): Promise<string> {
      const view = await deps.repo.findPersonByHandle(handle)
      if (!view) throw AppError.notFound(PERSON_NOT_FOUND_MESSAGE)
      return view.id
    },
  }
}
