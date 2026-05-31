# Termose Search Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully static web app (GitHub Pages) that searches and browses the CIM-10 / CCAM / ADICAP terminologies entirely client-side, querying a prebuilt DuckDB database via DuckDB-WASM, reusing the finished visual design in `design/`.

**Architecture:** A prebuilt `database/termose.duckdb` (nested-set hierarchy + persisted FTS/BM25 indexes on the `keywords` column) is fetched into DuckDB-WASM and `ATTACH`ed read-only. `db.js` owns the WASM connection and exposes DOM-free, typed query helpers. `app.js` owns the DOM (tree / results / concept panels) and calls `db.js`, never building SQL itself. The terminology switch and the generic Concept attribute table are driven by `meta` and the table's own columns, so new terminologies need no UI code.

**Tech Stack:** DuckDB 1.5.3 (build-time, Python) · DuckDB-WASM (runtime, ES module from jsDelivr) · DuckDB FTS extension (BM25) · vanilla HTML/CSS/JS · pytest (build/SQL tests) · Python `http.server` (local static serving).

---

## Spec

`docs/superpowers/specs/2026-05-31-termose-search-engine-design.md`

## File Structure

- `database/build_db.py` — **modify**: add FTS index creation per terminology table.
- `tests/test_db.py` — **create**: pytest validating the build (FTS index present) and the exact runtime SQL semantics against the real `termose.duckdb`.
- `pyproject.toml` — **modify**: add a `pytest` dev dependency.
- `index.html` — **create** (repo root): copy of `design/index.html` with the React "tweaks panel" removed and `db.js` + `app.js` wired in.
- `db.js` — **create** (repo root): DuckDB-WASM wrapper. DOM-free. The only file containing SQL.
- `app.js` — **create** (repo root): query-driven view layer. No SQL. Reuses the design's CSS classes / markup patterns from `design/index.html` and `design/app.js`.
- `smoke.html` — **create** (repo root): in-browser smoke harness that runs every `db.js` helper against the real DB and prints PASS/FAIL. Doubles as the DuckDB-WASM ↔ 1.5.3 format-compatibility gate.
- `.nojekyll` — **create** (repo root): let GitHub Pages serve files/dirs untouched.

The database file stays at `database/termose.duckdb`; the site fetches it via the relative path `database/termose.duckdb`.

---

## Task 1: Persist FTS/BM25 indexes in the database

**Files:**
- Modify: `database/build_db.py`
- Modify: `pyproject.toml`
- Create: `tests/test_db.py`

- [ ] **Step 1: Add pytest as a dev dependency**

Edit `pyproject.toml`. After the existing `[project]` block add:

```toml
[dependency-groups]
dev = [
    "pytest>=8",
]
```

Then run: `uv sync`
Expected: pytest installed into the project venv.

- [ ] **Step 2: Modify `build_db.py` to create an FTS index per table**

In `database/build_db.py`, the loop currently creates each table and inserts into `meta`. Load the fts extension once before the loop, and create the index inside the loop right after the `INSERT INTO meta` call.

Add, immediately after `con = duckdb.connect(str(DB_PATH))`:

```python
    # FTS (BM25) search lives on the normalised `keywords` column. The index is
    # persisted inside the database file (schema `fts_main_<table>`), so the
    # browser only ever runs read-only match_bm25 queries against it.
    con.execute("INSTALL fts; LOAD fts;")
```

Inside the `for parquet in parquets:` loop, after the `con.execute("INSERT INTO meta VALUES (?, ?, ?)", [name, parquet.name, version])` line, add:

```python
        # `code` is unique per table -> it is the FTS document id.
        # keywords is already lowercased/accent-stripped; stemmer keeps French
        # medical terms consistent between index and query. overwrite=1 makes
        # rebuilds idempotent.
        con.execute(
            f"PRAGMA create_fts_index('{name}', 'code', 'keywords', "
            "stemmer='french', stopwords='none', overwrite=1)"
        )
```

(`name` is already validated against `^[a-z][a-z0-9_]*$` earlier in the loop, so the f-string interpolation is safe.)

- [ ] **Step 3: Rebuild the database**

Run: `uv run python database/build_db.py`
Expected: prints the `meta` table and per-table row counts, no error. `database/termose.duckdb` is regenerated with FTS indexes.

