// Vendor-neutral text utilities shared by the mail adapter (mailer.oci.ts), the outbound-mail service,
// and the admin report-packet builder. It lives under adapters/ rather than in any one consumer so a
// service can import it without a service->adapter (or adapter->service) edge — there is no clean
// "owner" of these helpers, so they sit in a dependency-free leaf module.

const HEADER_VALUE_MAX = 998 // RFC 5322 line-length ceiling; a header value can't safely exceed it.

// The five HTML-significant characters, for the plain-text -> minimal-HTML body fallback. Order matters:
// `&` MUST be escaped first or the later entity ampersands get double-escaped.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// The domain of an email address, falling back when absent/empty. Accepts a bare address OR a
// display-name form ("Name <local@domain>") — the latter is the per-thread From we now send, so a
// trailing '>' is trimmed off the extracted domain.
export function domainOf(addr: string, fallback = "civfix.org"): string {
  const at = addr.lastIndexOf("@")
  const domain = at >= 0 ? addr.slice(at + 1).replace(/>.*$/, "").trim() : ""
  return domain.length > 0 ? domain : fallback
}

// Strip CR/LF (and NUL) then clamp, before interpolating user-controlled text into an email header
// (subject/From/Reply-To/etc.). An un-stripped newline lets an attacker inject extra headers or a body
// (SMTP header injection) — this has bitten the OCI From/Reply-To path in prod. NOT for envelope
// addresses, which should be REJECTED on a bad char rather than silently sanitized.
export function sanitizeHeaderValue(value: string, maxLength = HEADER_VALUE_MAX): string {
  const stripped = value.replace(/[\r\n\0]/g, "")
  return stripped.length > maxLength ? stripped.slice(0, maxLength) : stripped
}
