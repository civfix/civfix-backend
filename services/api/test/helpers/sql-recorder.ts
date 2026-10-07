import type { Sql } from "../../src/db/client.js"

// postgres.js cannot render SQL text without a live connection (`.describe()` round-trips to the server
// and the `debug` hook only sees executed queries), so this stands in for the client and renders every
// statement a repository executes into a canonical transcript. Two transcripts are byte-identical exactly
// when the same statements run with the same parameters, in the same order, inside the same transaction
// boundaries, which is what a behavior-neutral refactor of SQL placement has to preserve.

export interface ExecutedQuery {
  kind: "query" | "unsafe" | "cursor"
  text: string
  params: unknown[]
  scope: string | null
}

export type Response = readonly unknown[] | Error

export type Responder = (query: ExecutedQuery) => Response | undefined

export type TranscriptEntry =
  | { type: "query"; query: ExecutedQuery }
  | { type: "boundary"; label: string }

export interface SqlRecorder {
  sql: Sql
  readonly entries: readonly TranscriptEntry[]
  readonly queries: readonly ExecutedQuery[]
  enqueue(...responses: Response[]): void
  on(match: RegExp, response: Response | ((query: ExecutedQuery) => Response)): void
  transcript(): string
  reset(): void
}

export interface SqlRecorderOptions {
  respond?: Responder
}

interface Scope {
  label: string | null
}

interface RenderState {
  params: unknown[]
}

class Helper {
  constructor(readonly args: readonly unknown[]) {}
}

class Parameter {
  constructor(
    readonly kind: "json" | "array",
    readonly value: unknown,
  ) {}
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw)
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const UNDEFINED_MARKER = "\uE000undefined\uE000"

// Dates need no case of their own: JSON.stringify runs Date#toJSON before the replacer, so they arrive as
// ISO strings. `undefined` is kept visible because postgres.js rejects it as a parameter.
export function stableValue(value: unknown): string {
  const json = JSON.stringify(value, (_key, v: unknown) => {
    if (v === undefined) return UNDEFINED_MARKER
    if (typeof v === "bigint") return `${v.toString()}n`
    if (v instanceof Uint8Array) return `<bytes ${v.byteLength}>`
    if (v instanceof Set) return { "<set>": [...v] }
    if (v instanceof Map) return { "<map>": [...v.entries()] }
    if (v instanceof Parameter) return { [`<${v.kind}>`]: v.value }
    if (v instanceof Helper) return { "<helper>": v.args }
    return v
  })
  return (json ?? "undefined").replaceAll(`"${UNDEFINED_MARKER}"`, "undefined")
}

