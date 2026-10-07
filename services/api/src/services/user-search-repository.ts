import type { UserSearchResultDTO } from "@civfix/shared"

export interface UserSearchRepository {
  searchByHandlePrefix(q: string, viewerId: string, limit: number): Promise<UserSearchResultDTO[]>
  searchMentionable(q: string, viewerId: string, limit: number): Promise<UserSearchResultDTO[]>
}
