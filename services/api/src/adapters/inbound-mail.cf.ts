/**
 * REAL InboundMail adapter for the Cloudflare Email Routing webhook (Phase 3 reply-by-email).
 *
 * SCAFFOLD: bodies throw until a later step implements RFC822 parsing + thread-token extraction.
 *
 * Seam rule: any MIME-parsing vendor SDK may ONLY be imported in this file.
 */

import { AppError } from "@civfix/shared"
import type { InboundMail, ParsedMail } from "@civfix/shared/interfaces"

export interface CfInboundMailConfig {
  /** Shared secret used to authenticate the Cloudflare webhook (CF_EMAIL_WEBHOOK_SECRET). */
  webhookSecret?: string
}

const NOT_IMPL = "adapter not implemented: inbound-mail.cf"

export class CfInboundMail implements InboundMail {
  private readonly config: CfInboundMailConfig

  constructor(config: CfInboundMailConfig = {}) {
    this.config = config
  }

  parse(_raw: Uint8Array): Promise<ParsedMail> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  extractThreadToken(_mail: ParsedMail): string | null {
    throw AppError.internal(NOT_IMPL)
  }
}
