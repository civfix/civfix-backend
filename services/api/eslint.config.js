import { config, typed } from "@civfix/config/eslint"

// The type-aware rules hold the whole src + test + scripts program in every worker thread
// (--concurrency=4), close to Node's default heap on smaller machines, so the lint script raises the
// heap limit through node itself rather than NODE_OPTIONS, which a Windows shell cannot set inline.
export default config(typed({ projectService: true, tsconfigRootDir: import.meta.dirname }))
