import { describe, expect, it } from "vitest";
import { joinSql, query, raw, sql } from "../../src/db/sql.js";
import type { QueryRunner } from "../../src/db/sql.js";

describe("sql tagged template", () => {
  it("builds positional placeholders in order", () => {
    const frag = sql`SELECT * FROM "User" WHERE id = ${"u1"} AND role = ${"STUDENT"}`;
    expect(frag.text).toBe('SELECT * FROM "User" WHERE id = $1 AND role = $2');
    expect(frag.values).toEqual(["u1", "STUDENT"]);
  });

  it("splices a nested fragment and renumbers its placeholders", () => {
    const inner = sql`"role" = ${"ADMIN"}`;
    const outer = sql`SELECT * FROM "User" WHERE ${inner} AND "isActive" = ${true}`;
    expect(outer.text).toBe('SELECT * FROM "User" WHERE "role" = $1 AND "isActive" = $2');
    expect(outer.values).toEqual(["ADMIN", true]);
  });

  it("renumbers correctly when the nested fragment itself has multiple params", () => {
    const inner = sql`"a" = ${1} AND "b" = ${2}`;
    const outer = sql`WHERE ${"prefix" as any} ${inner} AND "c" = ${3}`;
    // first expr is a plain value ($1), then the 2-param fragment ($2,$3), then a plain value ($4)
    expect(outer.text).toBe('WHERE $1 "a" = $2 AND "b" = $3 AND "c" = $4');
    expect(outer.values).toEqual(["prefix", 1, 2, 3]);
  });

  it("joinSql builds a VALUES list with correctly numbered params", () => {
    const claims = [
      { id: "m1", qty: 2 },
      { id: "m2", qty: 5 },
    ];
    const values = joinSql(claims.map((c) => sql`(${c.id}::text, ${c.qty}::int)`));
    const full = sql`UPDATE "MenuItem" m SET "reservedQty" = m."reservedQty" + r.qty FROM (VALUES ${values}) AS r(id, qty) WHERE m.id = r.id`;
    expect(full.text).toBe(
      'UPDATE "MenuItem" m SET "reservedQty" = m."reservedQty" + r.qty FROM (VALUES ($1::text, $2::int), ($3::text, $4::int)) AS r(id, qty) WHERE m.id = r.id',
    );
    expect(full.values).toEqual(["m1", 2, "m2", 5]);
  });

  it("joinSql on an empty list produces an empty fragment", () => {
    expect(joinSql([])).toEqual({ text: "", values: [] });
  });

  it("raw() splices literal text with no placeholder", () => {
    const frag = sql`SELECT 1 ${raw("-- trusted comment")}`;
    expect(frag.text).toBe("SELECT 1 -- trusted comment");
    expect(frag.values).toEqual([]);
  });

  it("query() runs a fragment against a node-pg-shaped runner", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    // A mock runner necessarily returns one concrete row shape regardless of
    // the caller's requested T, which is exactly what QueryRunner's generic
    // `query<T>` signature cannot express for a fixed implementation — hence
    // the cast, rather than a T-parameterized runner that would defeat the
    // point of testing query() against a fixed, known result.
    const runner = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [{ id: "x" }], rowCount: 1 };
      },
    } as unknown as QueryRunner;
    const result = await query<{ id: string }>(runner, sql`SELECT * FROM "User" WHERE id = ${"x"}`);
    expect(result.rows).toEqual([{ id: "x" }]);
    expect(result.rowCount).toBe(1);
    expect(calls).toEqual([{ text: 'SELECT * FROM "User" WHERE id = $1', values: ["x"] }]);
  });

  it("query() normalizes a null rowCount to 0", async () => {
    const runner = { query: async () => ({ rows: [], rowCount: null }) };
    const result = await query(runner, sql`SELECT 1`);
    expect(result.rowCount).toBe(0);
  });
});
