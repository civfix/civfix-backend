/**
 * The reserved email domain that marks seeded demo accounts (see seed-demo-la.ts). Guard-free module
 * (no run-as-main CLI guard) so BOTH demo CLIs can import it: tsup (splitting: false) inlines imports
 * into each bundled entry, and importing a file that carries a runIfMain guard would fire that guard
 * inside the importing bundle at boot (see the tsup.config.ts header for the precedent).
 *
 * A real person can never sign up with this domain, so it is safe to key purges and lookups on it.
 */
export const DEMO_EMAIL_DOMAIN = "demo-seed.civfix.org"
