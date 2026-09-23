import { config, typed } from "@civfix/config/eslint"

export default config(
  typed({
    // scripts/ are tsx-run ops tools outside tsconfig.json's include; they lint against its
    // compiler options instead of widening what `tsc --noEmit` checks.
    projectService: { allowDefaultProject: ["scripts/*.ts"] },
    tsconfigRootDir: import.meta.dirname,
  }),
)
