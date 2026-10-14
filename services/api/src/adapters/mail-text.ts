// A dependency-free leaf shared by the mail adapter, the outbound-mail service and the admin report-packet
// builder, so none of them needs a service->adapter (or adapter->service) import edge.

const HEADER_VALUE_MAX = 998 // RFC 5322 line-length ceiling

const FALLBACK_MAIL_DOMAIN = "civfix.org"

const HEADER_BREAKING_CHARS_RE = /[\r\n\0]/g

// `&` MUST be escaped first or the later entity ampersands get double-escaped.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Accepts the display-name form ("Name <local@domain>") used for the per-thread From, hence the trailing
// '>' trim. A caller that must not silently invent a domain (DKIM alignment) uses this nullable form.
export function domainOfOrNull(addr: string | null | undefined): string | null {
  if (!addr) return null
  const at = addr.lastIndexOf("@")
  if (at < 0) return null
  const domain = addr
    .slice(at + 1)
    .replace(/>.*$/, "")
    .trim()
    .toLowerCase()
  return domain.length > 0 ? domain : null
}

// For Message-ID hosts and operator copy only. Never use it for a comparison decision: the fallback would
// silently align an unparseable address with civfix.org.
export function domainOf(addr: string, fallback = FALLBACK_MAIL_DOMAIN): string {
  return domainOfOrNull(addr) ?? fallback
}

// An un-stripped newline in user-controlled header text lets an attacker inject extra headers or a body
// (SMTP header injection); this has bitten the OCI From/Reply-To path in prod. Not for envelope addresses,
// which must be REJECTED on a bad char rather than silently sanitized.
export function sanitizeHeaderValue(value: string, maxLength = HEADER_VALUE_MAX): string {
  const stripped = value.replace(HEADER_BREAKING_CHARS_RE, "")
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped
}
