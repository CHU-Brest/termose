# termose

Static client-side search engine for medical terminologies (**CIM-10**, **CCAM**,
**ADICAP**). The hierarchy of concepts uses the nested-set model. A prebuilt
DuckDB database is queried entirely in the browser via **DuckDB-WASM**, with
full-text BM25 search on the `keywords` column. No backend — it deploys as a
static site on GitHub Pages.

## Layout

```
index.html        the page (header + 3 resizable panels: tree / results / concept)
db.js             DuckDB-WASM data layer (DOM-free; the only file with SQL)
app.js            view layer (no SQL; calls db.js)
database/
  termose.duckdb  prebuilt DB (one table per terminology + meta + FTS indexes)
  build_db.py     rebuilds termose.duckdb from the *.parquet sources
tests/test_db.py  SQL contract tests (mirror the queries in db.js)
smoke.html        in-browser smoke test for db.js
```

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000/
```

A static file server is required so the browser can `fetch` the `.duckdb` file
(opening `index.html` directly via `file://` will not work).

`http://localhost:8000/smoke.html` runs the db.js smoke checks in the browser.

## Rebuild the database

```sh
uv run python database/build_db.py   # rebuilds termose.duckdb + FTS indexes
uv run pytest tests/test_db.py -v     # validate
```

Each terminology table gets a surrogate integer primary key `id` (used as the
concept identifier everywhere, since `code` is not unique in ADICAP) and a
persisted FTS/BM25 index on `keywords`. FTS indexes do **not** auto-update —
always rebuild after refreshing a parquet or populating `freq`.

## Deploy (GitHub Pages)

Serve the repository root from the `main` branch (Settings → Pages → Source:
`main` / root). `.nojekyll` is committed so Jekyll leaves files untouched. The
app loads `database/termose.duckdb` (~7.5 MB) and the DuckDB-WASM runtime
(`@duckdb/duckdb-wasm@1.32.0`, pinned to read the duckdb-1.5.3 storage format)
from jsDelivr on first load.

## Notes

- `freq` (shown as a percentage / "Très fréquent…Rare") reads from the DB. It is
  `0.0` for every row today and the UI renders it gracefully; it lights up once
  real frequencies are populated and the DB is rebuilt.
- The Concept panel is generic: it lists each terminology's own columns
  automatically, so adding a new parquet needs no UI code changes.
