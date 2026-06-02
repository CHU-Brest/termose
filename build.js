// build.js — client-side generation of the DuckDB database.
//
// For licensing reasons the database (a derivative of licensed terminologies) is
// not shipped. Instead it is built in the browser from the official parquets
// published on data.gouv.fr, then persisted in IndexedDB (storage.js) so it is
// only generated once. This is a 1:1 port of database/build_db.py onto the
// DuckDB-WASM runtime already used by db.js (no Python / PyScript).
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
import { bootDuckDB } from "./db.js";
import { DB_PATH, clearStoredDb, setStoredVersion } from "./storage.js";

// Stable data.gouv permalinks (the timestamped static.data.gouv.fr URLs rotate on
// every update; these /datasets/r/<id> permalinks 302-redirect to the latest and
// carry CORS, including on the redirect).
// `url` is the data.gouv download permalink; `source`/`sourceUrl`/`license`
// describe attribution and licensing (shown in the dialog's licence step before
// the build, and re-read authoritatively from each parquet's KV metadata at
// build time). Exported so app.js renders the licence view from the same source.
export const TERMINOLOGIES = [
  {
    name: "atc", version: "2026-02",
    url: "https://www.data.gouv.fr/api/1/datasets/r/f448aade-a175-4217-9665-b0ac4c0d68bd",
    source: "ATC", sourceUrl: "https://smt.esante.gouv.fr/terminologie-atc/",
    license: "CC BY-ND 3.0 IGO",
  },
  {
    name: "cim10", version: "2025-01-01",
    url: "https://www.data.gouv.fr/api/1/datasets/r/f0163d08-c682-4920-9409-363bca1415fe",
    source: "CIM-10 FR PMSI", sourceUrl: "https://smt.esante.gouv.fr/terminologie-cim-10/",
    license: "CC BY-NC-ND 3.0 IGO",
  },
  {
    name: "ccam", version: "v82.00",
    url: "https://www.data.gouv.fr/api/1/datasets/r/3da4b518-3791-4ee5-a397-5017669ca95a",
    source: "CCAM", sourceUrl: "https://smt.esante.gouv.fr/terminologie-ccam/",
    license: "LOv2",
  },
  {
    name: "adicap", version: "2024-10",
    url: "https://www.data.gouv.fr/api/1/datasets/r/848d3868-e0ff-4c46-b9bf-2fcbe261348f",
    source: "ADICAP", sourceUrl: "https://smt.esante.gouv.fr/terminologie-adicap/",
    license: "LOv2",
  },
];

// Bumped when the build schema/logic changes in a way that requires a rebuild
// (e.g. freq → concept_count + freq_abs/freq_rel). Cosmetic code changes do NOT bump
// it — the ?v= cache-bust already refreshes the JS/CSS without a rebuild.
const SCHEMA_VERSION = "2";
// Fingerprint stored alongside the DB so a stale local DB (data OR schema change) can
// be detected. Exported so the view layer can compare it to the stored version.
export const DB_VERSION =
  `s${SCHEMA_VERSION}|` + TERMINOLOGIES.map((t) => `${t.name}@${t.version}`).join("|");

const NAME_RE = /^[a-z][a-z0-9_]*$/; // guards table-name interpolation (cf. build_db.py)

