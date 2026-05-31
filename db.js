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

  // Open the prebuilt DB as the MAIN catalog (read-only) rather than ATTACHing
  // it: the persisted match_bm25 macro calls its sibling FTS helpers (tokenize,
  // stem) unqualified, which only resolve when fts_main_<table> lives in the
  // main catalog. Under an attached catalog those calls fail.
  await db.open({ path: DB_FILE, accessMode: duckdb.DuckDBAccessMode.READ_ONLY });
  const conn = await db.connect();
  await conn.query("LOAD fts");
  return conn;
}

// Convert a row to a plain object, coercing BigInt (duckdb returns INTEGER/BIGINT
// as BigInt) to Number — all our integer columns are small and safe.
function jsonRow(r) {
  const o = r.toJSON();
  for (const k in o) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
  return o;
}

// Run a query and return an array of plain JS objects.
async function rows(sql, params) {
  const stmt = await _conn.prepare(sql);
  const result = params && params.length ? await stmt.query(...params) : await stmt.query();
  await stmt.close();
  return result.toArray().map(jsonRow);
}

export async function init() {
  if (_conn) return;
  _conn = await bootConnection();
}

export async function listTerminologies() {
  const r = await rows(
    "SELECT table_name, version, source_file FROM meta ORDER BY table_name",
  );
  _tables = new Set(r.map((t) => t.table_name));
  return r;
}

// Throws if `table` is not a known terminology (defense-in-depth for interpolation).
function assertTable(table) {
  if (!_tables || !_tables.has(table)) throw new Error(`Terminologie inconnue: ${table}`);
}

export async function roots(table) {
  assertTable(table);
  return rows(
    `SELECT id, code, label, depth, lft, rgt, path, freq
     FROM ${table} WHERE depth = 0 ORDER BY lft`,
  );
}

export async function children(table, path, depth) {
  assertTable(table);
  return rows(
    `SELECT id, code, label, depth, lft, rgt, path, freq
     FROM ${table} WHERE path LIKE ? AND depth = ? ORDER BY lft`,
    [path + "/%", Number(depth) + 1],
  );
}

export async function search(table, query) {
  assertTable(table);
  const q = (query || "").trim();
  if (!q) return [];
  return rows(
    `SELECT id, code, label, depth, lft, rgt, path, freq,
            fts_main_${table}.match_bm25(id, ?, conjunctive := 1) AS score
     FROM ${table}
     WHERE score IS NOT NULL
     ORDER BY score DESC, freq DESC
     LIMIT 300`,
    [q],
  );
}

// Full row (all columns) for the concept panel; keyed by the integer id. null if missing.
export async function concept(table, id) {
  assertTable(table);
  const r = await rows(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return r[0] || null;
}

// Ancestor chain (root -> parent), ordered, for the breadcrumb. Uses nested set.
// Returns id too so crumbs navigate by the unique identifier.
export async function ancestors(table, lft, rgt) {
  assertTable(table);
  return rows(
    `SELECT id, code, label, depth, path FROM ${table}
     WHERE lft < ? AND rgt > ? ORDER BY lft`,
    [lft, rgt],
  );
}

// Column names of a terminology table, in declared order (drives the generic
// Concept attribute list). Excludes the common columns the shared UI renders.
const COMMON = new Set(["id", "code", "label", "depth", "lft", "rgt", "path", "keywords", "freq"]);
export async function extraColumns(table) {
  assertTable(table);
  const cols = await rows(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'main' AND table_name = ?
     ORDER BY ordinal_position`,
    [table],
  );
  return cols.map((c) => c.column_name).filter((c) => !COMMON.has(c));
}

export { rows as _rows, assertTable as _assertTable }; // used by helpers in Task 4
