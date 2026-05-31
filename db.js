// db.js — DuckDB-WASM data layer. DOM-free. Only file that contains SQL.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

const DB_FILE = "termose.duckdb";
const DB_URL = "database/termose.duckdb";

let _conn = null; // DuckDB-WASM connection, set by init()

// Validated lazily from meta; guards table-name interpolation in SQL.
let _tables = null;

async function bootConnection() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles); // picks a COOP/COEP-free bundle when needed
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const res = await fetch(DB_URL);
  if (!res.ok) throw new Error(`Téléchargement de ${DB_URL} échoué (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await db.registerFileBuffer(DB_FILE, buf);

  const conn = await db.connect();
  await conn.query("LOAD fts");
  await conn.query(`ATTACH '${DB_FILE}' AS termose (READ_ONLY)`);
  return conn;
}

// Run a query and return an array of plain JS objects.
async function rows(sql, params) {
  const stmt = await _conn.prepare(sql);
  const result = params && params.length ? await stmt.query(...params) : await stmt.query();
  await stmt.close();
  return result.toArray().map((r) => r.toJSON());
}

export async function init() {
  if (_conn) return;
  _conn = await bootConnection();
}

export async function listTerminologies() {
  const r = await rows(
    "SELECT table_name, version, source_file FROM termose.meta ORDER BY table_name",
  );
  _tables = new Set(r.map((t) => t.table_name));
  return r;
}

// Throws if `table` is not a known terminology (defense-in-depth for interpolation).
function assertTable(table) {
  if (!_tables || !_tables.has(table)) throw new Error(`Terminologie inconnue: ${table}`);
}

export { rows as _rows, assertTable as _assertTable }; // used by helpers in Task 4
