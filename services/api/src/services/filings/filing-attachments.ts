import type { OutboundAttachment, Storage } from "@civfix/seams"
import type { AdminReportMediaRecord } from "../admin/admin-report-repository.js"
import type { ReportPacket } from "../admin/mail-format.js"
import { outboundPayloadBytes } from "../admin/outbound-mail-service.js"
import { OUTBOUND_PAYLOAD_BUDGET_BYTES } from "../admin/outbound-send-policy.js"

const EMAIL_PHOTOS_MAX = 5
const PHOTO_CONTENT_TYPE = "image/jpeg"

export interface FilingEmailContent {
  packet: ReportPacket
  attachments: OutboundAttachment[]
}

/**
 * The photos an email filing attaches (D3): ready images in report order, at most five, each kept only
 * while the whole encoded message still fits the outbound budget, so the send deadline and the route
 * in-flight window that budget sizes keep holding. A photo that would pass it, or whose object is gone,
 * stays a link.
 */
export async function pickFilingAttachments(input: {
  media: readonly AdminReportMediaRecord[]
  storage: Pick<Storage, "getObject">
  /** The packet with these media attached, so only the rest are links. */
  build: (attached: ReadonlySet<string>) => ReportPacket
}): Promise<FilingEmailContent> {
  const attached = new Set<string>()
  const attachments: OutboundAttachment[] = []
  const photos = input.media.filter((m) => m.kind === "image").slice(0, EMAIL_PHOTOS_MAX)
  for (const photo of photos) {
    const content = await input.storage.getObject(photo.r2Key)
    if (content === null) continue
    const candidate: OutboundAttachment = {
      filename: `photo-${attachments.length + 1}.jpg`,
      contentType: PHOTO_CONTENT_TYPE,
      content,
    }
    // Attaching only ever removes links, so a later, smaller packet stays inside the budget too.
    const packet = input.build(new Set(attached).add(photo.id))
    const bytes = outboundPayloadBytes({
      body: packet.text,
      html: packet.html,
      attachments: [...attachments, candidate],
    })
    if (bytes > OUTBOUND_PAYLOAD_BUDGET_BYTES) continue
    attached.add(photo.id)
    attachments.push(candidate)
  }
  return { packet: input.build(attached), attachments }
}
