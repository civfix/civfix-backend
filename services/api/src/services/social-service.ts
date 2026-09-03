
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

export const PEOPLE_DEFAULT_LIMIT = 20

/**
 * H18: follow suggestions are expensive relative to how little they change (they rank on a materialized
 * activity point and a denormalized follower count, neither of which moves in seconds), and the route
 * allows 30/min per identity. One entry per viewer, holding the widest page the contract permits, so a
 * caller asking for fewer just slices the same ranking. Invalidated on follow/unfollow, which are the
 * only actions that make a cached row WRONG rather than merely stale.
 */
export const SUGGESTIONS_CACHE_LIMIT = 20
export const SUGGESTIONS_CACHE_TTL_SEC = 5 * 60

function suggestionsCacheKey(viewerId: string): string {
  return `social:suggest:v1:${viewerId}`
}

export const PROFILE_PAST_EVENTS_LIMIT = 20

export const PROFILE_UPCOMING_EVENTS_LIMIT = 20

export type ProfileWithBlock = UserProfileDTO & { blockedByMe?: boolean }

export interface PersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  verified: boolean
  avatarR2Key: string | null
  avatarUrl: string | null
  socialLinks: SocialLinks | null
  /**
   * P6 hours privacy — the `users.show_volunteer_hours` TRI-STATE (C18), carried raw:
   *   null = never chosen, true = explicit opt-in, false = explicit opt-out.
   * EVERY SQL projection that builds a PersonView selects it; see buildProfile for the three arms.
   */
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

