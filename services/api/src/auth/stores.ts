
import { randomUUID } from "node:crypto"
import { AppError, DELETED_USER_LABEL } from "@civfix/shared"
import type { Role, SocialLinks } from "@civfix/shared"
import { decideHandleWrite, handleChanged } from "./handle-policy.js"

export const HANDLE_RENAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

export function handleChangeableAtFrom(handleChangedAt: Date | null, now: Date): string | null {
  if (handleChangedAt === null) return null
  const next = new Date(handleChangedAt.getTime() + HANDLE_RENAME_COOLDOWN_MS)
  return next.getTime() > now.getTime() ? next.toISOString() : null
}

export function generatePlaceholderHandle(id?: string): string {
  const hex = (id ?? randomUUID()).replace(/-/g, "").slice(0, 12).toLowerCase()
  return `user${hex}`
}

export interface SessionRecord {
  id: string
  userId: string
  roles: Role[]
  createdAt: Date
  expiresAt: Date
  lastSeenAt: Date
  userAgent: string | null
  ip: string | null
}

export interface SessionInsert {
  id: string
  userId: string
  roles: Role[]
  expiresAt: Date
  lastSeenAt: Date
  userAgent: string | null
  ip: string | null
}

export interface SessionStore {
  insert(row: SessionInsert): Promise<void>
  findById(hash: string): Promise<SessionRecord | null>
  updateExpiry(hash: string, expiresAt: Date, lastSeen: Date): Promise<void>
  deleteById(hash: string): Promise<void>
  deleteAllForUser(userId: string): Promise<string[]>
}

export class InMemorySessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRecord>()

  insert(row: SessionInsert): Promise<void> {
    this.rows.set(row.id, {
      ...row,
      roles: [...row.roles],
      createdAt: new Date(row.lastSeenAt),
    })
    return Promise.resolve()
  }

  findById(hash: string): Promise<SessionRecord | null> {
    const row = this.rows.get(hash)
    return Promise.resolve(row ? { ...row, roles: [...row.roles] } : null)
  }

  updateExpiry(hash: string, expiresAt: Date, lastSeen: Date): Promise<void> {
    const row = this.rows.get(hash)
    if (row) {
      row.expiresAt = expiresAt
      row.lastSeenAt = lastSeen
    }
    return Promise.resolve()
  }

  deleteById(hash: string): Promise<void> {
    this.rows.delete(hash)
    return Promise.resolve()
  }

  deleteAllForUser(userId: string): Promise<string[]> {
    const deleted: string[] = []
    for (const [id, row] of this.rows) {
      if (row.userId === userId) {
        this.rows.delete(id)
        deleted.push(id)
      }
    }
    return Promise.resolve(deleted)
  }

  count(): number {
    return this.rows.size
  }
}

export interface UserRecord {
  id: string
  role: Role
  displayName: string
  handle: string | null
  handleChangedAt: Date | null
  email: string | null
  emailVerified: boolean
  avatarUrl: string | null
  profileComplete: boolean
  allowDirectMessages: boolean
  /**
   * P6 hours privacy — a NULLABLE TRI-STATE mirroring `users.show_volunteer_hours`
   * (0061_users_show_volunteer_hours.sql), NOT a plain boolean:
   *   null  = never chosen (every account that predates the column) -> the aggregate hours stay
   *           visible exactly as they were, and `UserDTO.showVolunteerHours` is OMITTED
   *   true  = explicit opt-in    false = explicit opt-out
   * The WRITE is always an explicit boolean (see UpdateSettingsInput); only the stored value is nullable.
   */
  showVolunteerHours: boolean | null
  locale: string
  createdAt: Date
  deletedAt: Date | null
}

export interface CreateUserInput {
  displayName: string
  role?: Role
  emailVerified?: boolean
  avatarUrl?: string | null
  handle?: string
  profileComplete?: boolean
}

export interface UpdateProfileInput {
  handle: string
  displayName: string
  bio?: string | null
  avatarUploadId?: string
  presignAvatar?: (avatarKey: string) => Promise<string>
  socialLinks?: SocialLinks | null
}

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>
  findByEmail(email: string): Promise<UserRecord | null>
  findByHandle(handle: string): Promise<UserRecord | null>
  create(email: string | null, input: CreateUserInput): Promise<UserRecord>
  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord>
  setRole(id: string, role: Role): Promise<UserRecord>
  updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord>
  softDeleteAndAnonymize(id: string): Promise<UserRecord>
}

