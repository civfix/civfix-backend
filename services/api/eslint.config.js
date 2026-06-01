import { config } from "@civfix/config/eslint"

export default config({
  // Tests use vitest globals via explicit imports, so nothing extra is needed here yet.
  // Service-specific overrides can be appended as additional flat-config objects.
})
