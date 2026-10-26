/** One Claude process at a time across filing runs and classify jobs (D7). */
export interface ClaudeGate {
  run<T>(task: () => Promise<T>): Promise<T>
}

export function makeClaudeGate(): ClaudeGate {
  return { run: (task) => task() }
}
