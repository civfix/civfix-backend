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

const FRAMING_LINE = "Reported by a resident via CivFix"

/**
 * What the city receives as the ticket (D3). The framing line is always there: city replies are matched
 * on it (D11), so its wording is part of the contract with every portal script and mail correlator.
 */
export function renderTicketText(input: TicketTextInput): string {
  const lines = [input.title]
  const description = input.description?.trim() ?? ""
  if (description !== "") lines.push(description)
  lines.push("")
  lines.push(
    input.referenceCode !== null && input.referenceCode !== ""
      ? `${FRAMING_LINE} · ref ${input.referenceCode}`
      : FRAMING_LINE,
  )
  if (input.includeLink && input.isPublic) lines.push(`${input.webBaseUrl}/pin/${input.reportId}`)
  const note = input.note?.trim() ?? ""
  if (note !== "") lines.push(`Note from CivFix: ${note}`)
  return lines.join("\n")
}
