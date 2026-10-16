import type { UserSearchResultDTO } from "@civfix/contract"

export interface UserSearchRepository {
  searchByHandlePrefix(q: string, viewerId: string, limit: number): Promise<UserSearchResultDTO[]>
  searchMentionable(q: string, viewerId: string, limit: number): Promise<UserSearchResultDTO[]>
}
