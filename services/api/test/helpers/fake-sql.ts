export interface RecordedStatement {
  sql: string
  values: unknown[]
}

export interface SqlHandler {
  match: RegExp
  rows: unknown[] | ((values: unknown[]) => unknown[])
}

interface SqlNode extends PromiseLike<unknown[]> {
  __isFakeSql: true
  raw: string
  values: unknown[]
}

export interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlNode
  (values: readonly unknown[]): SqlNode
  begin<T>(cb: (tx: FakeSql) => Promise<T>): Promise<T>
  json(value: unknown): unknown
}

export interface FakeSqlControl {
  sql: FakeSql
  readonly statements: RecordedStatement[]
  on(handler: SqlHandler): void
}

function isNode(v: unknown): v is SqlNode {
  return (
    typeof v === "object" && v !== null && (v as { __isFakeSql?: boolean }).__isFakeSql === true
  )
}

export function makeFakeSql(handlers: SqlHandler[] = []): FakeSqlControl {
  const statements: RecordedStatement[] = []
  const script = [...handlers]

  function run(node: SqlNode): Promise<unknown[]> {
    statements.push({ sql: node.raw, values: node.values })
    for (const h of script) {
      if (h.match.test(node.raw)) {
        const rows = typeof h.rows === "function" ? h.rows(node.values) : h.rows
        return Promise.resolve(rows)
      }
    }
    return Promise.resolve([])
  }

  const tag = ((
    strings: TemplateStringsArray | readonly unknown[],
    ...values: unknown[]
  ): SqlNode => {
    if (!Array.isArray((strings as TemplateStringsArray).raw)) {
      const helper = strings as unknown
      const isList = Array.isArray(helper)
      const raw = isList
        ? `(${(helper as readonly unknown[]).map(() => "?").join(",")})`
        : String(helper)
      const helperNode: SqlNode = {
        __isFakeSql: true,
        raw,
        values: isList ? [...(helper as readonly unknown[])] : [],
        then(onFulfilled, onRejected) {
          return run(helperNode).then(onFulfilled, onRejected)
        },
      }
      return helperNode
    }
    const parts = strings as TemplateStringsArray
    let raw = ""
    const bound: unknown[] = []
    for (let i = 0; i < parts.length; i++) {
      raw += parts[i] ?? ""
      if (i < values.length) {
        const v = values[i]
        if (isNode(v)) {
          raw += v.raw
          bound.push(...v.values)
        } else {
          raw += "?"
          bound.push(v)
        }
      }
    }
    const node: SqlNode = {
      __isFakeSql: true,
      raw,
      values: bound,
      then(onFulfilled, onRejected) {
        return run(node).then(onFulfilled, onRejected)
      },
    }
    return node
  }) as FakeSql

  tag.begin = <T>(cb: (tx: FakeSql) => Promise<T>): Promise<T> => Promise.resolve(cb(tag))
  tag.json = (value: unknown): unknown => value

  return {
    sql: tag,
    statements,
    on(handler: SqlHandler) {
      script.push(handler)
    },
  }
}