- [ ] **Step 4: Write the build/SQL test**

Create `tests/test_db.py`. These tests lock the **exact SQL** that `db.js` will reuse, run against the real file, and prove the FTS index is present and queryable.

```python
"""Validate the prebuilt termose.duckdb: FTS index presence + runtime SQL.

The SQL strings here are the canonical queries db.js mirrors. If you change a
query in db.js, change it here too (and vice-versa)."""
from pathlib import Path

import duckdb
import pytest

DB = str(Path(__file__).resolve().parent.parent / "database" / "termose.duckdb")
TABLES = ["cim10", "ccam", "adicap"]


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect(DB, read_only=True)
    c.execute("LOAD fts;")
    yield c
    c.close()


def test_meta_lists_three_terminologies(con):
    rows = con.execute(
        "SELECT table_name, version FROM meta ORDER BY table_name"
    ).fetchall()
    names = [r[0] for r in rows]
    assert names == ["adicap", "ccam", "cim10"]


@pytest.mark.parametrize("table", TABLES)
def test_roots_exist(con, table):
    rows = con.execute(
        f"SELECT code, label, depth, lft, rgt, path, freq "
        f"FROM {table} WHERE depth = 0 ORDER BY lft"
    ).fetchall()
    assert len(rows) >= 1
    assert all(r[2] == 0 for r in rows)  # depth == 0


@pytest.mark.parametrize("table", TABLES)
def test_children_of_a_root(con, table):
    root_path, root_depth = con.execute(
        f"SELECT path, depth FROM {table} WHERE depth = 0 ORDER BY lft LIMIT 1"
    ).fetchone()
    kids = con.execute(
        f"SELECT code, depth FROM {table} "
        f"WHERE path LIKE ? AND depth = ? ORDER BY lft",
        [root_path + "/%", root_depth + 1],
    ).fetchall()
    assert len(kids) >= 1
    assert all(k[1] == root_depth + 1 for k in kids)


@pytest.mark.parametrize("table", TABLES)
def test_fts_index_present_and_ranks(con, table):
    # Pick a real keyword token from the table, then search for it.
    word = con.execute(
        f"SELECT split_part(keywords, ' ', 1) FROM {table} "
        f"WHERE keywords IS NOT NULL AND length(keywords) > 3 LIMIT 1"
    ).fetchone()[0]
    rows = con.execute(
        f"SELECT code, label, freq, "
        f"fts_main_{table}.match_bm25(code, ?, conjunctive := 1) AS score "
        f"FROM {table} WHERE score IS NOT NULL "
        f"ORDER BY score DESC, freq DESC LIMIT 300",
        [word],
    ).fetchall()
    assert len(rows) >= 1
    assert rows[0][3] is not None  # has a BM25 score


@pytest.mark.parametrize("table", TABLES)
def test_concept_and_ancestors(con, table):
    # A node at depth >= 2 so it has ancestors.
    node = con.execute(
        f"SELECT code, lft, rgt FROM {table} WHERE depth >= 2 ORDER BY lft LIMIT 1"
    ).fetchone()
    code, lft, rgt = node
    one = con.execute(f"SELECT * FROM {table} WHERE code = ?", [code]).fetchone()
    assert one is not None
    anc = con.execute(
        f"SELECT code, label FROM {table} "
        f"WHERE lft < ? AND rgt > ? ORDER BY lft",
        [lft, rgt],
    ).fetchall()
    assert len(anc) >= 1  # at least the chapter above it
```

- [ ] **Step 5: Run the tests**

Run: `uv run pytest tests/test_db.py -v`
Expected: all tests PASS (3 terminologies × roots/children/fts/concept + meta).

- [ ] **Step 6: Commit**

```bash
git add database/build_db.py pyproject.toml uv.lock tests/test_db.py database/termose.duckdb
git commit -m "feat(db): persist FTS/BM25 indexes and add SQL contract tests"
```

---

## Task 2: Static site skeleton (design without the tweaks panel)

**Files:**
- Create: `index.html`
- Create: `.nojekyll`
- Create: `db.js` (stub)
- Create: `app.js` (stub)

- [ ] **Step 1: Create `index.html` from the design**

