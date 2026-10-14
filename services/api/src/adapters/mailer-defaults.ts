// A leaf module so env/core-env can share the default without importing mailer.oci, which pulls the
// native argon2 binding in through auth/otp.
export const OCI_MAILER_DEFAULT_TIMEOUT_MS = 15_000
