import { config, typed } from "@civfix/config/eslint"

// The type-aware rules hold the whole src + test program, and one process linting every file outgrows
// Node's default heap, so the lint script spreads files over worker threads (--concurrency=4), each
// with its own heap.
export default config(
  typed({
    // scripts/ are tsx-run ops tools outside tsconfig.json's include; they lint against its
    // compiler options instead of widening what `tsc --noEmit` checks.
    projectService: { allowDefaultProject: ["scripts/*.ts"] },
    tsconfigRootDir: import.meta.dirname,
  }),
)