Copy `design/index.html` to `index.html` at the repo root. Then make exactly these edits to the copy:

Remove the three React/Babel script tags and the two tweaks tags (lines near the end of `design/index.html`):

```html
<!-- DELETE these lines -->
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" ...></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" ...></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" ...></script>
<script src="data.js"></script>
<script src="app.js"></script>
<script type="text/babel" src="tweaks-panel.jsx"></script>
<script type="text/babel" src="tweaks.jsx"></script>
```

Replace them with a single module script (note `type="module"` — `app.js` imports `db.js`):

```html
<script type="module" src="app.js"></script>
```

Also delete the tweaks mount point `<div id="tweaks-root"></div>` and the `#tweaks-root` CSS rules (the two rules at the very end of the `<style>` block). Leave **all other** HTML/CSS untouched.

- [ ] **Step 2: Create `.nojekyll`**

Create an empty file `.nojekyll` at the repo root (prevents GitHub Pages' Jekyll from ignoring files).

```bash
touch .nojekyll
```

- [ ] **Step 3: Create stub `db.js`**

```js
// db.js — DuckDB-WASM data layer (DOM-free). Filled in Tasks 3-4.
export const TODO = true;
```

- [ ] **Step 4: Create stub `app.js`**

```js
// app.js — view layer (no SQL). Filled in Tasks 5-8.
import "./db.js";
console.log("termose: app.js loaded");
```

- [ ] **Step 5: Verify the page loads**

Run: `python3 -m http.server 8000`
Then open `http://localhost:8000/` in a browser.
Expected: the design renders (top bar, search bar, three empty panels, theme toggle visible); DevTools console shows `termose: app.js loaded` and no 404s for jsx/data.js. Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add index.html .nojekyll db.js app.js
git commit -m "feat(ui): static site skeleton from design (tweaks panel removed)"
```

---

## Task 3: DuckDB-WASM boot + ATTACH + meta (compatibility gate)

**Files:**
- Modify: `db.js`
- Create: `smoke.html`

This task is the **risk gate**: it proves the pinned DuckDB-WASM build can read the 1.5.3 storage format and FTS index. Resolve the version here.

- [ ] **Step 1: Implement boot + attach in `db.js`**

Replace the contents of `db.js` with:

```js
// db.js — DuckDB-WASM data layer. DOM-free. Only file that contains SQL.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

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
```

Note: `1.29.0` is a starting pin. If Step 3 fails on a storage/index format error, bump to the DuckDB-WASM release matching DuckDB 1.5.x and re-test; that resolution IS the gate.

- [ ] **Step 2: Create `smoke.html`**

```html
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>termose smoke</title>
<style>body{font:14px monospace;padding:20px}.p{color:green}.f{color:red}</style>
</head><body><h1>db.js smoke test</h1><div id="out"></div>
<script type="module">
import * as db from "./db.js";
const out = document.getElementById("out");
const log = (ok, msg) => {
  const d = document.createElement("div");
  d.className = ok ? "p" : "f";
  d.textContent = (ok ? "PASS " : "FAIL ") + msg;
  out.appendChild(d);
};
async function check(name, fn) {
  try { await fn(); log(true, name); }
  catch (e) { log(false, name + " — " + e.message); console.error(e); }
}
await check("init() boots + attaches", async () => { await db.init(); });
await check("listTerminologies() returns 3", async () => {
  const t = await db.listTerminologies();
  if (t.length !== 3) throw new Error("got " + t.length);
});
window.__db = db; // reused by later smoke steps
</script></body></html>
```

- [ ] **Step 3: Run the compatibility gate**

Run: `python3 -m http.server 8000`
Open `http://localhost:8000/smoke.html`.
Expected: two green `PASS` lines. If `init()` FAILS with a storage/catalog version error, bump the `@duckdb/duckdb-wasm@...` pin in `db.js` (Step 1) to the build matching DuckDB 1.5.x and reload until it passes. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add db.js smoke.html
git commit -m "feat(db): DuckDB-WASM boot, read-only ATTACH, meta + smoke gate"
```

---

## Task 4: `db.js` query helpers

**Files:**
- Modify: `db.js`
- Modify: `smoke.html`

- [ ] **Step 1: Add the query helpers to `db.js`**

Before the final `export { rows as _rows, ... }` line, add these exports. The SQL mirrors `tests/test_db.py` exactly.

```js
export async function roots(table) {
  assertTable(table);
  return rows(
    `SELECT code, label, depth, lft, rgt, path, freq
     FROM termose.${table} WHERE depth = 0 ORDER BY lft`,
  );
}

export async function children(table, path, depth) {
  assertTable(table);
  return rows(
    `SELECT code, label, depth, lft, rgt, path, freq
     FROM termose.${table} WHERE path LIKE ? AND depth = ? ORDER BY lft`,
    [path + "/%", depth + 1],
  );
}

export async function search(table, query) {
  assertTable(table);
  const q = (query || "").trim();
  if (!q) return [];
  return rows(
    `SELECT code, label, depth, path, freq,
            termose.fts_main_${table}.match_bm25(code, ?, conjunctive := 1) AS score
     FROM termose.${table}
     WHERE score IS NOT NULL
     ORDER BY score DESC, freq DESC
     LIMIT 300`,
    [q],
  );
}

// Full row (all columns) for the concept panel; null if missing.
export async function concept(table, code) {
  assertTable(table);
  const r = await rows(`SELECT * FROM termose.${table} WHERE code = ?`, [code]);
  return r[0] || null;
}

// Ancestor chain (root -> parent), ordered, for the breadcrumb. Uses nested set.
export async function ancestors(table, lft, rgt) {
  assertTable(table);
  return rows(
    `SELECT code, label, depth FROM termose.${table}
     WHERE lft < ? AND rgt > ? ORDER BY lft`,
    [lft, rgt],
  );
}

// Column names of a terminology table, in declared order (drives the generic
// Concept attribute list). Excludes the common columns the shared UI renders.
const COMMON = new Set(["code", "label", "depth", "lft", "rgt", "path", "keywords", "freq"]);
export async function extraColumns(table) {
  assertTable(table);
  const cols = await rows(
    `SELECT column_name FROM information_schema.columns
     WHERE table_catalog = 'termose' AND table_name = ?
     ORDER BY ordinal_position`,
    [table],
  );
  return cols.map((c) => c.column_name).filter((c) => !COMMON.has(c));
}
```

- [ ] **Step 2: Extend `smoke.html` with helper assertions**

In `smoke.html`, before the `window.__db = db;` line, add:

```js
await check("roots(cim10) non-empty", async () => {
  const r = await db.roots("cim10");
  if (!r.length || r[0].depth !== 0) throw new Error("bad roots");
});
await check("children() of first root", async () => {
  const r = await db.roots("ccam");
  const k = await db.children("ccam", r[0].path, r[0].depth);
  if (!k.length) throw new Error("no children");
});
await check("search(cim10,'tumeur') ranks", async () => {
  const r = await db.search("cim10", "tumeur");
  if (!r.length || r[0].score == null) throw new Error("no ranked hit");
});
await check("concept() + ancestors()", async () => {
  const r = await db.roots("cim10");
  const k = await db.children("cim10", r[0].path, r[0].depth);
  const c = await db.concept("cim10", k[0].code);
  if (!c) throw new Error("no concept");
  const a = await db.ancestors("cim10", k[0].lft, k[0].rgt);
  if (!a.length) throw new Error("no ancestors");
});
await check("extraColumns(adicap) excludes common", async () => {
  const cols = await db.extraColumns("adicap");
  if (cols.includes("code") || !cols.includes("anatomy_label")) throw new Error(cols.join(","));
});
```

- [ ] **Step 3: Run the smoke harness**

Run: `python3 -m http.server 8000`
Open `http://localhost:8000/smoke.html`.
Expected: all `PASS` (now 7 lines). Stop the server.

- [ ] **Step 4: Commit**

```bash
git add db.js smoke.html
git commit -m "feat(db): roots/children/search/concept/ancestors/extraColumns helpers"
```

---

## Task 5: `app.js` foundation — boot, terminology switch, theme, splitters

**Files:**
- Modify: `app.js`

Reuse the small pure helpers and the resizer/theme logic that already exist in `design/app.js` (read it for the exact splitter drag math and theme-toggle code — class names match `index.html`). This task builds the shell; tree/results/concept come next.

- [ ] **Step 1: Write the `app.js` foundation**

Replace `app.js` with:

```js
// app.js — view layer. No SQL (all data comes from db.js).
import * as db from "./db.js";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const state = {
  term: null, // current terminology table name
  terms: [], // [{table_name, version, source_file}]
  selected: null, // selected code
};

// ---- theme ----
function initTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem("termose-theme");
  if (saved) root.setAttribute("data-theme", saved);
  $("#themeBtn").addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("termose-theme", next);
  });
}

// ---- resizable splitters (left tree / right detail) ----
function initSplitters() {
  document.querySelectorAll(".splitter").forEach((sp) => {
    const side = sp.dataset.resize; // "left" | "right"
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sp.classList.add("dragging");
      sp.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const prop = side === "left" ? "--panel-left" : "--panel-right";
      const start = parseInt(getComputedStyle(document.documentElement).getPropertyValue(prop), 10);
      const onMove = (ev) => {
        const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
        const next = Math.max(220, Math.min(720, start + delta));
        document.documentElement.style.setProperty(prop, next + "px");
      };
      const onUp = () => {
        sp.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });
}

// ---- terminology switch (populated from meta) ----
function renderTermSelect() {
  const sel = $("#termSelect");
  sel.innerHTML = "";
  state.terms.forEach((t) => {
    const o = el("option");
    o.value = t.table_name;
    o.textContent = t.table_name.toUpperCase();
    if (t.table_name === state.term) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => switchTerm(sel.value);
  renderMetaChip();
}

function renderMetaChip() {
  const t = state.terms.find((x) => x.table_name === state.term);
  $("#metaChip").innerHTML = t ? `<b>${esc(t.table_name.toUpperCase())}</b> · v.${esc(t.version)}` : "";
}

async function switchTerm(table) {
  state.term = table;
  state.selected = null;
  renderMetaChip();
  clearResults();
  clearDetail();
  await loadTree(); // defined in Task 6
}

function fatal(msg, detail) {
  document.querySelector(".main").innerHTML =
    `<div class="empty-state" style="margin:auto;max-width:420px">
       <p><b>${esc(msg)}</b></p><p>${esc(detail || "")}</p>
     </div>`;
}

async function boot() {
  initTheme();
  initSplitters();
  initSearch(); // defined in Task 7
  try {
    showBootSpinner();
    await db.init();
    state.terms = await db.listTerminologies();
    state.term = state.terms[0]?.table_name || null;
    renderTermSelect();
    clearResults();
    clearDetail();
    await loadTree();
  } catch (e) {
    console.error(e);
    fatal("Impossible de charger la base de données.", e.message);
  }
}

// Stubs filled in later tasks (declared now so boot() references resolve).
function showBootSpinner() { $("#tree").innerHTML = `<div class="empty-state"><p>Chargement…</p></div>`; }
function clearResults() { $("#results").innerHTML = ""; $("#resultsMeta").innerHTML = ""; }
function clearDetail() {
  $("#detail").innerHTML =
    `<div class="detail-empty"><p>Sélectionnez un concept dans l'arbre ou la liste de résultats pour afficher ses détails.</p></div>`;
}
async function loadTree() {} // Task 6
function initSearch() {} // Task 7

