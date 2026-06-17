/**
 * Social service: the people-directory / follow-graph / public-profile half of the social domain.
 *
 * All DB access sits behind a SocialRepository seam (Drizzle impl in social-repository.drizzle.ts; an
 * in-memory impl in the offline tests), mirroring the reports/cleanups pattern so the service is
 * unit-testable with no database and no Docker.
 *
 * FOLLOW + new_follower HOOK (plan section 14): followPerson is idempotent (re-following is a no-op) and
 * cannot target yourself (a VALIDATION error). On a NEW follow only (not an idempotent replay) the service
 * fires a `new_follower` notification to the followed user via the injected Notifier. The Notifier call is
 * best-effort and never blocks/breaks the follow (the notification-service already swallows push failures;
 * the recording of the row is awaited so the follow + notification stay consistent in the happy path, but
 * a notifier rejection is caught here so a follow still succeeds).
 *
 * AVATAR GRADIENT: avatarGradient(seed) is a PURE function that maps a stable hash of the seed (a user id
 * or handle) to two distinct colors drawn from the brand palette scales (bloom/moss/sun/sky/lilac). It is
 * deterministic (same seed -> same pair) so a person renders the same gradient on the list card, the
 * profile header, and inside a CleanupDTO.organizer. Unit-tested for determinism + palette membership.
 *
 * PROFILE: getProfile assembles a UserProfileDTO with followers/following counts, isFollowing (relative to
 * the viewer), pastEvents (cleanups the user organized or attended, most recent first, projected as the
 * shared CleanupDTO), and stats {reports, cleanups}. pastEvents reuses the same CleanupRecord -> CleanupDTO
 * projection as the cleanups domain so the shapes never drift.
 */

import { AppError, avatarGradient } from "@civfix/shared"
import type {
  CleanupDTO,
  ListPeopleRequest,
  ListPeopleResponse,
  PersonDTO,
  UserProfileDTO,
} from "@civfix/shared"
import { toCleanupDTO, type CleanupRecord } from "./cleanup-service.js"

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Default page size for listPeople when the request omits `limit`. Matches the shared cap of 50. */
export const PEOPLE_DEFAULT_LIMIT = 20

/** Max past-events surfaced on a profile. Bounds the payload; recent-first so the newest are kept. */
export const PROFILE_PAST_EVENTS_LIMIT = 20

// ---------------------------------------------------------------------------
// Avatar gradient
// ---------------------------------------------------------------------------
// The deterministic initials-avatar gradient (AVATAR_PALETTE / stableHash / avatarGradient) now lives in
// @civfix/shared as the single source of truth (palette derived from tokens.color.brand). The shared
// algorithm is byte-identical to the one that previously lived here, so PersonDTO.avatar /
// UserProfileDTO.avatar are unchanged; the organizer and chat avatars now derive from this SAME function,
// so a person renders one consistent gradient across the people list, their profile, a CleanupDTO
// organizer, and the chat. avatarGradient is imported above.

// ---------------------------------------------------------------------------
// Repository seam (structural views; faked in tests)
// ---------------------------------------------------------------------------

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

  /** Load one person view by id (null when missing or soft-deleted). */
  findPersonById(id: string): Promise<PersonView | null>

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

// ---------------------------------------------------------------------------
// Notifier seam (the new_follower hook; implemented by the notification service)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
}

export interface SocialService {
  listPeople(req: ListPeopleRequest, viewer: SocialViewer): Promise<ListPeopleResponse>
  followPerson(
    viewerId: string,
    targetId: string,
  ): Promise<{ isFollowing: boolean; followers: number }>
  unfollowPerson(
    viewerId: string,
    targetId: string,
  ): Promise<{ isFollowing: boolean; followers: number }>
  getProfile(id: string, viewer: SocialViewer): Promise<{ profile: UserProfileDTO }>
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
    followers: view.followers,
    following: view.following,
    isFollowing,
    verified: view.verified,
  }
}

export function makeSocialService(deps: SocialServiceDeps): SocialService {
  /** Resolve isFollowing for the viewer (false for anonymous viewers / self, cheaply). */
  async function viewerFollows(targetId: string, viewer: SocialViewer): Promise<boolean> {
    if (viewer.userId === null || viewer.userId === targetId) return false
    return deps.repo.isFollowing(viewer.userId, targetId)
  }

  /** Build the full UserProfileDTO for a person view + viewer. Shared by getProfile/getMyProfile. */
  async function buildProfile(
    view: PersonView,
    viewer: SocialViewer,
  ): Promise<UserProfileDTO> {
    const [isFollowing, pastEventRecords, stats] = await Promise.all([
      viewerFollows(view.id, viewer),
      deps.repo.pastEventsFor(view.id, PROFILE_PAST_EVENTS_LIMIT),
      deps.repo.statsFor(view.id),
    ])
    // pastEvents reuse the cleanups projection; `joined` here means "this profile's user attended", which
    // is true for every cleanup the query returns (they organized or were a member of each).
    const pastEvents: CleanupDTO[] = pastEventRecords.map((r) => toCleanupDTO(r, true))
    return {
      id: view.id,
      name: view.displayName,
      handle: view.handle,
      bio: view.bio,
      avatar: avatarGradient(view.id),
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
      return { profile: await buildProfile(view, viewer) }
    },

    async getMyProfile(viewerId: string): Promise<{ profile: UserProfileDTO }> {
      const view = await deps.repo.findPersonById(viewerId)
      // A signed-in user whose row vanished (soft-deleted mid-session) is treated as not found.
      if (!view) throw AppError.notFound("Person not found")
      // The viewer is themselves; isFollowing is meaningless (false) for one's own profile.
      return { profile: await buildProfile(view, { userId: null }) }
    },
  }
}
