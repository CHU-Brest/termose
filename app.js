// app.js — view layer. No SQL (all data comes from db.js).
// Propagate our own cache-busting ?v= to db.js so app.js and db.js always load
// as a matched, fresh pair (prevents stale-cache mix breaking boot after updates).
const _v = new URL(import.meta.url).searchParams.get("v");
const db = await import("./db.js" + (_v ? `?v=${_v}` : ""));

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
  selected: null, // selected id
  tab: "tree", // active left-pane tab: "tree" | "results"
};

// ----------------------------------------------------------- keyboard shortcuts
function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); // Ctrl/⌘+K → focus the search bar
      const input = $("#search");
      input.focus();
      input.select();
    }
  });
}

// ---------------------------------------------------------------- theme
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

// ------------------------------------------------------- resizable splitters
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

// ---------------------------------------------- terminology switch (from meta)
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
}

async function switchTerm(table) {
  state.term = table;
  state.selected = null;
  clearResults();
  clearDetail();
  $("#search").value = "";
  $("#clearBtn").classList.remove("show");
  setTab("tree");
  await loadTree();
}

function fatal(msg, detail) {
  document.querySelector(".main").innerHTML =
    `<div class="empty-state" style="margin:auto;max-width:420px">
       <p><b>${esc(msg)}</b></p><p>${esc(detail || "")}</p>
     </div>`;
}

// --------------------------------------------------------- shared empty states
function showBootSpinner() {
  $("#tree").innerHTML = `<div class="empty-state"><p>Chargement de la base…</p></div>`;
}
function clearResults() {
  $("#resultsMeta").innerHTML = "";
  $("#results").innerHTML =
    `<div class="empty-state"><p>Tapez une recherche pour lister les concepts.</p></div>`;
}

// ----------------------------------------------------------------- tabs
function setTab(tab) {
  state.tab = tab;
  const isTree = tab === "tree";
  $("#tabTreeBtn").setAttribute("aria-pressed", String(isTree));
  $("#tabResultsBtn").setAttribute("aria-pressed", String(!isTree));
  $("#tabTree").hidden = !isTree;
  $("#tabResults").hidden = isTree;
  $("#treeToolbar").style.display = isTree ? "" : "none"; // collapse-all only on the tree tab
}
function initTabs() {
  $("#tabTreeBtn").addEventListener("click", () => setTab("tree"));
  $("#tabResultsBtn").addEventListener("click", () => setTab("results"));
}
function clearDetail() {
  $("#detail").innerHTML =
    `<div class="detail-empty"><p>Sélectionnez un concept dans l'arbre ou la liste de résultats pour afficher ses détails.</p></div>`;
}

// ====================================================================== TREE
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

// Colour the code badge by depth (generic across terminologies). For cim10 this
// matches its type→colour mapping (chapter@0, block@1, category@2, subcategory@3).
const BADGE_BY_DEPTH = ["chapter", "block", "category", "subcategory", "paragraph", "acte", "subchapter"];
const badgeClass = (n) => n.type || BADGE_BY_DEPTH[Math.min(n.depth, BADGE_BY_DEPTH.length - 1)];

function nodeRow(n) {
  const node = el("div", "node");
  node.dataset.id = n.id; // integer id is the unique identifier (code is not unique in adicap)
  const isLeaf = n.rgt - n.lft <= 1; // nested-set: leaf has no descendants
  const row = el("div", "node-row" + (n.depth === 0 ? " is-chapter" : ""));
  row.innerHTML =
    `<span class="twisty${isLeaf ? " leaf" : ""}">${CHEVRON}</span>` +
    `<span class="badge ${badgeClass(n)}">${esc(n.code)}</span>` +
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
  row.addEventListener("click", () => selectConcept(n.id));
  row.addEventListener("dblclick", () => toggle()); // double-click anywhere on the row expands/collapses
  return node;
}

async function loadTree() {
  const tree = $("#tree");
  tree.innerHTML = `<div class="empty-state"><p>Chargement…</p></div>`;
  const rs = await db.roots(state.term);
  tree.innerHTML = "";
  rs.forEach((r) => tree.appendChild(nodeRow(r)));
}