export function makeSqlRecorder(options: SqlRecorderOptions = {}): SqlRecorder {
  const entries: TranscriptEntry[] = []
  const queue: Response[] = []
  const matchers: { match: RegExp; response: Response | ((query: ExecutedQuery) => Response) }[] =
    []
  let txCounter = 0
  let reservedCounter = 0

  function respond(query: ExecutedQuery): Response {
    const fromOption = options.respond?.(query)
    if (fromOption !== undefined) return fromOption
    const queued = queue.shift()
    if (queued !== undefined) return queued
    for (const m of matchers) {
      if (m.match.test(query.text))
        return typeof m.response === "function" ? m.response(query) : m.response
    }
    return []
  }

  // count/command are non-enumerable so a scripted result still deep-equals the plain row array.
  function asResult(response: readonly unknown[], query: ExecutedQuery): unknown[] {
    const scripted = response as { count?: number; command?: string }
    return Object.defineProperties([...response], {
      count: { value: scripted.count ?? response.length },
      command: { value: scripted.command ?? query.text.split(" ")[0]?.toUpperCase() ?? "" },
    })
  }

  class Query implements PromiseLike<unknown[]> {
    private settled: Promise<unknown[]> | undefined

    constructor(
      readonly scope: Scope,
      readonly strings: readonly string[] | null,
      readonly values: readonly unknown[],
      readonly unsafeText: string | null,
    ) {}

    render(state: RenderState): string {
      if (this.unsafeText !== null) {
        const base = state.params.length
        state.params.push(...this.values)
        return this.unsafeText.replace(/\$(\d+)/g, (_all, n: string) => `$${base + Number(n)}`)
      }
      const strings = this.strings ?? []
      let out = strings[0] ?? ""
      for (let i = 0; i < this.values.length; i++) {
        out += renderValue(this.values[i], state) + (strings[i + 1] ?? "")
      }
      return out
    }

    private executed(kind: ExecutedQuery["kind"]): ExecutedQuery {
      const state: RenderState = { params: [] }
      const text = normalize(this.render(state))
      const query: ExecutedQuery = {
        kind: this.unsafeText !== null && kind === "query" ? "unsafe" : kind,
        text,
        params: state.params,
        scope: this.scope.label,
      }
      entries.push({ type: "query", query })
      return query
    }

    private run(): Promise<unknown[]> {
      if (this.settled) return this.settled
      const query = this.executed("query")
      const response = respond(query)
      this.settled =
        response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve(asResult(response, query))
      return this.settled
    }

    then<A = unknown[], B = never>(
      onFulfilled?: ((value: unknown[]) => A | PromiseLike<A>) | null,
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
      return this.run().then(onFulfilled, onRejected)
    }

    catch<B = never>(
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): Promise<unknown[] | B> {
      return this.run().catch(onRejected)
    }

    finally(onFinally?: (() => void) | null): Promise<unknown[]> {
      return this.run().finally(onFinally)
    }

    execute(): this {
      // A rejection surfaces when the caller awaits the query; this only keeps the eager start from
      // becoming an unhandled rejection in the meantime.
      void this.run().catch(() => undefined)
      return this
    }

    simple(): this {
      return this
    }

    cursor(batch = 1): AsyncIterable<unknown[]> {
      const query = this.executed("cursor")
      const response = respond(query)
      return {
        async *[Symbol.asyncIterator]() {
          if (response instanceof Error) throw response
          for (let i = 0; i < response.length; i += batch) yield response.slice(i, i + batch)
        },
      }
    }
  }

  function renderValue(value: unknown, state: RenderState): string {
    if (value instanceof Query) return value.render(state)
    if (value instanceof Helper) return `<helper ${stableValue(value.args)}>`
    state.params.push(value)
    return `$${state.params.length}`
  }

  function makeTag(scope: Scope, extra: Record<string, unknown> = {}): Sql {
    function tag(first: unknown, ...rest: unknown[]): unknown {
      if (isTemplateStrings(first)) return new Query(scope, [...first], rest, null)
      return new Helper([first, ...rest])
    }

    const api: Record<string, unknown> = {
      json: (value: unknown) => new Parameter("json", value),
      array: (value: unknown) => new Parameter("array", value),
      unsafe: (text: string, params: readonly unknown[] = []) =>
        new Query(scope, null, params, text),
      begin: async (modeOrFn: string | ((tx: Sql) => unknown), maybeFn?: (tx: Sql) => unknown) => {
        const fn = typeof modeOrFn === "function" ? modeOrFn : maybeFn
        const mode = typeof modeOrFn === "string" ? ` ${normalize(modeOrFn)}` : ""
        if (!fn) throw new Error("sql-recorder: begin() without a callback")
        const label = `${scope.label ? `${scope.label}.` : ""}tx${++txCounter}`
        return transaction(
          `BEGIN ${label}${mode}`,
          `COMMIT ${label}`,
          `ROLLBACK ${label}`,
          label,
          fn,
        )
      },
      savepoint: async (
        nameOrFn: string | ((tx: Sql) => unknown),
        maybeFn?: (tx: Sql) => unknown,
      ) => {
        const fn = typeof nameOrFn === "function" ? nameOrFn : maybeFn
        if (!fn) throw new Error("sql-recorder: savepoint() without a callback")
        const label = `${scope.label ?? "root"}.sp${++txCounter}`
        return transaction(
          `SAVEPOINT ${label}`,
          `RELEASE ${label}`,
          `ROLLBACK TO ${label}`,
          label,
          fn,
        )
      },
      reserve: async () => {
        const label = `reserved${++reservedCounter}`
        entries.push({ type: "boundary", label: `RESERVE ${label}` })
        return makeTag(
          { label },
          {
            release: () => {
              entries.push({ type: "boundary", label: `RELEASE ${label}` })
            },
          },
        )
      },
      end: async () => undefined,
      ...extra,
    }

    return new Proxy(tag, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in api) return api[prop]
        if (typeof prop === "symbol" || prop === "then" || prop in Function.prototype) {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error(
          `sql-recorder: unsupported postgres.js API "sql.${prop}"; add it to test/helpers/sql-recorder.ts`,
        )
      },
    }) as unknown as Sql
  }

  async function transaction(
    open: string,
    commit: string,
    rollback: string,
    label: string,
    fn: (tx: Sql) => unknown,
  ): Promise<unknown> {
    entries.push({ type: "boundary", label: open })
    try {
      const result = await fn(makeTag({ label }))
      const settled = Array.isArray(result) ? await Promise.all(result) : result
      entries.push({ type: "boundary", label: commit })
      return settled
    } catch (err) {
      entries.push({ type: "boundary", label: rollback })
      throw err
    }
  }

  return {
    sql: makeTag({ label: null }),
    get entries() {
      return entries
    },
    get queries() {
      return entries.flatMap((e) => (e.type === "query" ? [e.query] : []))
    },
    enqueue(...responses: Response[]) {
      queue.push(...responses)
    },
    on(match, response) {
      matchers.push({ match, response })
    },
    transcript() {
      return entries
        .map((e) => {
          if (e.type === "boundary") return e.label
          const q = e.query
          const scope = q.scope ? `[${q.scope}] ` : ""
          const kind = q.kind === "query" ? "" : `${q.kind.toUpperCase()} `
          return `${scope}${kind}${q.text} -- ${stableValue(q.params)}`
        })
        .join("\n")
    },
    reset() {
      entries.length = 0
      queue.length = 0
      txCounter = 0
      reservedCounter = 0
    },
  }
}
