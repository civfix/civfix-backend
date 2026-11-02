import * as Sentry from "@sentry/node"
import type { ErrorReportingOptions } from "../../src/errors/glitchtip.js"

type EnvelopeItem = [{ type: string }, unknown]
type Envelope = [Record<string, unknown>, EnvelopeItem[]]

export const FAKE_GLITCHTIP_DSN = "https://public@glitchtip.invalid/1"

export interface RecordingTransport {
  transport: NonNullable<ErrorReportingOptions["transport"]>
  envelopes: unknown[]
  items(type: string): unknown[]
  serialized(): string
  clear(): void
}

/** A Sentry transport that records every envelope it is handed and sends nothing. */
export function recordingTransport(): RecordingTransport {
  const envelopes: unknown[] = []
  const transport = () => ({
    send: (envelope: unknown) => {
      envelopes.push(envelope)
      return Promise.resolve({})
    },
    flush: () => Promise.resolve(true),
  })
  return {
    transport,
    envelopes,
    items: (type) =>
      envelopes.flatMap((e) =>
        (e as Envelope)[1].filter(([header]) => header.type === type).map(([, payload]) => payload),
      ),
    serialized: () => JSON.stringify(envelopes),
    clear: () => {
      envelopes.length = 0
    },
  }
}

/** D12's dataCollection, as the T1 and T9 test cases spell it out. */
export const D12_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
}

/** The live client's options as a plain record, so a test can look for keys the SDK's type doesn't name. */
export function sentryClientOptions(): Record<string, unknown> | undefined {
  return Sentry.getClient()?.getOptions() as unknown as Record<string, unknown> | undefined
}
