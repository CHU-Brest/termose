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

// Convert a row to a plain object:
//  - BigInt (duckdb returns INTEGER/BIGINT as BigInt) -> Number (our ints are small)
//  - Arrow Vector (LIST columns like synonymes/exclusion_codes) -> plain JS array
function jsonRow(r) {
  const o = r.toJSON();
  for (const k in o) {
    const v = o[k];
    if (typeof v === "bigint") o[k] = Number(v);
    else if (v && typeof v === "object" && typeof v.toArray === "function") {
      o[k] = Array.from(v.toArray());
    }
  }
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

// Normalize like the build did for `keywords`: lowercase + strip accents.
const normQuery = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export async function search(table, query) {
  assertTable(table);
  const raw = (query || "").trim();
  if (!raw) return [];
  const words = normQuery(raw).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  // Each query word must match a `keywords` token by PREFIX (so "grip" -> "grippe").
  // `keywords` is space-joined normalized tokens: a word w matches if the string
  // starts with "w" or contains " w". BM25 score (whole-word) is kept only to
  // rank exact-term hits above prefix-only hits.
  const conds = [];
  const params = [];
  for (const w of words) {
    const e = w.replace(/[%_\\]/g, (c) => "\\" + c); // escape LIKE metachars
    conds.push("(keywords LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')");
    params.push(e + "%", "% " + e + "%");
  }

  return rows(
    `SELECT id, code, label, depth, lft, rgt, path, freq,
            fts_main_${table}.match_bm25(id, ?, conjunctive := 1) AS score
     FROM ${table}
     WHERE ${conds.join(" AND ")}
     ORDER BY score DESC NULLS LAST, freq DESC, length(label), code
     LIMIT 300`,
    [raw, ...params],
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
