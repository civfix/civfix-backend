/**
 * A scripted in-memory stand-in for the raw postgres-js `sql` tag (`db/client.ts` `Sql`).
 *
 * The inbound-processor's report side-effects (onJurisdictionReply) + bounce contact-flag, and the
 * discovery worker, talk to the DB through the HAND-WRITTEN raw-`sql` repositories rather than an
 * injectable seam — `makeDrizzleAdminReportRepository(container.getDb().sql)`,
 * `makeDrizzleDiscoveryRepository(sql)`, and a couple of inline `sql\`UPDATE …\``. To exercise those
 * paths OFFLINE (no Docker, no Postgres) we hand the container a `getDb().sql` that:
 *   - is a tagged template you can `await` (returns canned rows), and that you can also EMBED inside
 *     another `sql\`… ${fragment} …\`` (postgres-js composes fragments this way; the repo's
 *     `reportSelect` builds its WHERE/LIMIT as fragments) — composition just concatenates the raw SQL;
 *   - supports `sql.begin(async (tx) => …)` (the repo's setStatus/writeAudit run in one) by invoking the
 *     callback with the SAME tag and returning its result;
 *   - matches each awaited statement against a list of scripted handlers (by a RegExp over the raw SQL
 *     skeleton), returning the handler's rows and recording the bound values for assertions.
 *
 * This is deliberately a faithful emulation of ONLY the statement shapes those code paths issue (a report
 * SELECT, INSERT report_timeline, UPDATE reports, INSERT notifications, the bounce UPDATE/SELECT on
 * jurisdiction_contacts, the discovery EXISTS probe + INSERT…RETURNING, and audit_log inserts). It is not
 * a general SQL engine; an unmatched statement returns `[]` (and is still recorded) so a stray query never
 * throws. Keep the matchers in lockstep with the repos they stand in for.
 */

/** One recorded statement: the raw SQL skeleton (placeholders collapsed) + the bound values, in order. */
export interface RecordedStatement {
  sql: string
  values: unknown[]
}

/** A scripted response: when `match` hits the raw SQL, return `rows` (or compute them from the values). */
export interface SqlHandler {
  match: RegExp
  rows: unknown[] | ((values: unknown[]) => unknown[])
}

/** A composed fragment / awaitable statement node produced by the fake tag. */
interface SqlNode extends PromiseLike<unknown[]> {
  __isFakeSql: true
  /** The raw SQL skeleton with embedded fragments inlined (placeholders shown as `?`). */
  raw: string
  /** The bound values in left-to-right order (embedded fragments contribute theirs inline). */
  values: unknown[]
}

export interface FakeSql {
  /** The tagged-template entrypoint, callable as `` sql`…` ``. */
  (strings: TemplateStringsArray, ...values: unknown[]): SqlNode
  /** Run a "transaction": invoke `cb` with the same tag, return its result. No isolation is emulated. */
  begin<T>(cb: (tx: FakeSql) => Promise<T>): Promise<T>
  /** postgres-js's jsonb marker (writeAudit/recordEvent call `sql.json(obj)`); here it is identity. */
  json(value: unknown): unknown
}

export interface FakeSqlControl {
  sql: FakeSql
  /** Every statement that was actually awaited, in execution order. */
  readonly statements: RecordedStatement[]
  /** Add/replace scripted handlers after construction. */
  on(handler: SqlHandler): void
}

function isNode(v: unknown): v is SqlNode {
  return typeof v === "object" && v !== null && (v as { __isFakeSql?: boolean }).__isFakeSql === true
}

/**
 * Build a scripted fake `sql` tag + a control handle. `handlers` are tried in order; the first whose
 * `match` tests true against the composed raw SQL wins. Unmatched statements resolve to `[]`.
 */
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

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]): SqlNode => {
    // Compose the raw SQL skeleton: literal chunks verbatim, an embedded fragment inlined, any other
    // value collapsed to a `?` placeholder (and recorded as a bound value left-to-right).
    let raw = ""
    const bound: unknown[] = []
    for (let i = 0; i < strings.length; i++) {
      raw += strings[i] ?? ""
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
