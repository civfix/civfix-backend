import { config, typed } from "@civfix/config/eslint"

// The type-aware rules hold the whole src + test + scripts program, which outgrows Node's default
// heap, so the lint script spreads files over worker threads (--concurrency=4) and raises the heap
// limit through node itself rather than NODE_OPTIONS, which a Windows shell cannot set inline.
export default config(typed({ projectService: true, tsconfigRootDir: import.meta.dirname }))
