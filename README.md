# termose

Static client-side search engine for medical terminologies (**CIM-10**, **CCAM**,
**ADICAP**, **ATC**). The hierarchy of concepts uses the nested-set model. A prebuilt
DuckDB database is queried entirely in the browser via **DuckDB-WASM**, with
full-text BM25 search on the `keywords` column. No backend — it deploys as a
static site on GitHub Pages.

## Layout

```
index.html        the page (header + 3 resizable panels: tree / results / concept)
db.js             DuckDB-WASM data layer (DOM-free; the only file with SQL)
app.js            view layer (no SQL; calls db.js)
build.js          client-side DB generation (download parquets + build, on this branch)
storage.js        OPFS persistence of the generated DB
database/
  build_db.py     rebuilds termose.duckdb from the *.parquet sources (dev/local)
tests/test_db.py  SQL contract tests (mirror the queries in db.js)
smoke.html        in-browser smoke test for db.js
```

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000/
```

A static file server is required (DuckDB-WASM + OPFS need a real origin; opening
`index.html` via `file://` will not work).

`http://localhost:8000/smoke.html` runs the db.js smoke checks in the browser.

## Génération de la base côté client (branche `license`)

Pour des raisons de licence, **la base et les parquets ne sont pas redistribués**
sur cette branche : ils ne sont ni committés ni servis (voir `.gitignore`). À la
place, la base est **générée dans le navigateur** :

1. Au premier chargement, l'app détecte l'absence de base et propose
   « Générer la base » (bouton en haut à droite + boîte de dialogue).
2. `build.js` télécharge les parquets officiels depuis
   [data.gouv.fr](https://www.data.gouv.fr/datasets/terminologie-medicale-au-format-parquet)
   (cim10, ccam, adicap, atc), reconstruit la base avec
   DuckDB-WASM (port de `build_db.py` : `id`, `meta`, patch CCAM, index FTS),
   et la **persiste dans l'OPFS** (`storage.js`).
3. Les chargements suivants rouvrent la base depuis l'OPFS (aucun
   re-téléchargement). Le bouton permet de **régénérer** à tout moment.

La boîte de dialogue accepte un **fichier de fréquences optionnel** (parquet aux
colonnes `terminologie ; code ; freq`) qui remplit la colonne `freq`.

> Vérification headless : `node tools/gen_headless.mjs http://localhost:8000/index.html`
> (flux complet) et `node tools/freq_sql_test.mjs …` (colonne `freq`).
> `build_db.py` / `tests/test_db.py` restent utilisables en local si un
> `database/termose.duckdb` est présent sur le disque (non committé).

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

Serve the repository root (Settings → Pages → Source: root). `.nojekyll` is
committed so Jekyll leaves files untouched. The DuckDB-WASM runtime
(`@duckdb/duckdb-wasm@1.32.0`, pinned to read the duckdb-1.5.3 storage format)
loads from jsDelivr; on this branch the database itself is **generated
client-side** on first use (see above) — nothing licensed is served from the
site.

## Notes

- `freq` (shown as a percentage / "Très fréquent…Rare") reads from the DB. It is
  `0.0` for every row today and the UI renders it gracefully; it lights up once
  real frequencies are populated and the DB is rebuilt.
- The Concept panel is generic: it lists each terminology's own columns
  automatically, so adding a new parquet needs no UI code changes.
