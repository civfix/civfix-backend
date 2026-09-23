/**
 * The deploy injects the build identity (git sha / image tag) as SERVICE_VERSION for the GlitchTip
 * `release`. Not read from package.json so the build needs no JSON module resolution, and read from
 * process.env directly so this module has no env-load dependency.
 */
export const SERVICE_NAME = "civfix-api"
export const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.0.0"