// Fetch a parquet, streaming progress via onProgress({phase:'download', ...}).
async function downloadParquet(t, onProgress) {
  const res = await fetch(t.url);
  if (!res.ok) throw new Error(`Téléchargement de ${t.name} échoué (HTTP ${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ phase: "download", file: t.name, loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}

// KV metadata of a parquet → {source, url, license, ...}. Values come back as
// BLOBs (Uint8Array), so decode them like build_db.py:parquet_meta does.
async function parquetKv(conn, file) {
  const stmt = await conn.prepare("SELECT key, value FROM parquet_kv_metadata(?)");
  const res = await stmt.query(file);
  await stmt.close();
  const dec = new TextDecoder();
  const out = {};
  for (const row of res.toArray()) {
    const o = row.toJSON();
    const k = o.key instanceof Uint8Array ? dec.decode(o.key) : String(o.key);
    const v = o.value instanceof Uint8Array ? dec.decode(o.value) : o.value == null ? "" : String(o.value);
    out[k] = v;
  }
  return out;
}

// Column names of a parquet (via DESCRIBE — avoids parquet_schema's nested rows).
async function parquetColumns(conn, file) {
  const res = await conn.query(`DESCRIBE SELECT * FROM read_parquet('${file}')`);
  return res.toArray().map((r) => String(r.toJSON().column_name));
}

// Generate the database in the browser and persist it to OPFS.
// opts.onProgress({phase}) reports 'download' (per file) → 'transform' → 'done',
// plus human-readable {phase:'log', message} events for the dialog's log console.
// opts.freqFile (optional File/ArrayBuffer): a parquet with columns
// `terminologie; code; concept_count` — raw usage counts on the leaf codes, from
// which the per-node concept_count / freq_abs / freq_rel columns are derived (step 3).
export async function generateDatabase({ onProgress = () => {}, freqFile } = {}) {
  const log = (message) => onProgress({ phase: "log", message });

  // 1. Download the source parquets (with progress).
  const parquets = {};
  for (const t of TERMINOLOGIES) {
    parquets[t.name] = await downloadParquet(t, onProgress);
  }
  log(`${TERMINOLOGIES.length} terminologies téléchargées (${TERMINOLOGIES.map((t) => t.name).join(", ")}).`);
  const freqBytes = freqFile
    ? new Uint8Array(freqFile instanceof ArrayBuffer ? freqFile : await freqFile.arrayBuffer())
    : null;

  // 2. Build (port of build_db.py) directly into the OPFS-backed database.
  onProgress({ phase: "transform" });
  log("Construction de la base dans le navigateur…");
  await clearStoredDb(); // start from a clean file (idempotent rebuilds)
  const db = await bootDuckDB();
  await db.open({ path: DB_PATH, accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
  const conn = await db.connect();
  try {
    // FTS (BM25) lives on the normalised `keywords` column; the index is persisted
    // inside the file so the browser only runs read-only match_bm25 against it.
    await conn.query("INSTALL fts; LOAD fts;");

    await conn.query(
      "CREATE OR REPLACE TABLE meta (" +
        "table_name VARCHAR, source_file VARCHAR, version VARCHAR, " +
        "source VARCHAR, url VARCHAR, license VARCHAR)",
    );

    for (const t of TERMINOLOGIES) {
      if (!NAME_RE.test(t.name)) throw new Error(`Nom de table invalide: ${t.name}`);
      const file = `${t.name}.parquet`;
      await db.registerFileBuffer(file, parquets[t.name]);

      // Surrogate integer PK: `code` is NOT unique in adicap, so a stable per-table
      // `id` is the concept identifier everywhere; `code` is display-only.
      await conn.query(
        `CREATE OR REPLACE TABLE ${t.name} AS ` +
          "SELECT CAST(row_number() OVER () AS BIGINT) AS id, *, " +
          "CAST(0 AS BIGINT) AS concept_count, " +
          "CAST(0.0 AS DOUBLE) AS freq_abs, CAST(0.0 AS DOUBLE) AS freq_rel " +
          `FROM read_parquet('${file}')`,
      );
      await conn.query(`ALTER TABLE ${t.name} ADD PRIMARY KEY (id)`);

      // PATCH (en attendant smt2parquet): les libellés CCAM sont préfixés par
      // leur code (ex. "01.01 ACTES …"). On retire ce préfixe.
      if (t.name === "ccam") {
        await conn.query(
          `UPDATE ${t.name} SET label = trim(substr(label, length(code) + 2)) ` +
            "WHERE starts_with(label, code || ' ')",
        );
      }

      const kv = await parquetKv(conn, file);
      const ins = await conn.prepare("INSERT INTO meta VALUES (?, ?, ?, ?, ?, ?)");
      await ins.query(
        t.name,
        `${t.name}-${t.version}.parquet`,
        t.version,
        kv.source || "",
        kv.url || "",
        kv.license || "",
      );
      await ins.close();

      // keywords is already lowercased/accent-stripped; the French stemmer keeps
      // query and index consistent. overwrite=1 makes rebuilds idempotent.
      await conn.query(
        `PRAGMA create_fts_index('${t.name}', 'id', 'keywords', ` +
          "stemmer='french', stopwords='none', overwrite=1)",
      );

      const cnt = (await conn.query(`SELECT count(*) AS n FROM ${t.name}`)).toArray()[0].toJSON().n;
      log(`• ${t.name} : ${Number(cnt).toLocaleString("fr-FR")} concepts, index FTS créé.`);
    }

    // 3. Optional usage counts: a parquet `terminologie; code; concept_count` carries
    // raw counts on the LEAF codes. From those we derive, per node (no runtime
    // recursion — the nested set does the aggregation):
    //   concept_count = sum of the node's subtree leaf counts ([lft, rgt]);
    //   freq_abs      = concept_count / table grand total (global popularity → ranking);
    //   freq_rel      = concept_count / parent's concept_count (share within the parent
    //                   → the display bar). Roots get freq_rel = freq_abs.
    // Rows without counts stay 0 (bars render empty — graceful degradation).
    if (freqBytes) {
      log("Application des comptages d'usage…");
      await db.registerFileBuffer("freq.parquet", freqBytes);
      const cols = await parquetColumns(conn, "freq.parquet");
      const missing = ["terminologie", "code", "concept_count"].filter((c) => !cols.includes(c));
      if (missing.length) {
        throw new Error(`Fichier de comptages invalide : colonnes manquantes (${missing.join(", ")})`);
      }
      for (const t of TERMINOLOGIES) {
        // Step 1 — raw counts onto leaves (leaf = rgt - lft = 1). Dedupe input rows by
        // code first; adicap codes are not unique, so the count attaches in full to
        // every leaf sharing the code (the concept genuinely sits under several parents).
        await conn.query(
          `UPDATE ${t.name} AS x SET concept_count = agg.c ` +
            "FROM (SELECT code, SUM(concept_count) AS c FROM read_parquet('freq.parquet') " +
            `WHERE terminologie = '${t.name}' GROUP BY code) agg ` +
            "WHERE agg.code = x.code AND (x.rgt - x.lft) = 1",
        );
        // Step 2 — aggregate the subtree count onto every node via the nested set
        // (leaf → ancestor-or-self join + GROUP BY; cardinality ≈ #leaves × depth).
        await conn.query(
          `UPDATE ${t.name} AS n SET concept_count = agg.c ` +
            "FROM (SELECT a.id, SUM(l.concept_count) AS c " +
            `FROM ${t.name} a JOIN ${t.name} l ` +
            "ON l.lft >= a.lft AND l.rgt <= a.rgt AND (l.rgt - l.lft) = 1 " +
            "GROUP BY a.id) agg WHERE agg.id = n.id",
        );
        // Step 3 — freq_abs = concept_count / grand total. The total is summed over
        // DISTINCT codes (from the input), so adicap duplicates don't inflate it.
        await conn.query(
          `UPDATE ${t.name} AS x SET freq_abs = x.concept_count / gt.total ` +
            "FROM (SELECT SUM(c) AS total FROM " +
            "(SELECT code, SUM(concept_count) AS c FROM read_parquet('freq.parquet') " +
            `WHERE terminologie = '${t.name}' GROUP BY code)) gt WHERE gt.total > 0`,
        );
        // Step 4 — freq_rel = concept_count / parent's concept_count (parent = path minus
        // its last segment, cf. db.js parents()). Roots have no parent → freq_rel = freq_abs.
        await conn.query(
          `UPDATE ${t.name} AS c SET freq_rel = c.concept_count / p.concept_count ` +
            `FROM ${t.name} p ` +
            "WHERE p.path = regexp_replace(c.path, '/[^/]*$', '') " +
            "AND c.depth > 0 AND p.concept_count > 0",
        );
        await conn.query(`UPDATE ${t.name} SET freq_rel = freq_abs WHERE depth = 0`);
      }
    }

    // Merge the WAL into the main OPFS file so a read-only reopen sees everything.
    log("Finalisation (checkpoint)…");
    await conn.query("CHECKPOINT");
    setStoredVersion(DB_VERSION);
    onProgress({ phase: "done" });
  } finally {
    // Release the exclusive OPFS handle so db.js can reopen the file read-only.
    await conn.close();
    await db.terminate();
  }
}