boot();

// Exported for later tasks within this module (kept in one file).
export { state, $, el, esc };
```

- [ ] **Step 2: Verify the shell boots end-to-end**

Run: `python3 -m http.server 8000` and open `http://localhost:8000/`.
Expected: brief "Chargement…" in the tree column, then the terminology `<select>` is populated (CIM10 / CCAM / ADICAP — alphabetical: ADICAP, CCAM, CIM10), the meta chip shows the version, theme toggle works, and the left/right splitters resize the panels. No console errors. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(ui): app boot, terminology switch, theme toggle, resizable splitters"
```

---

## Task 6: Tree panel with lazy expansion

**Files:**
- Modify: `app.js`

Read `design/app.js`'s `makeNode` / tree row markup for the exact class names (`.node`, `.node-row`, `.twisty`, `.node-label`, `.kids`) and the chevron SVG (`CHEVRON` constant). Reuse that markup; replace its in-memory data source with `db.children(...)`.

- [ ] **Step 1: Implement the tree**

Replace the `async function loadTree() {}` stub and the `showBootSpinner` stub region with:

```js
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

function nodeRow(n) {
  const node = el("div", "node");
  node.dataset.code = n.code;
  const isLeaf = n.rgt - n.lft <= 1; // nested-set: leaf has no descendants
  const row = el("div", "node-row" + (n.depth === 0 ? " is-chapter" : ""));
  row.innerHTML =
    `<span class="twisty${isLeaf ? " leaf" : ""}">${CHEVRON}</span>` +
    `<span class="node-label">${esc(n.label)}</span>`;
  const kids = el("div", "kids");
  node.appendChild(row);
  node.appendChild(kids);

  const twisty = row.querySelector(".twisty");
  let loaded = false;
  async function toggle() {
    if (isLeaf) return;
    const open = kids.classList.toggle("open");
    twisty.classList.toggle("open", open);
    if (open && !loaded) {
      loaded = true;
      const cs = await db.children(state.term, n.path, n.depth);
      cs.forEach((c) => kids.appendChild(nodeRow(c)));
    }
  }
  twisty.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener("click", () => selectConcept(n.code)); // Task 8
  return node;
}

