# Termose — static terminology search engine

**Date:** 2026-05-31
**Status:** Approved design, ready for implementation planning

## Goal

A fully static web app, deployable to GitHub Pages, that lets a user search and
browse medical terminologies (CIM-10, CCAM, ADICAP — and any future ones)
entirely client-side, querying a prebuilt DuckDB database via DuckDB-WASM. The
visual design already exists in `design/` and is reused as-is.

## Decisions (from brainstorming)

- **Data delivery:** ship the whole `database/termose.duckdb` (~7.5 MB) as a
  static asset; `ATTACH` it read-only in DuckDB-WASM. (Tradeoff accepted: larger
  download + a storage-format-compatibility check vs. the simplest model.)
- **Frequency:** read the real `freq` column from the DB. It is currently `0.0`
  for every row; the UI must degrade gracefully (0% / empty bars) and light up
  automatically when `freq` is later populated. No fake/computed frequencies.
- **Terminologies:** support all three generically. Common columns
  (`code`, `label`, `depth`, `lft`, `rgt`, `path`, `keywords`, `freq`) drive the
  shared UI; each terminology's *extra* columns render dynamically as attribute
  rows in the Concept panel. Adding a new parquet later needs zero UI code
  changes. The terminology switch is populated from the `meta` table.
- **Search:** DuckDB Full-Text Search (BM25) over the `keywords` column, with the
  index prebuilt and persisted inside `termose.duckdb`. `conjunctive := 1` (all
  query words must match), ranked by BM25 score then `freq`.

## Data model (already built)

`database/termose.duckdb` (built by `database/build_db.py` from the
`smt2parquet` parquet files) contains:

| Table   | Rows   | Notes |
|---------|--------|-------|
| `cim10` | 19 075 | + `type`, `synonymes[]`, `inclusion_note`, `exclusion_note`, `exclusion_codes[]` |
| `ccam`  | 10 274 | + `synonymes[]`, `inclusion_note`, `exclusion_note`, `definition`, `topographie`, `type_acte`, `mode_acces`, `action` |
| `adicap`| 9 682  | + `dictionary_code`, `anatomy_code`, `anatomy_label` |
| `meta`  | 3      | `table_name`, `source_file`, `version` |

Every terminology table shares: `code`, `label`, `depth`, `lft`, `rgt`, `path`,
`keywords`, `freq`. Hierarchy is encoded with the **nested-set model**
(`lft`/`rgt`/`depth`) plus a materialized `path` (e.g. `00/01/01.01`). `keywords`
is pre-normalized (lowercased, accent-stripped, word tokens).

## Architecture

A static site, no runtime build step:

```
index.html        ← the design's HTML/CSS, verbatim (React "tweaks panel" removed)
db.js             ← DuckDB-WASM wrapper: init, ATTACH, typed query helpers. DOM-free.
app.js            ← rewritten, query-driven; owns the DOM. Replaces design/data.js + design/app.js. No SQL strings.
termose.duckdb    ← the prebuilt DB (with FTS indexes), served as a static asset
                    DuckDB-WASM loaded from CDN (jsDelivr) or vendored locally.
```

Boot sequence:
1. Boot DuckDB-WASM, `LOAD fts` (autoload also acceptable).
2. Fetch `termose.duckdb` into the WASM virtual FS; `ATTACH '...' AS termose (READ_ONLY)`.
3. `SELECT * FROM termose.meta` → populate the terminology switch.
4. Load roots of the default terminology into the tree.

### `db.js` — data layer (no DOM)

Owns the single DuckDB-WASM connection. Table names come only from `meta` and are
validated against that allow-list before being interpolated into SQL (defense in
depth; matches the guard already in `build_db.py`). Exposes:

- `init()` — boot, attach, return ready promise.
- `listTerminologies()` → `[{table_name, version, source_file}]`.
- `roots(table)` — `WHERE depth = 0 ORDER BY lft`.
- `children(table, path, depth)` — `WHERE path LIKE path||'/%' AND depth = depth+1 ORDER BY lft`.
- `search(table, query)` — BM25 (see below).
- `concept(table, code)` — single row by `code`.
- `ancestors(table, lft, rgt)` — `WHERE lft < ? AND rgt > ? ORDER BY lft` (breadcrumb; pure nested-set, no recursion).

All helpers return plain JS objects; `VARCHAR[]` columns surface as JS arrays.

### `app.js` — view layer (no SQL)

Owns the DOM and reuses the design's render helpers (rows, badges, breadcrumb,
freq bars, splitters, theme toggle). Three panels:

- **Tree (left):** lazy. Roots load on terminology select; clicking a node's
  twisty calls `children(...)` and renders the first-degree children only.
  Expansion state tracked in JS.
- **Results (center):** rendered from `search(...)`; reuses the design's result
  row (label, path, freq bar). Selecting a result drives the Concept panel and
  (best effort) reveals/selects the node in the tree.
- **Concept (right), generic:** shared header (code, label, freq bar, breadcrumb
  from `ancestors`, nested-set facts: depth/lft/rgt/path) + a dynamically built
  **attributes table** listing every non-common column for that terminology.
  Null/empty values render muted. Array columns (`synonymes`, `exclusion_codes`)
  render as chips. No per-terminology hardcoding.

### Search (FTS / BM25)

Index is **prebuilt at DB-build time** and persisted in the file. Add to
`database/build_db.py`, after each terminology table is created:

```sql
PRAGMA create_fts_index('<table>', 'code', 'keywords',
                        stemmer='french', stopwords='none', overwrite=1);
```

This creates a persistent `fts_main_<table>` schema (index tables + `match_bm25`
macro) stored inside `termose.duckdb`. `code` is the unique document id.
`strip_accents`/`lower` default on, consistent with the already-normalized
`keywords`. `stemmer`/`stopwords` are tunable.

Runtime query (read-only):

```sql
SELECT code, label, depth, path, freq,
       termose.fts_main_<table>.match_bm25(code, ?, conjunctive := 1) AS score
FROM termose.<table>
WHERE score IS NOT NULL
ORDER BY score DESC, freq DESC
LIMIT 300;
```

FTS indexes do not auto-update; rebuilding via `build_db.py` is the right model
whenever `freq` is repopulated or a parquet is refreshed.

## Error handling & states

- **Boot failure** (WASM won't load, or the 1.5.3 storage/index format is
  unreadable by the pinned WASM build): full-panel error showing the actual
  error message — never a silent blank.
- **Boot in progress:** a boot spinner (attach takes a moment; queries
  afterward are fast).
- **Empty / no results:** reuse the design's empty-state.
- **Unknown code / orphan node:** Concept panel shows a "not found" message.

## Testing

- **`db.js` smoke harness** — a small script/page that boots against the real
  `termose.duckdb` and asserts each helper returns sane shapes: roots non-empty
  per terminology; children of a known chapter; a known search hit ranks; a
  known concept's ancestors form the expected chain.
- **Manual UI verification** of the three panels (tree expand, search, concept
  render, theme toggle, splitters) via the `verify`/`run` flow.

## Key risk

The file was written by **duckdb 1.5.3**; both the database storage format and
the FTS index format must be readable by the **pinned DuckDB-WASM build**.
Verified in the *first* implementation step (boot + ATTACH + `SELECT * FROM
termose.meta` + one `match_bm25` query). If incompatible, the fallback is a
one-step re-export to a format the WASM build reads (surfaced explicitly, not
guessed).

## Out of scope

- Populating real `freq` values (data source TBD by the user).
- The design's React "tweaks panel" (a design-token dev tool) — dropped from
  production.
- Cross-terminology / federated search (each query targets one terminology).
