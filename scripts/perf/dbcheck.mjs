// Ad-hoc DB inspector for the order write-path work (row counts / stock probing).
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
const raw = (text) => sql.query(text);
const cmd = process.argv[2] || "counts";

if (cmd === "counts") {
  const out = {};
  for (const t of ["User","Category","MenuItem","Order","OrderItem","CollectionWindow","OrderSequence","AuditLog"]) {
    try { out[t] = (await raw(`SELECT count(*)::int AS n FROM "${t}"`))[0].n; }
    catch (e) { out[t] = "ERR:" + String(e.message).slice(0,70); }
  }
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "sql") {
  console.log(JSON.stringify(await raw(process.argv[3]), null, 2));
}
