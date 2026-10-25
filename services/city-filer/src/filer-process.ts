import type { spawn as nodeSpawn } from "node:child_process"

export interface FilerRunner {
  filerShell: string
  nodeBinary: string
  kitRunScript: string
  spawn?: typeof nodeSpawn
}