export interface UpdateSettingsInput {
  allowDirectMessages?: boolean
  locale?: string
  /**
   * Omitted = no change (the stored value keeps whatever it is, including "never chosen"). A PRESENT
   * value is always an explicit boolean: the tri-state's null arm is only ever reached by never having
   * written the column, never by writing one.
   */
  showVolunteerHours?: boolean
}

export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>()
  private readonly now: () => Date

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date())
  }

  findById(id: string): Promise<UserRecord | null> {
    const row = this.byId.get(id)
    return Promise.resolve(row ? { ...row } : null)
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase()
    for (const row of this.byId.values()) {
      if (row.email !== null && row.email.toLowerCase() === normalized) {
        return Promise.resolve({ ...row })
      }
    }
    return Promise.resolve(null)
  }

  create(email: string | null, input: CreateUserInput): Promise<UserRecord> {
    if (email !== null) {
      const normalized = email.toLowerCase()
      for (const existing of this.byId.values()) {
        if (existing.email !== null && existing.email.toLowerCase() === normalized) {
          return Promise.resolve({ ...existing })
        }
      }
    }
    const id = randomUUID()
    const row: UserRecord = {
      id,
      role: input.role ?? "citizen",
      displayName: input.displayName,
      handle: input.handle ?? generatePlaceholderHandle(id),
      handleChangedAt: null,
      email: email === null ? null : email.toLowerCase(),
      emailVerified: email !== null && (input.emailVerified ?? false),
      avatarUrl: input.avatarUrl ?? null,
      profileComplete: input.profileComplete ?? false,
      allowDirectMessages: true,
      // NULL, not true: a new account has NEVER CHOSEN. The column has no DB default for the same
      // reason (0061) — "never chosen" is a distinct state from "opted in".
      showVolunteerHours: null,
      locale: "en",
      createdAt: new Date(),
      deletedAt: null,
    }
    this.byId.set(row.id, row)
    return Promise.resolve({ ...row })
  }

  findByHandle(handle: string): Promise<UserRecord | null> {
    const normalized = handle.toLowerCase()
    for (const row of this.byId.values()) {
      if (row.handle !== null && row.handle.toLowerCase() === normalized) {
        return Promise.resolve({ ...row })
      }
    }
    return Promise.resolve(null)
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw AppError.notFound("User not found.")

    let handle = row.handle
    let handleChangedAt = row.handleChangedAt
    if (handleChanged(row.handle, input.handle)) {
      const taken = await this.findByHandle(input.handle)
      const decided = decideHandleWrite({
        current: row.handle,
        submitted: input.handle,
        profileComplete: row.profileComplete,
        handleChangedAt: row.handleChangedAt,
        isTaken: taken !== null && taken.id !== id,
        now: this.now(),
      })
      handle = decided.handle
      handleChangedAt = decided.handleChangedAt
    }

    const next: UserRecord = {
      ...row,
      handle,
      handleChangedAt,
      displayName: input.displayName,
      profileComplete: true,
    }
    this.byId.set(id, next)
    return { ...next }
  }

  setRole(id: string, role: Role): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.setRole: user not found")
    const next: UserRecord = { ...row, role }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  updateSettings(id: string, input: UpdateSettingsInput): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.updateSettings: user not found")
    const next: UserRecord = {
      ...row,
      ...(input.allowDirectMessages !== undefined
        ? { allowDirectMessages: input.allowDirectMessages }
        : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.showVolunteerHours !== undefined
        ? { showVolunteerHours: input.showVolunteerHours }
        : {}),
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  softDeleteAndAnonymize(id: string): Promise<UserRecord> {
    const row = this.byId.get(id)
    if (!row) throw new Error("InMemoryUserStore.softDeleteAndAnonymize: user not found")
    const next: UserRecord = {
      ...row,
      deletedAt: row.deletedAt ?? new Date(),
      allowDirectMessages: false,
      email: null,
      emailVerified: false,
      displayName: DELETED_USER_LABEL,
      handle: generatePlaceholderHandle(id),
      avatarUrl: null,
    }
    this.byId.set(id, next)
    return Promise.resolve({ ...next })
  }

  seed(_email: string | null, row: UserRecord): void {
    this.byId.set(row.id, { ...row })
  }
}

export interface OAuthIdentityRecord {
  id: string
  userId: string
  provider: string
  providerUserId: string
}

