export type FilerLog = (line: string, fields?: Record<string, unknown>) => void

export interface FilingContact {
  firstName: string
  lastName: string
  email: string
  phone: string | null
}

export interface FilerConfig {
  workspaceDir: string
  dryRun: boolean
  contact: FilingContact
  filerGid: number | null
  scriptTimeoutMs: number
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): FilerConfig {
  void source
  throw new Error("not implemented")
}