// Filtered tree (search mode): flat rows (matches + ancestors, lft-ordered) rebuilt
// into a pruned, fully-expanded tree. Children are already present — no DB calls.
function renderFilteredTree(nodes) {
  const tree = $("#tree");
  tree.innerHTML = "";
  if (!nodes.length) {
    tree.innerHTML = `<div class="empty-state"><p>Aucun concept trouvé.</p></div>`;
    return;
  }
  const byPath = new Map();
  nodes.forEach((n) => { n._kids = []; byPath.set(n.path, n); });
  const roots = [];
  nodes.forEach((n) => {
    const cut = n.path.lastIndexOf("/");
    const parent = cut > 0 ? byPath.get(n.path.slice(0, cut)) : null;
    (parent ? parent._kids : roots).push(n);
  });
  roots.forEach((r) => tree.appendChild(filteredNode(r)));
}

function filteredNode(n) {
  const node = el("div", "node");
  node.dataset.id = n.id;
  const hasKids = n._kids && n._kids.length > 0;
  const row = el(
    "div",
    "node-row" + (n.depth === 0 ? " is-chapter" : "") + (n.is_match ? " matched" : ""),
  );
  row.innerHTML =
    `<span class="twisty${hasKids ? " open" : " leaf"}">${CHEVRON}</span>` +
    `<span class="badge ${badgeClass(n)}">${esc(n.code)}</span>` +
    `<span class="node-label">${esc(n.label)}</span>`;
  const kids = el("div", "kids" + (hasKids ? " open" : ""));
  node.appendChild(row);
  node.appendChild(kids);
  if (hasKids) n._kids.forEach((c) => kids.appendChild(filteredNode(c)));

  const twisty = row.querySelector(".twisty");
  const toggle = () => {
    if (!hasKids) return;
    const open = kids.classList.toggle("open");
    twisty.classList.toggle("open", open);
  };
  twisty.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener("click", () => selectConcept(n.id));
  row.addEventListener("dblclick", () => toggle());
  return node;
}

// =================================================================== RESULTS
function fmtFreq(freq) {
  return { pct: Math.round((Number(freq) || 0) * 100) };
}

function resultItem(n) {
  const item = el("div", "result");
  item.dataset.id = n.id; // identity = integer id; code is display-only
  const { pct } = fmtFreq(n.freq);
  item.innerHTML =
    `<div class="r-top">` +
      `<span class="badge ${badgeClass(n)}">${esc(n.code)}</span>` +
      `<span class="r-label">${esc(n.label)}</span>` +
      `<span class="freq"><span class="freq-bar"><i style="width:${pct}%"></i></span>` +
      `<span class="freq-val">${pct}%</span></span>` +
    `</div>`;
  item.addEventListener("click", () => selectConcept(n.id));
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
  list.forEach((n) => box.appendChild(resultItem(n)));
}

let _searchTimer = null;
function initSearch() {
  const input = $("#search");
  const clear = $("#clearBtn");
  const run = async () => {
    const q = input.value.trim();
    clear.classList.toggle("show", q.length > 0);
    if (!q) { clearResults(); await loadTree(); return; } // empty: prompt + full browse tree
    try {
      // One query feeds the flat Résultats list, the other the filtered Hiérarchie.
      const [list, treeNodes] = await Promise.all([
        db.search(state.term, q),
        db.searchTree(state.term, q),
      ]);
      renderResults(list, q);
      renderFilteredTree(treeNodes);
    } catch (e) {
      console.error(e);
      const err = `<div class="empty-state"><p>Erreur : ${esc(e.message)}</p></div>`;
      $("#results").innerHTML = err;
      $("#tree").innerHTML = err;
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(run, 180); // debounce
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.classList.remove("show");
    clearResults();
    loadTree();
  });
}

// =================================================================== CONCEPT
// Small nested-set chip (same scale as the breadcrumb crumbs).
function factBlock(k, v) {
  return `<span class="ns-fact"><span class="nk">${esc(k)}</span><span class="nv">${esc(v)}</span></span>`;
}

function attrValue(v) {
  if (v == null || v === "") return `<span class="av null">—</span>`;
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="av null">—</span>`;
    return `<div class="syn-chips">${v.map((x) => `<span class="syn-chip">${esc(x)}</span>`).join("")}</div>`;
  }
  return `<div class="av">${esc(String(v)).replace(/\n/g, "<br>")}</div>`;
}

function highlightTreeSelection(id) {
  document.querySelectorAll("#tree .node-row.selected").forEach((r) => r.classList.remove("selected"));
  const node = document.querySelector(`#tree .node[data-id="${id}"] > .node-row`);
  if (node) node.classList.add("selected");
  document.querySelectorAll("#results .result.active").forEach((r) => r.classList.remove("active"));
  const res = document.querySelector(`#results .result[data-id="${id}"]`);
  if (res) res.classList.add("active");
}

