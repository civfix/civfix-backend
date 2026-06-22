/**
 * Social service: the people-directory / follow-graph / public-profile half of the social domain.
 *
 * All DB access sits behind a SocialRepository seam (Drizzle impl in social-repository.drizzle.ts; an
 * in-memory impl in the offline tests). On a NEW follow only (not an idempotent re-follow) followPerson
 * fires a best-effort `new_follower` notification — a notifier rejection is caught so the follow still
 * succeeds. getProfile assembles a UserProfileDTO whose pastEvents reuse the cleanups domain's
 * CleanupRecord -> CleanupDTO projection so the shapes never drift.
 */

import { AppError, avatarGradient } from "@civfix/shared"
import type {
  CleanupDTO,
  ConnectionsListQuery,
  ListPeopleRequest,
  ListPeopleResponse,
  PersonDTO,
  UserProfileDTO,
} from "@civfix/shared"
import { toCleanupDTO, type CleanupRecord } from "./cleanup-service.js"

/** Default page size for listPeople when the request omits `limit`. Matches the shared cap of 50. */
export const PEOPLE_DEFAULT_LIMIT = 20

/** Max past-events surfaced on a profile. Bounds the payload; recent-first so the newest are kept. */
export const PROFILE_PAST_EVENTS_LIMIT = 20

/** A person row as the directory/profile reads project it (avatar gradient is derived in the service). */
export interface PersonView {
  id: string
  displayName: string
  handle: string | null
  bio: string | null
  followers: number
  following: number
  /** Whether the account is document-verified (drives the verified mark on profiles + person detail). */
  verified: boolean
  /**
   * The object-store key of the user's uploaded avatar (users.avatar_media_id -> media_assets.r2_key), or
   * null when they have not set one. buildProfile presigns it into a client-usable `avatarUrl` (avatars are
   * public). Raw key only; the read path injects the presigner.
   */
  avatarR2Key: string | null
  /**
   * The CANONICAL avatar URL stored on users.avatar_url (the public URL persisted on upload; falls back to
   * a provider photo). Used by the synchronous list projection (toPersonDTO), which has no presigner; the
   * profile path still presigns avatarR2Key (same URL). null => no photo, clients render the monogram.
   */
  avatarUrl: string | null
}

/** Aggregate stats shown on a profile: the user's report count + the count of cleanups they organized. */
export interface ProfileStats {
  reports: number
  cleanups: number
}

/**
 * Persistence seam for the social domain. The production impl runs Drizzle; the offline tests pass an
 * in-memory implementation. Keeping ALL people/follow/profile access behind this interface is what makes
 * the service testable with no DB.
 */
