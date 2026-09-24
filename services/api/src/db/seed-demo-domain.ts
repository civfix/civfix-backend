/**
 * Guard-free module (no runIfMain) so both demo CLIs can import it: tsup (splitting: false) inlines
 * imports into each bundled entry, and an imported runIfMain guard would fire inside the importing bundle.
 *
 * A real person can never sign up with this domain, so it is safe to key purges and lookups on it.
 */
export const DEMO_EMAIL_DOMAIN = "demo-seed.civfix.org"

export const DEMO_EMAIL_PATTERN = `%@${DEMO_EMAIL_DOMAIN}`