async function selectConcept(id) {
  id = Number(id); // normalize: may arrive as string (dataset) or number
  state.selected = id;
  highlightTreeSelection(id);
  const detail = $("#detail");
  try {
    const c = await db.concept(state.term, id);
    if (!c) { detail.innerHTML = `<div class="detail-empty"><p>Concept introuvable (id ${esc(id)})</p></div>`; return; }
    const cols = await db.extraColumns(state.term);
    const anc = await db.ancestors(state.term, c.lft, c.rgt);
    const par = await db.parents(state.term, c.code);
    const { pct } = fmtFreq(c.freq);

    const crumbs = anc
      .map((a) => `<span class="crumb" data-id="${esc(a.id)}" title="${esc(a.label)}">${esc(a.code)}</span>`)
      .join('<span class="crumb-sep">/</span>');

    // Concepts parents — a code can have several parents (DAG flattened to a tree).
    const parentsHtml = par.length
      ? `<div class="section"><div class="section-h">Concepts parents <span class="cnt">${par.length}</span></div>
           <div class="rel-list">${par
             .map((pp) => `<div class="rel parent" data-id="${esc(pp.id)}" title="${esc(pp.label)}">
               <span class="badge ${badgeClass(pp)}">${esc(pp.code)}</span>
               <span class="rel-label">${esc(pp.label)}</span></div>`)
             .join("")}</div></div>`
      : "";

    // Only show attributes that have a value (skip null / "" / empty arrays).
    const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
    const filledCols = cols.filter((col) => !isEmpty(c[col]));
    const attrs = filledCols
      .map((col) => `<div class="attr"><div class="ak">${esc(col)}</div>${attrValue(c[col])}</div>`)
      .join("");

    detail.innerHTML = `<div class="detail-inner">
      <div class="d-head"><span class="d-code">${esc(c.code)}</span></div>
      <h2 class="d-label">${esc(c.label)}</h2>
      <div class="freq-mini">
        <span class="fm-bar"><i style="width:${pct}%"></i></span>
        <span class="fm-val">${pct} %</span>
      </div>
      ${anc.length ? `<div class="section"><div class="section-h">Hiérarchie</div><div class="d-breadcrumb">${crumbs}</div></div>` : ""}
      <div class="section"><div class="section-h">Position (nested set)</div><div class="ns-facts">
        ${factBlock("depth", c.depth)}${factBlock("lft", c.lft)}${factBlock("rgt", c.rgt)}
      </div></div>
      ${parentsHtml}
      ${filledCols.length ? `<div class="section"><div class="section-h">Attributs</div><div class="attr-list">${attrs}</div></div>` : ""}
    </div>`;

    detail.querySelectorAll(".crumb").forEach((cr) =>
      cr.addEventListener("click", () => selectConcept(cr.dataset.id)));
    detail.querySelectorAll(".rel[data-id]").forEach((r) =>
      r.addEventListener("click", () => selectConcept(r.dataset.id)));
  } catch (e) {
    console.error(e);
    detail.innerHTML = `<div class="detail-empty"><p>Erreur : ${esc(e.message)}</p></div>`;
  }
}

// ====================================================================== BOOT
async function boot() {
  initTheme();
  initSplitters();
  initShortcuts();
  initTabs();
  setTab("tree");
  initSearch();
  $("#collapseBtn").addEventListener("click", () => {
    document.querySelectorAll("#tree .kids.open").forEach((k) => k.classList.remove("open"));
    document.querySelectorAll("#tree .twisty.open").forEach((t) => t.classList.remove("open"));
  });
  try {
    showBootSpinner();
    await db.init();
    state.terms = await db.listTerminologies();
    // Prefer CIM-10 as the default (the headline terminology); fall back to first.
    state.term = (state.terms.find((t) => t.table_name === "cim10") || state.terms[0])?.table_name || null;
    renderTermSelect();
    clearResults();
    clearDetail();
    await loadTree();
    document.body.dataset.ready = "1"; // signal for headless UI harness
  } catch (e) {
    console.error(e);
    fatal("Impossible de charger la base de données.", e.message);
  }
}

boot();