export interface OAuthIdentityStore {
  findByProvider(provider: string, providerUserId: string): Promise<OAuthIdentityRecord | null>
  linkIdentity(userId: string, provider: string, providerUserId: string): Promise<void>
  /** Drop every identity linked to a user (account deletion). Idempotent. */
  deleteAllForUser(userId: string): Promise<void>
}

export class InMemoryOAuthIdentityStore implements OAuthIdentityStore {
  private readonly identities = new Map<string, OAuthIdentityRecord>()

  private key(provider: string, providerUserId: string): string {
    return `${provider}:${providerUserId}`
  }

  findByProvider(provider: string, providerUserId: string): Promise<OAuthIdentityRecord | null> {
    const row = this.identities.get(this.key(provider, providerUserId))
    return Promise.resolve(row ? { ...row } : null)
  }

  linkIdentity(userId: string, provider: string, providerUserId: string): Promise<void> {
    const k = this.key(provider, providerUserId)
    this.identities.set(k, { id: randomUUID(), userId, provider, providerUserId })
    return Promise.resolve()
  }

  deleteAllForUser(userId: string): Promise<void> {
    for (const [k, row] of this.identities) {
      if (row.userId === userId) this.identities.delete(k)
    }
    return Promise.resolve()
  }
}

export interface OtpRecord {
  id: string
  email: string
  codeHash: string
  expiresAt: Date
  attempts: number
  consumedAt: Date | null
  createdAt: Date
}

export interface OtpInsert {
  email: string
  codeHash: string
  expiresAt: Date
}

export interface OtpStore {
  invalidateActiveForEmail(email: string): Promise<void>
  insert(row: OtpInsert): Promise<OtpRecord>
  findLatestActive(email: string, now: Date): Promise<OtpRecord | null>
  incrementAttempts(id: string): Promise<number>
  /**
   * Consume a code, returning whether THIS call is the one that consumed it. The write is CONDITIONAL on
   * the row still being unconsumed so "single-use" holds under racing, not merely in its absence: two
   * concurrent verifies of the same correct code both clear the attempt ceiling, so the claim is what
   * decides which one may mint a session.
   */
  markConsumed(id: string, at: Date): Promise<boolean>
}

export class InMemoryOtpStore implements OtpStore {
  private readonly rows: OtpRecord[] = []

  invalidateActiveForEmail(email: string): Promise<void> {
    const now = new Date()
    for (const row of this.rows) {
      if (row.email.toLowerCase() === email.toLowerCase() && row.consumedAt === null) {
        row.consumedAt = now
      }
    }
    return Promise.resolve()
  }

  insert(row: OtpInsert): Promise<OtpRecord> {
    const record: OtpRecord = {
      id: randomUUID(),
      email: row.email,
      codeHash: row.codeHash,
      expiresAt: row.expiresAt,
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    }
    this.rows.push(record)
    return Promise.resolve({ ...record })
  }

  findLatestActive(email: string, now: Date): Promise<OtpRecord | null> {
    let best: OtpRecord | null = null
    for (const row of this.rows) {
      if (row.email.toLowerCase() !== email.toLowerCase()) continue
      if (row.consumedAt !== null) continue
      if (row.expiresAt.getTime() <= now.getTime()) continue
      if (!best || row.createdAt.getTime() > best.createdAt.getTime()) best = row
    }
    return Promise.resolve(best ? { ...best } : null)
  }

  incrementAttempts(id: string): Promise<number> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return Promise.resolve(0)
    row.attempts += 1
    return Promise.resolve(row.attempts)
  }

  markConsumed(id: string, at: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.consumedAt !== null) return Promise.resolve(false)
    row.consumedAt = at
    return Promise.resolve(true)
  }

  all(): readonly OtpRecord[] {
    return this.rows
  }
}

export interface AuthStores {
  sessions: SessionStore
  users: UserStore
  oauth: OAuthIdentityStore
  otps: OtpStore
}

export function makeInMemoryStores(): AuthStores & {
  users: InMemoryUserStore
  sessions: InMemorySessionStore
  oauth: InMemoryOAuthIdentityStore
  otps: InMemoryOtpStore
} {
  return {
    users: new InMemoryUserStore(),
    sessions: new InMemorySessionStore(),
    oauth: new InMemoryOAuthIdentityStore(),
    otps: new InMemoryOtpStore(),
  }
}
