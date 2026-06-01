/**
 * Service version string, surfaced by /healthz. Kept as a single constant rather than importing
 * package.json so the build does not depend on JSON module resolution and the value is stable in
 * both ESM dist and tests. Bump alongside package.json on release.
 */
export const SERVICE_NAME = "civfix-api"
export const SERVICE_VERSION = "0.0.0"