export interface SocialRepository {
  listPeople(args: {
    viewerId: string | null
    q: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  listFollowers(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  listFollowing(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  /**
   * Follow suggestions for the viewer. The repo returns candidates ALREADY filtered (no self, no
   * already-followed, no blocked-either-way, no deleted/handle-less users) and ALREADY ranked:
   * people active near the viewer's own recent activity first — community organizers (cleanup/event
   * hosts) ahead of ordinary nearby users — then organizers elsewhere, then everyone else by reach.
   */
  suggestFollows(args: {
    viewerId: string
    limit: number
  }): Promise<Array<PersonView & { isFollowing: boolean }>>

  findPersonById(id: string): Promise<PersonView | null>

  findPersonByHandle(handle: string): Promise<PersonView | null>

  isFollowing(followerId: string, followeeId: string): Promise<boolean>

  addFollow(
    followerId: string,
    followeeId: string,
  ): Promise<{ exists: boolean; created: boolean }>

  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }>

  followerCount(userId: string): Promise<number>

  pastEventsPageFor(userId: string, args: ProfileEventsPageArgs): Promise<ProfileEventsPage>

  upcomingEventsFor(userId: string, args: UpcomingEventsArgs): Promise<CleanupRecord[]>

  statsFor(userId: string): Promise<ProfileStats>
}

export interface SocialNotifier {
  onNewFollower(args: {
    followeeId: string
    follower: PersonView
  }): Promise<void>
}

export interface SocialViewer {
  userId: string | null
}

/** The 3-verb slice of the Redis cache this service uses (auth/cache.js CacheClient shape). */
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
    verified: view.verified,
  }
}

export function makeSocialService(deps: SocialServiceDeps): SocialService {
  const presignAvatar = deps.presignAvatar ?? ((avatarKey: string) => Promise.resolve(avatarKey))

  // A cache miss, a malformed entry and an unreachable Redis are all the same thing here: recompute.
  // Suggestions are advisory, so a cache fault must never turn into a 500 on a read path.
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

  async function dropSuggestionsCache(viewerId: string): Promise<void> {
    const cache = deps.suggestionsCache
    if (cache === undefined) return
    try {
      await cache.del(suggestionsCacheKey(viewerId))
    } catch (err) {
      deps.logger?.warn({ err }, "follow suggestions cache invalidation failed (ignored)")
    }
  }

  async function viewerFollows(targetId: string, viewer: SocialViewer): Promise<boolean> {
    if (viewer.userId === null || viewer.userId === targetId) return false
    return deps.repo.isFollowing(viewer.userId, targetId)
  }

  async function pageConnections(
    fn: (args: {
      id: string
      viewerId: string | null
      cursor: string | null
      limit: number
    }) => Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>,
    id: string,
    viewer: SocialViewer,
    req: ConnectionsListQuery,
  ): Promise<ListPeopleResponse> {
    if (viewer.userId !== null && viewer.userId !== id && deps.blockState) {
      const { blockedByViewer, blockedByTarget } = await deps.blockState(viewer.userId, id)
      if (blockedByViewer) return { items: [], nextCursor: null }
      if (blockedByTarget) throw AppError.notFound("Person not found")
    }
    const { items, nextCursor } = await fn({
      id,
      viewerId: viewer.userId,
      cursor: req.cursor ?? null,
      limit: req.limit ?? PEOPLE_DEFAULT_LIMIT,
    })
    return { items: items.map((it) => toPersonDTO(it, it.isFollowing)), nextCursor }
  }

  async function buildProfile(
    view: PersonView,
    viewer: SocialViewer,
    isSelf: boolean,
  ): Promise<UserProfileDTO> {
    // P6 hours privacy, the THREE-STATE gate (C18). `show_volunteer_hours` is nullable on purpose:
    //   false -> explicit opt-out: `volunteerHours` is OMITTED and `showVolunteerHours: false` is emitted.
    //            That PAIR is how the client tells "hidden" apart from "genuinely zero hours" — a bare
    //            omission is ambiguous, and a 0 would be a lie.
    //   null  -> never chosen: `volunteerHours` exactly as before the column existed, and
    //            `showVolunteerHours` OMITTED. This response is byte-identical to today's for every
    //            account that already exists; only the new ITEMISED ledger stays closed.
    //   true  -> explicit opt-in: both.
    // isSelf BYPASSES the flag entirely — your own profile always shows your own hours, and your own DTO
    // still carries the raw tri-state so the settings toggle can render the honest position.
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
        // Not merely dropped from the response: the total is never ASKED FOR when it is hidden, which
        // saves the query and keeps the opt-out from being observable as a timing difference.
        deps.volunteerHoursTotalFor && !hoursHidden
          ? deps.volunteerHoursTotalFor(view.id)
          : Promise.resolve(undefined),
      ])
    // CleanupDTO.joined is the VIEWER's membership, not the profile owner's. These records are the OWNER's
    // events (organized or attended), so on your own profile every card is genuinely `joined`; on someone
    // else's it is unknown without a per-event membership lookup, and `false` is the honest answer rather
    // than telling the viewer they are attending events they never joined (myRole stays omitted either way).
    const pastEvents: CleanupDTO[] = pastEventsPage.items.map((r) => toCleanupDTO(r, isSelf))
    const upcomingEvents: CleanupDTO[] = upcomingEventRecords.map((r) => toCleanupDTO(r, isSelf))
    const avatarUrl =
      view.avatarR2Key !== null
        ? await presignAvatar(view.avatarR2Key)
        : (view.avatarUrl ?? undefined)
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
      verified: view.verified,
      ...(view.socialLinks ? { socialLinks: view.socialLinks } : {}),
      pastEvents,
      upcomingEvents,
      ...(pastEventsPage.nextCursor !== null
        ? { pastEventsCursor: pastEventsPage.nextCursor }
        : {}),
      stats,
      ...(volunteerHours !== undefined ? { volunteerHours } : {}),
      // Emitted only when the user has actually CHOSEN. Absent = never chosen, on your own profile as
      // much as on anyone else's.
      ...(view.showVolunteerHours !== null
        ? { showVolunteerHours: view.showVolunteerHours }
        : {}),
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
      verified: view.verified,
      pastEvents: [],
      upcomingEvents: [],
      stats: { reports: 0, fixed: 0, cleanups: 0 },
      blockedByMe: true,
    }
  }

  async function resolveProfile(
    view: PersonView,
    viewer: SocialViewer,
  ): Promise<ProfileWithBlock> {
    const isSelf = viewer.userId === view.id
    if (!isSelf && viewer.userId !== null && deps.blockState) {
      const { blockedByViewer, blockedByTarget } = await deps.blockState(viewer.userId, view.id)
      if (blockedByViewer) return blockedProfileShell(view)
      if (blockedByTarget) throw AppError.notFound("Person not found")
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
        items: items.map((it) => toPersonDTO(it, it.isFollowing)),
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
      // The repo already excludes followed users, but keep the DTO honest either way.
      const results = items.map((it) => toPersonDTO(it, it.isFollowing))
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
        throw AppError.notFound("Person not found")
      }
      const { exists, created } = await deps.repo.addFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound("Person not found")

      await dropSuggestionsCache(viewerId)
      const followers = await deps.repo.followerCount(targetId)

      if (created && deps.notifier) {
        const follower = await deps.repo.findPersonById(viewerId)
        if (follower) {
          try {
            await deps.notifier.onNewFollower({ followeeId: targetId, follower })
          } catch {
            void 0
          }
        } else {
          deps.logger?.warn({ viewerId, targetId }, "social: new follower row missing, notification skipped")
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
        throw AppError.notFound("Person not found")
      }
      const { exists } = await deps.repo.removeFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound("Person not found")
      await dropSuggestionsCache(viewerId)
      const followers = await deps.repo.followerCount(targetId)
      return { isFollowing: false, followers }
    },

    async getProfile(id: string, viewer: SocialViewer): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonById(id)
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await resolveProfile(view, viewer) }
    },

    async getProfileByHandle(
      handle: string,
      viewer: SocialViewer,
    ): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonByHandle(handle)
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await resolveProfile(view, viewer) }
    },

    async getMyProfile(viewerId: string): Promise<{ profile: ProfileWithBlock }> {
      const view = await deps.repo.findPersonById(viewerId)
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await buildProfile(view, { userId: viewerId }, true) }
    },

    async listProfileEvents(
      id: string,
      viewer: SocialViewer,
      req: PaginationQuery,
    ): Promise<ProfileEventsResponse> {
      if (viewer.userId !== null && viewer.userId !== id && deps.blockState) {
        const { blockedByViewer, blockedByTarget } = await deps.blockState(viewer.userId, id)
        if (blockedByViewer) return { items: [], nextCursor: null }
        if (blockedByTarget) throw AppError.notFound("Person not found")
      }
      const { items, nextCursor } = await deps.repo.pastEventsPageFor(id, {
        cursor: req.cursor ?? null,
        limit: req.limit ?? PROFILE_PAST_EVENTS_LIMIT,
      })
      const isSelf = viewer.userId === id
      return { items: items.map((r) => toCleanupDTO(r, isSelf)), nextCursor }
    },

    async resolveHandleToId(handle: string): Promise<string> {
      const view = await deps.repo.findPersonByHandle(handle)
      if (!view) throw AppError.notFound("Person not found")
      return view.id
    },
  }
}
