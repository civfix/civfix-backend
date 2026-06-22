/**
 * Service version string, surfaced by /healthz and used as the GlitchTip `release`. Kept here rather
 * than imported from package.json so the build does not depend on JSON module resolution and the value
 * is stable in both ESM dist and tests.
 *
 * The deploy injects the real build identity via SERVICE_VERSION (GIT_SHA / image tag) so releases are
 * distinguishable in /healthz + error reports; the "0.0.0" fallback is the local/dev placeholder. Read
 * directly from process.env (not the validated env loader) so this module has no env-load dependency.
 */
export const SERVICE_NAME = "civfix-api"
export const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.0.0"
