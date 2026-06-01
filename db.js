// db.js — DuckDB-WASM data layer. DOM-free. Only file that contains SQL.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
import { DB_PATH, dbExists, clearStoredDb, getStoredVersion } from "./storage.js";

// On the `license` branch the DB is not shipped: it is built in the browser
// (build.js) and persisted in OPFS (storage.js). Re-exported so the view layer
// can offer a "regenerate" action without importing storage.js directly.
export { clearStoredDb, getStoredVersion };

let _conn = null; // DuckDB-WASM connection, set by init()
let _db = null; // owning AsyncDuckDB (kept so reset() can release the OPFS handle)

// Validated lazily from meta; guards table-name interpolation in SQL.
let _tables = null;

// Boot a DuckDB-WASM instance (worker + module). Stateless and shared with
// build.js, which needs the same runtime to construct the database.
export async function bootDuckDB() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles); // picks a COOP/COEP-free bundle when needed
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return db;
}

async function bootConnection() {
  // The DB lives in OPFS (built once via build.js). When absent we throw a typed
  // error so the view layer can prompt the user to generate it.
  if (!(await dbExists())) {
    throw Object.assign(new Error("Base non générée"), { code: "DB_MISSING" });
  }

  const db = await bootDuckDB();
  // Open the OPFS-backed DB as the MAIN catalog (read-only). The persisted
  // match_bm25 macro calls its sibling FTS helpers (tokenize, stem) unqualified,
  // which only resolve when fts_main_<table> lives in the main catalog.
  await db.open({ path: DB_PATH, accessMode: duckdb.DuckDBAccessMode.READ_ONLY });
  const conn = await db.connect();
  await conn.query("LOAD fts");
  _db = db;
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

// Tear down the current connection AND its worker so the OPFS file handle is
// released. Must be awaited before (re)building, since OPFS access is exclusive;
// the next init() then re-opens the freshly built DB.
export async function reset() {
  _conn = null;
  _tables = null;
  if (_db) {
    try { await _db.terminate(); } catch { /* already gone */ }
    _db = null;
  }
}

export async function listTerminologies() {
  const r = await rows(
    "SELECT table_name, version, source_file, source, url, license FROM meta ORDER BY table_name",
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

// Build the WHERE clause requiring each query word to PREFIX-match a `keywords`
// token (so "grip" -> "grippe"). `keywords` is space-joined normalized tokens:
// word w matches if the string starts with "w" or contains " w".
// Returns { clause, params } or null when the query has no usable words.
function prefixConds(query) {
  const words = normQuery((query || "").trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const conds = [];
  const params = [];
  for (const w of words) {
    const e = w.replace(/[%_\\]/g, (c) => "\\" + c); // escape LIKE metachars
    conds.push("(keywords LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')");
    params.push(e + "%", "% " + e + "%");
  }
  return { clause: conds.join(" AND "), params };
}

const FUZZY_THRESHOLD = 0.88; // jaro-winkler floor for a token typo to count as a match
const FUZZY_MIN_HITS = 5; // run the fuzzy fallback only when the exact pass is this sparse

// Query words eligible for fuzzy matching: alphabetic and >= 4 chars. Codes (digits)
// and short words are excluded — the exact/prefix pass handles them well, and fuzzing
// them is noisy (e.g. "I33" ~ "I44").
function fuzzyWords(query) {
  return normQuery((query || "").trim())
    .split(/\s+/)
    .filter((w) => w.length >= 4 && /^[a-z]+$/.test(w));
}

// Matched concepts for a query. Fast path: the exact/prefix pass (BM25-ranked).
// Fallback (only when that pass is sparse): a per-token jaro-winkler pass catches
// typos. Returns display-column rows — the exact block keeps its order, fuzzy-only
// hits append after it.
async function matchedRows(table, query) {
  const pc = prefixConds(query);
  if (!pc) return [];
  const exact = await rows(
    `SELECT id, code, label, depth, lft, rgt, path, freq,
            fts_main_${table}.match_bm25(id, ?, conjunctive := 1) AS score
     FROM ${table}
     WHERE ${pc.clause}
     ORDER BY score DESC NULLS LAST, freq DESC, length(label), code
     LIMIT 300`,
    [query.trim(), ...pc.params],
  );
  if (exact.length >= FUZZY_MIN_HITS) return exact;

  const words = fuzzyWords(query);
  if (!words.length) return exact;

  // One jaro-winkler similarity per query word (best-matching token), computed once
  // per row in the CTE, then filtered/scored — avoids recomputing in WHERE + ORDER.
  const sims = words.map(
    (_, i) =>
      `list_aggregate(list_transform(string_split(keywords, ' '), ` +
      `t -> jaro_winkler_similarity(t, ?)), 'max') AS s${i}`,
  );
  const where = words.map((_, i) => `s${i} >= ${FUZZY_THRESHOLD}`).join(" AND ");
  const score = words.map((_, i) => `s${i}`).join(" + ");
  const fuzzy = await rows(
    `WITH s AS (
       SELECT id, code, label, depth, lft, rgt, path, freq, ${sims.join(", ")}
       FROM ${table}
     )
     SELECT id, code, label, depth, lft, rgt, path, freq, (${score}) AS score
     FROM s
     WHERE ${where}
     ORDER BY score DESC, freq DESC, length(label), code
     LIMIT 300`,
    words,
  );
  const seen = new Set(exact.map((r) => r.id));
  return exact.concat(fuzzy.filter((r) => !seen.has(r.id))).slice(0, 300);
}

// Single entry point for search mode: the flat result list AND the pruned
// ancestor-or-self tree, derived from ONE matched set so the two views stay
// consistent (and the fuzzy fallback is never computed twice). `is_match` flags the
// matched concepts; tree rows are lft-ordered (pre-order) for rebuilding into a tree.
export async function searchBoth(table, query) {
  assertTable(table);
  const matched = await matchedRows(table, query);
  if (!matched.length) return { list: [], tree: [] };

  const ids = new Set(matched.map((r) => r.id));
  const pairs = matched.map(() => "(CAST(? AS BIGINT), CAST(? AS BIGINT))").join(", ");
  const params = matched.flatMap((r) => [r.lft, r.rgt]);
  const tree = await rows(
    `WITH m(lft, rgt) AS (VALUES ${pairs})
     SELECT t.id, t.code, t.label, t.depth, t.lft, t.rgt, t.path, t.freq
     FROM ${table} t
     WHERE EXISTS (SELECT 1 FROM m WHERE t.lft <= m.lft AND t.rgt >= m.rgt)
     ORDER BY t.lft`,
    params,
  );
  tree.forEach((n) => { n.is_match = ids.has(n.id); });
  return { list: matched, tree };
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

// All DISTINCT immediate parents of a CODE. The source is a DAG flattened into a
// tree, so the same code can appear under several parents (e.g. adicap) — list
// them all. The parent is the node whose path is this node's path minus its last
// segment. Roots (depth 0) have no parent.
export async function parents(table, code) {
  assertTable(table);
  return rows(
    `SELECT DISTINCT p.id, p.code, p.label, p.depth, p.path
     FROM ${table} c
     JOIN ${table} p ON p.path = regexp_replace(c.path, '/[^/]*$', '')
     WHERE c.code = ? AND c.depth > 0
     ORDER BY p.depth, p.label`,
    [code],
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