async function loadTree() {
  const tree = $("#tree");
  tree.innerHTML = `<div class="empty-state"><p>Chargement…</p></div>`;
  const rs = await db.roots(state.term);
  tree.innerHTML = "";
  rs.forEach((r) => tree.appendChild(nodeRow(r)));
}
```

Also wire the "Tout replier" button — add inside `boot()` after `initSplitters();`:

```js
  $("#collapseBtn").addEventListener("click", () => {
    document.querySelectorAll("#tree .kids.open").forEach((k) => k.classList.remove("open"));
    document.querySelectorAll("#tree .twisty.open").forEach((t) => t.classList.remove("open"));
  });
```

Add a stub `async function selectConcept(code) {}` near the other stubs (filled in Task 8).

- [ ] **Step 2: Verify lazy expansion**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/`.
Expected: tree shows roots for the default terminology. Clicking a twisty fetches and reveals first-degree children (check the Network tab: no children load until you expand). Leaf nodes have no chevron. "Tout replier" collapses everything. Switching terminology reloads the tree. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(ui): lazy nested-set tree with on-demand child queries"
```

---

## Task 7: Search → results panel

**Files:**
- Modify: `app.js`

Reuse `design/app.js`'s result-row markup (`.result`, `.r-top`, `.r-label`, `.r-foot`, `.r-path`, `.freq`, `.freq-bar`, `.freq-val`) and the `hl()` highlight helper. Frequency renders from the real `freq` (0 → empty bar, no crash).

- [ ] **Step 1: Implement search + results**

Replace the `function initSearch() {}` stub with:

```js
function fmtFreq(freq) {
  const pct = Math.round((Number(freq) || 0) * 100);
  return { pct, label: pct >= 60 ? "Très fréquent" : pct >= 30 ? "Fréquent" : pct >= 10 ? "Peu fréquent" : "Rare" };
}

