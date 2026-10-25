export interface TicketTextInput {
  reportId: string
  title: string
  description: string | null
  referenceCode: string | null
  /** `isPubliclyVisibleStatus(status) && visibility === "public"`. */
  isPublic: boolean
  /** The matched route's `includeLink`; an implicit email route counts as true. */
  includeLink: boolean
  note: string | null
  webBaseUrl: string
}

export function renderTicketText(_input: TicketTextInput): string {
  throw new Error("not implemented")
}
