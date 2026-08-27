import type { SqlFragment } from "./sql.js";

/**
 * Dynamic WHERE-clause construction, replacing Prisma's object-based
 * filters (`Prisma.UserWhereInput` etc.). Clauses are added in whatever
 * order the caller likes and AND-ed together; `andIf` skips a clause
 * entirely when its value is undefined/null, which is the common "optional
 * filter" case Prisma's spread-in-where-object pattern used to cover.
 */
export class WhereBuilder {
  private clauses: string[] = [];
  private values: unknown[] = [];

  and(clauseTemplate: string, ...values: unknown[]): this {
    const offset = this.values.length;
    const shifted = clauseTemplate.replace(/\$(\d+)/g, (_, n) => `$${offset + Number(n)}`);
    this.clauses.push(shifted);
    this.values.push(...values);
    return this;
  }

  andIf(value: unknown, clauseTemplate: string, ...values: unknown[]): this {
    if (value === undefined || value === null) return this;
    return this.and(clauseTemplate, ...(values.length ? values : [value]));
  }

  build(): SqlFragment {
    return { text: this.clauses.length ? this.clauses.join(" AND ") : "TRUE", values: this.values };
  }
}
