import { config, typed } from "@civfix/config/eslint"

export default config(typed({ projectService: true, tsconfigRootDir: import.meta.dirname }))