export interface SocialRepository {
  /**
   * Page people for the directory, excluding the viewer (when signed in) and soft-deleted users, with an
   * optional case-insensitive `q` match on handle/display_name. Returns up to `limit` person views plus a
   * per-row `isFollowing` flag (relative to `viewerId`) and the next cursor (null when exhausted).
   */
  listPeople(args: {
    viewerId: string | null
    q: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  /**
   * Page the people who FOLLOW `id` (their followers), excluding soft-deleted users, ordered + cursored
   * identically to listPeople (the (display_name, id) keyset). Each row carries `isFollowing` relative to
   * `viewerId` so a Follow button renders the viewer's state. Returns up to `limit` rows + the next cursor.
   */
  listFollowers(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  /** Page the people `id` FOLLOWS (their following). Same shape/ordering/cursor as listFollowers. */
  listFollowing(args: {
    id: string
    viewerId: string | null
    cursor: string | null
    limit: number
  }): Promise<{ items: Array<PersonView & { isFollowing: boolean }>; nextCursor: string | null }>

  /** Load one person view by id (null when missing or soft-deleted). */
  findPersonById(id: string): Promise<PersonView | null>

  /**
   * Load one person view by @handle, case-insensitively (handle is citext), null when missing or
   * soft-deleted. Backs the /people/<handle> deep link: the route resolves a non-UUID :id param here.
   */
  findPersonByHandle(handle: string): Promise<PersonView | null>

  /** Whether `followerId` currently follows `followeeId`. */
  isFollowing(followerId: string, followeeId: string): Promise<boolean>

  /**
   * Insert a follows_people(follower, followee) row idempotently. Returns { created } where created is
   * true only when a NEW edge was inserted (false on an idempotent re-follow), so the caller fires the
   * new_follower notification exactly once. Returns { exists:false } when the followee does not exist.
   */
  addFollow(
    followerId: string,
    followeeId: string,
  ): Promise<{ exists: boolean; created: boolean }>

  /**
   * Delete a follows_people row. Returns whether the followee exists (so a missing target 404s); deleting
   * a non-existent edge on an existing user is an idempotent no-op that still returns exists:true.
   */
  removeFollow(followerId: string, followeeId: string): Promise<{ exists: boolean }>

  /** Current follower count for a user (how many people follow them). */
  followerCount(userId: string): Promise<number>

  /** The cleanups a user organized or attended, most recent first, capped at `limit`. */
  pastEventsFor(userId: string, limit: number): Promise<CleanupRecord[]>

  /** Aggregate {reports, cleanups-organized} counts for a profile. */
  statsFor(userId: string): Promise<ProfileStats>
}

/**
 * The minimal notifier surface the social service depends on. The notification service implements this
 * (its createNotification records a row and best-effort inline-sends a push). Declared structurally here so
 * the social service does not import the notification service's full type, and tests can pass a spy.
 */
export interface SocialNotifier {
  onNewFollower(args: {
    /** The user being followed (the notification recipient). */
    followeeId: string
    /** The user who followed them (drives the title/body/link). */
    follower: PersonView
  }): Promise<void>
}

/** A viewer context for read endpoints (a signed-in user, or anonymous). */
export interface SocialViewer {
  userId: string | null
}

export interface SocialServiceDeps {
  repo: SocialRepository
  /**
   * Optional notifier for the new_follower hook. When omitted (or when its call rejects) the follow still
   * succeeds: the notification is a best-effort side effect, never a precondition.
   */
  notifier?: SocialNotifier
  /**
   * Presign (or otherwise render) a user's avatar object key into a client-usable URL, wrapping the Storage
   * seam exactly like cleanup-service.presignThumb. OPTIONAL: when omitted (offline tests) it defaults to an
   * identity pass-through (returns the raw key), so a test still sees an avatar URL without a storage SDK.
   * Avatars are public, so this presigns the same way report media is served.
   */
  presignAvatar?: (avatarKey: string) => Promise<string>
  /** Optional logger for diagnostics (e.g. a new follow whose follower row vanished before the notify). */
  logger?: { warn(obj: unknown, msg: string): void }
}

export interface SocialService {
  listPeople(req: ListPeopleRequest, viewer: SocialViewer): Promise<ListPeopleResponse>
  /** The followers of a user (anon-ok), as a page of PersonDTO with the viewer's follow state. */
  listFollowers(
    id: string,
    viewer: SocialViewer,
    req: ConnectionsListQuery,
  ): Promise<ListPeopleResponse>
  /** The people a user follows (anon-ok), as a page of PersonDTO with the viewer's follow state. */
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
  getProfile(id: string, viewer: SocialViewer): Promise<{ profile: UserProfileDTO }>
  /** Same as getProfile but resolves the target by @handle (the /people/<handle> deep link). */
  getProfileByHandle(handle: string, viewer: SocialViewer): Promise<{ profile: UserProfileDTO }>
  getMyProfile(viewerId: string): Promise<{ profile: UserProfileDTO }>
}

/** Project a person view (+ resolved isFollowing) into the wire PersonDTO, deriving the avatar gradient. */
export function toPersonDTO(view: PersonView, isFollowing: boolean): PersonDTO {
  return {
    id: view.id,
    name: view.displayName,
    handle: view.handle,
    bio: view.bio,
    avatar: avatarGradient(view.id),
    // Surface the canonical avatar_url directly (no presign needed — it already holds the public URL set on
    // upload). Omitted when null so clients fall back to the monogram, matching the buildProfile shape.
    ...(view.avatarUrl !== null ? { avatarUrl: view.avatarUrl } : {}),
    followers: view.followers,
    following: view.following,
    isFollowing,
    verified: view.verified,
  }
}

export function makeSocialService(deps: SocialServiceDeps): SocialService {
  // Default to an identity pass-through (raw key) when no presigner is injected, so offline tests still see
  // the avatar key as a URL; production wires the real Storage presigner so the uploaded photo renders.
  const presignAvatar = deps.presignAvatar ?? ((avatarKey: string) => Promise.resolve(avatarKey))

  /** Resolve isFollowing for the viewer (false for anonymous viewers / self, cheaply). */
  async function viewerFollows(targetId: string, viewer: SocialViewer): Promise<boolean> {
    if (viewer.userId === null || viewer.userId === targetId) return false
    return deps.repo.isFollowing(viewer.userId, targetId)
  }

  // Build a page of PersonDTO for the followers/following lists (identical projection + cursor; only the
  // repo method differs).
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
    const { items, nextCursor } = await fn({
      id,
      viewerId: viewer.userId,
      cursor: req.cursor ?? null,
      limit: req.limit ?? PEOPLE_DEFAULT_LIMIT,
    })
    return { items: items.map((it) => toPersonDTO(it, it.isFollowing)), nextCursor }
  }

  /** Build the full UserProfileDTO for a person view. `isSelf` skips the isFollowing lookup (own profile). */
  async function buildProfile(
    view: PersonView,
    viewer: SocialViewer,
    isSelf: boolean,
  ): Promise<UserProfileDTO> {
    const [isFollowing, pastEventRecords, stats] = await Promise.all([
      isSelf ? Promise.resolve(false) : viewerFollows(view.id, viewer),
      deps.repo.pastEventsFor(view.id, PROFILE_PAST_EVENTS_LIMIT),
      deps.repo.statsFor(view.id),
    ])
    // pastEvents reuse the cleanups projection; `joined` here means "this profile's user attended", which
    // is true for every cleanup the query returns (they organized or were a member of each).
    const pastEvents: CleanupDTO[] = pastEventRecords.map((r) => toCleanupDTO(r, true))
    // When the user uploaded an avatar, presign its object key into a client-usable URL and surface it as
    // `avatarUrl` (avatars are public). Absent -> avatarUrl is omitted, so clients fall back to the
    // provider photo / monogram. This OVERRIDES any stored avatar_url with the uploaded photo.
    const avatarUrl =
      view.avatarR2Key !== null ? await presignAvatar(view.avatarR2Key) : undefined
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
      pastEvents,
      stats,
    }
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
      // Cannot follow yourself (a VALIDATION error, not a 404/409). Guard before any DB write.
      if (viewerId === targetId) {
        throw AppError.validation({ targetId: "You cannot follow yourself." })
      }
      const { exists, created } = await deps.repo.addFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound("Person not found")

      const followers = await deps.repo.followerCount(targetId)

      // Fire the new_follower notification only on a NEW edge (not an idempotent re-follow), and only when
      // a notifier is wired. Best-effort: a notifier rejection must never fail the follow.
      if (created && deps.notifier) {
        const follower = await deps.repo.findPersonById(viewerId)
        if (follower) {
          try {
            await deps.notifier.onNewFollower({ followeeId: targetId, follower })
          } catch {
            // Swallowed: the follow already succeeded; the notification is a side effect.
          }
        } else {
          // The follower row vanished between the write and the lookup — the follow stands, only the
          // notification is dropped. Log so the dropped new_follower bell is diagnosable.
          deps.logger?.warn({ viewerId, targetId }, "social: new follower row missing, notification skipped")
        }
      }

      return { isFollowing: true, followers }
    },

    async unfollowPerson(
      viewerId: string,
      targetId: string,
    ): Promise<{ isFollowing: boolean; followers: number }> {
      // Unfollowing yourself is a no-op-shaped VALIDATION (there is never a self-edge to remove).
      if (viewerId === targetId) {
        throw AppError.validation({ targetId: "You cannot unfollow yourself." })
      }
      const { exists } = await deps.repo.removeFollow(viewerId, targetId)
      if (!exists) throw AppError.notFound("Person not found")
      const followers = await deps.repo.followerCount(targetId)
      return { isFollowing: false, followers }
    },

    async getProfile(id: string, viewer: SocialViewer): Promise<{ profile: UserProfileDTO }> {
      const view = await deps.repo.findPersonById(id)
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await buildProfile(view, viewer, viewer.userId === id) }
    },

    async getProfileByHandle(
      handle: string,
      viewer: SocialViewer,
    ): Promise<{ profile: UserProfileDTO }> {
      const view = await deps.repo.findPersonByHandle(handle)
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await buildProfile(view, viewer, viewer.userId === view.id) }
    },

    async getMyProfile(viewerId: string): Promise<{ profile: UserProfileDTO }> {
      const view = await deps.repo.findPersonById(viewerId)
      // A signed-in user whose row vanished (soft-deleted mid-session) is treated as not found.
      if (!view) throw AppError.notFound("Person not found")
      return { profile: await buildProfile(view, { userId: viewerId }, true) }
    },
  }
}
