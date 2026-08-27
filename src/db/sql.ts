/**
 * Minimal tagged-template SQL builder, replacing Prisma's `$queryRaw`/
 * `$executeRaw`/`Prisma.sql`/`Prisma.join`. Produces positional-param
 * queries ($1, $2, ...) consumable by @neondatabase/serverless's
 * `Pool`/`PoolClient`/`Client`, whose `.query(text, values)` follows the
 * same convention as node-postgres.
 */

export interface SqlFragment {
  text: string;
  values: unknown[];
}

function isFragment(x: unknown): x is SqlFragment {
  return typeof x === "object" && x !== null && "text" in x && "values" in x;
}

/**
 * sql`SELECT * FROM "User" WHERE id = ${id}` -> { text: '...$1', values: [id] }
 *
 * An interpolated SqlFragment is spliced in place rather than becoming a
 * placeholder itself — its own placeholders are renumbered to continue the
 * outer fragment's sequence. This is what lets fragments compose (see
 * joinSql below), the same way Prisma.sql/Prisma.join compose today.
 */
export function sql(strings: TemplateStringsArray, ...exprs: unknown[]): SqlFragment {
  let text = strings[0];
  const values: unknown[] = [];
  for (let i = 0; i < exprs.length; i++) {
    const e = exprs[i];
    if (isFragment(e)) {
      const offset = values.length;
      text += e.text.replace(/\$(\d+)/g, (_, n) => `$${offset + Number(n)}`);
      values.push(...e.values);
    } else {
      values.push(e);
      text += `$${values.length}`;
    }
    text += strings[i + 1];
  }
  return { text, values };
}

/** Prisma.join equivalent — comma-joins fragments, e.g. for a VALUES list. */
export function joinSql(fragments: SqlFragment[], separator = ", "): SqlFragment {
  if (fragments.length === 0) return { text: "", values: [] };
  return fragments.reduce((acc, f) => sql`${acc}${raw(separator)}${f}`);
}

/**
 * Escape hatch for literal SQL text that must NOT become a placeholder (e.g.
 * a separator passed to joinSql). Never pass user input here — it is spliced
 * into the query text verbatim, unparameterized.
 */
export function raw(text: string): SqlFragment {
  return { text, values: [] };
}

export interface QueryRunner {
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export async function query<T = any>(
  runner: QueryRunner,
  frag: SqlFragment,
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await runner.query<T>(frag.text, frag.values);
  return { rows: res.rows, rowCount: res.rowCount ?? 0 };
}