function resultItem(n, query) {
  const item = el("div", "result");
  item.dataset.code = n.code;
  const { pct } = fmtFreq(n.freq);
  item.innerHTML =
    `<div class="r-top"><span class="r-label">${esc(n.label)}</span></div>` +
    `<div class="r-foot">` +
      `<span class="r-path">${esc(n.code)}</span>` +
      `<span class="freq"><span class="freq-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="freq-val">${pct}%</span></span>` +
    `</div>`;
  item.addEventListener("click", () => selectConcept(n.code));
  return item;
}

function renderResults(list, query) {
  const box = $("#results");
  box.innerHTML = "";
  $("#resultsMeta").innerHTML = `<b>${list.length}</b> résultat${list.length > 1 ? "s" : ""}`;
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><p>Aucun résultat pour « ${esc(query)} ».</p></div>`;
    return;
  }
  list.forEach((n) => box.appendChild(resultItem(n, query)));
}

let _searchTimer = null;
function initSearch() {
  const input = $("#search");
  const clear = $("#clearBtn");
  const run = async () => {
    const q = input.value.trim();
    clear.classList.toggle("show", q.length > 0);
    if (!q) { clearResults(); return; }
    try {
      const list = await db.search(state.term, q);
      renderResults(list, q);
    } catch (e) {
      console.error(e);
      $("#results").innerHTML = `<div class="empty-state"><p>Erreur de recherche : ${esc(e.message)}</p></div>`;
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(run, 180); // debounce
  });
  clear.addEventListener("click", () => { input.value = ""; clear.classList.remove("show"); clearResults(); });
}
```

- [ ] **Step 2: Verify search**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/`.
Expected: typing `tumeur` in CIM-10 lists ranked results with code + freq bar (bars empty at 0% — no errors). The result count shows in the meta line. Clearing the box empties results. Multi-word `infection intestin` returns rows where both stems match. Switching terminology then searching queries the new table. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(ui): FTS search with debounce and ranked results panel"
```

---

## Task 8: Concept panel (generic attributes)

**Files:**
- Modify: `app.js`

Reuse `design/app.js`'s detail markup classes (`.d-head`, `.d-code`, `.d-label`, `.d-breadcrumb`, `.crumb`, `.section`, `.section-h`, `.facts`, `.fact`, `.attr-list`, `.attr`, `.syn-chips`, `.syn-chip`, `.freq-detail`). The attribute list is built **dynamically** from `db.extraColumns(...)`, so no terminology-specific code.

- [ ] **Step 1: Implement the concept panel**

Replace the `async function selectConcept(code) {}` stub with:

```js
function factBlock(k, v) {
  return `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
}

