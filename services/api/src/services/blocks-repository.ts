import type { PersonDTO } from "@civfix/shared"

export interface ListBlockedArgs {
  cursor?: string | null
  limit?: number
}

export interface ListBlockedPage {
  blocked: PersonDTO[]
  nextCursor: string | null
}

export interface BlockState {
  blockedByViewer: boolean
  blockedByTarget: boolean
}

export interface BlocksRepository {
  block(blockerId: string, blockedId: string): Promise<void>
  unblock(blockerId: string, blockedId: string): Promise<void>
  isBlockedEitherWay(a: string, b: string): Promise<boolean>
  blockState(viewerId: string, targetId: string): Promise<BlockState>
  blockedIdsAmong?(actorId: string, candidateIds: string[]): Promise<Set<string>>
  listBlocked(blockerId: string, args?: ListBlockedArgs): Promise<ListBlockedPage>
}
