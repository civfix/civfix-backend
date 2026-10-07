import type {
  ModerationDestinationKind,
  ModerationKind,
  ModerationSignal,
  ModerationSimilar,
  ModerationSubjectType,
  Priority,
  ReportCategory,
} from "@civfix/shared"

export type ModerationFilter = "all" | ModerationKind | "high"

export interface ListModerationArgs {
  q: string | null
  filter: ModerationFilter
  cursor: string | null
  limit: number
}

export interface ModerationUserSnapshot {
  id: string | null
  handle: string
  name: string
  joined: string
  priorReports: number
  priorRemovals: number
  strikes: number
  device: string
}

export interface ModerationMediaRecord {
  id: string
  kind: "image" | "video"
  r2Key: string
  thumbKey: string | null
}

export interface ModerationItemRecord {
  id: string
  kind: ModerationKind
  subjectType: ModerationSubjectType
  subjectId: string
  destinationKind: ModerationDestinationKind | null
  destinationId: string | null
  flag: string | null
  reason: string | null
  category: ReportCategory | null
  place: string | null
  priority: Priority
  autoAction: string | null
  reporter: string | null
  reporterId: string | null
  desc: string | null
  status: "open" | "approved" | "removed" | "held"
  signals: ModerationSignal[]
  similar: ModerationSimilar[]
  user: ModerationUserSnapshot | null
  media: ModerationMediaRecord[]
  createdAt: Date
  reportTimelineStatus?: "published" | "rejected"
  restoredUserId?: string
  suspendedUserId?: string
}

export interface CreateModerationItemInput {
  kind: ModerationKind
  subjectType: ModerationSubjectType
  subjectId: string
  flag?: string | null
  reason?: string | null
  category?: ReportCategory | null
  place?: string | null
  priority?: Priority
  autoAction?: string | null
  reporter?: string | null
  reporterUserId?: string | null
  desc?: string | null
  signals?: ModerationSignal[]
  similar?: ModerationSimilar[]
  user?: ModerationUserSnapshot | null
  dedupeOpen?: boolean
}

export interface ModerationRepository {
  listOpen(
    args: ListModerationArgs,
  ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }>
  getItem(id: string): Promise<ModerationItemRecord | null>
  approve(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  remove(
    id: string,
    input: { actorId: string | null; reason: string | null },
  ): Promise<ModerationItemRecord | null>
  hold(
    id: string,
    input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  decideAppeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null>
  createItem(input: CreateModerationItemInput): Promise<string | null>
  backfillFromHeldReports(): Promise<number>
}