function attrValue(v) {
  if (v == null || v === "") return `<span class="av null">—</span>`;
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="av null">—</span>`;
    return `<div class="syn-chips">${v.map((x) => `<span class="syn-chip">${esc(x)}</span>`).join("")}</div>`;
  }
  return `<div class="av">${esc(String(v)).replace(/\n/g, "<br>")}</div>`;
}

function highlightTreeSelection(code) {
  document.querySelectorAll("#tree .node-row.selected").forEach((r) => r.classList.remove("selected"));
  const node = document.querySelector(`#tree .node[data-code="${CSS.escape(code)}"] > .node-row`);
  if (node) node.classList.add("selected");
  document.querySelectorAll("#results .result.active").forEach((r) => r.classList.remove("active"));
  const res = document.querySelector(`#results .result[data-code="${CSS.escape(code)}"]`);
  if (res) res.classList.add("active");
}

async function selectConcept(code) {
  state.selected = code;
  highlightTreeSelection(code);
  const detail = $("#detail");
  try {
    const c = await db.concept(state.term, code);
    if (!c) { detail.innerHTML = `<div class="detail-empty"><p>Concept introuvable : ${esc(code)}</p></div>`; return; }
    const cols = await db.extraColumns(state.term);
    const anc = await db.ancestors(state.term, c.lft, c.rgt);
    const { pct, label } = fmtFreq(c.freq);

    const crumbs = anc
      .map((a) => `<span class="crumb" data-code="${esc(a.code)}">${esc(a.code)}</span>`)
      .join('<span class="crumb-sep">/</span>');

    const attrs = cols
      .map((col) => `<div class="attr"><div class="ak">${esc(col)}</div>${attrValue(c[col])}</div>`)
      .join("");

    detail.innerHTML = `<div class="detail-inner">
      <div class="d-head"><span class="d-code">${esc(c.code)}</span></div>
      <h2 class="d-label">${esc(c.label)}</h2>
      <div class="freq-detail"><div class="fd-top">
        <span class="fd-num">${pct}<span class="fd-unit"> %</span></span>
        <span class="fd-tag ${pct >= 60 ? "vf" : pct >= 30 ? "f" : pct >= 10 ? "p" : "r"}">${esc(label)}</span>
      </div><div class="fd-bar"><i style="width:${pct}%"></i></div></div>
      ${anc.length ? `<div class="section"><div class="section-h">Hiérarchie</div><div class="d-breadcrumb">${crumbs}</div></div>` : ""}
      <div class="section"><div class="section-h">Attributs</div><div class="attr-list">${attrs}</div></div>
      <div class="section"><div class="section-h">Position (nested set)</div><div class="facts">
        ${factBlock("depth", c.depth)}${factBlock("lft", c.lft)}${factBlock("rgt", c.rgt)}
        <div class="fact path-fact"><div class="k">path</div><div class="v">${esc(c.path)}</div></div>
      </div></div>
    </div>`;

    detail.querySelectorAll(".crumb").forEach((cr) =>
      cr.addEventListener("click", () => selectConcept(cr.dataset.code)));
  } catch (e) {
    console.error(e);
    detail.innerHTML = `<div class="detail-empty"><p>Erreur : ${esc(e.message)}</p></div>`;
  }
}
```

- [ ] **Step 2: Verify the concept panel across terminologies**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/`.
Expected:
- Clicking a tree node or a search result fills the Concept panel: code, label, freq block (0% / "Rare" when freq is 0), breadcrumb of ancestor codes, an **Attributes** list whose rows match that terminology's extra columns (CIM-10: `synonymes` as chips, `inclusion_note`, etc.; CCAM: `definition`, `topographie`…; ADICAP: `anatomy_label`, `dictionary_code`), and the nested-set facts.
- Empty/null attributes show `—`. Clicking a breadcrumb code navigates to that ancestor. The selected row highlights in tree/results.
Switch through all three terminologies to confirm the attribute list adapts with no errors. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(ui): generic concept panel with dynamic per-terminology attributes"
```

---

## Task 9: Final verification & GitHub Pages readiness

**Files:**
- Create: `README.md` (overwrite the placeholder) — deployment notes.

- [ ] **Step 1: Run the full SQL test suite**

Run: `uv run pytest tests/test_db.py -v`
Expected: all PASS.

- [ ] **Step 2: Run the browser smoke harness**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/smoke.html`.
Expected: all 7 PASS.

