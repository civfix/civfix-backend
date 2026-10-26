import type { JobHandler } from "@civfix/seams"

export function makeClassifyHandler(deps: unknown): JobHandler {
  void deps
  return () => Promise.reject(new Error("not implemented"))
}
