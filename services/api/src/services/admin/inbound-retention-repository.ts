export interface ReapedInboundEmail {
  id: string
  attachmentKeys: string[]
}

export interface InboundRetentionRepository {
  findArchivedBefore(input: { before: Date; limit: number }): Promise<ReapedInboundEmail[]>
  deleteByIds(ids: string[]): Promise<number>
}