- [ ] **Step 3: Full manual UI pass**

With the server running, open `http://localhost:8000/` and confirm, for **each** terminology:
- Tree loads, lazy-expands, "Tout replier" works.
- Search returns ranked results; clearing works.
- Selecting from tree and from results both populate the Concept panel; breadcrumb navigation works.
- Theme toggle persists across reload; splitters resize.
- No console errors anywhere. Stop the server.

- [ ] **Step 4: Write deployment notes in `README.md`**

```markdown
# termose

Static client-side search engine for medical terminologies (CIM-10, CCAM,
ADICAP) backed by a prebuilt DuckDB database queried in the browser via
DuckDB-WASM (FTS/BM25 search on the `keywords` column).

## Develop / run locally

    python3 -m http.server 8000   # then open http://localhost:8000/

(A static file server is required so the browser can `fetch` the .duckdb file.)

## Rebuild the database

    uv run python database/build_db.py   # rebuilds termose.duckdb + FTS indexes
    uv run pytest tests/test_db.py -v     # validate

FTS indexes do not auto-update — always rebuild after refreshing a parquet or
populating `freq`.

## Deploy (GitHub Pages)

Serve the repository root from the `main` branch (Settings → Pages → Source:
main / root). `.nojekyll` is committed so Jekyll leaves files untouched. The app
fetches `database/termose.duckdb` (~7.5 MB) on load.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: deployment + rebuild notes; final verification"
```

- [ ] **Step 6 (optional, on request): enable GitHub Pages**

If the user wants it live, push `main` and enable Pages (Source: `main` / root) via repo settings or:

```bash
gh api -X POST repos/{owner}/{repo}/pages -f source.branch=main -f source.path=/
```

---

## Notes for the implementer

- **DuckDB-WASM version pin (Task 3)** is the single biggest risk. If `ATTACH` or `match_bm25` fails on a format/catalog error, bump the `@duckdb/duckdb-wasm@...` pin to the release matching DuckDB 1.5.x and re-run the smoke gate before continuing.
- **One source of SQL:** every SQL string lives in `db.js`; `tests/test_db.py` mirrors them. If you change one, change both.
- **`freq` is 0.0 everywhere today** — that is expected. The UI must render 0%/empty without crashing; it lights up when `freq` is populated and the DB is rebuilt.
- **Reuse, don't reinvent:** `design/app.js` and `design/index.html` already contain the exact markup/classes for tree rows, result rows, and the detail panel. Borrow their markup; only the data source changes.
