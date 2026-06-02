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
  current: null, // { code, label } of the concept shown in the panel (for the cart button)
};

// ----------------------------------------------------------- keyboard shortcuts
function initShortcuts() {
  // Hint the Ctrl/⌘+K shortcut in the placeholder, with the platform-correct modifier.
  const input = $("#search");
  const isApple = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
  input.placeholder = `${isApple ? "⌘K" : "Ctrl+K"} : ${input.placeholder}`;

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); // Ctrl/⌘+K → focus the search bar
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

// Known licence → deed URL, so the footer links to the right deed whatever the
// per-terminology licence is (meta only carries the licence name).
const LICENSE_URLS = {
  "CC BY-NC-ND 3.0 IGO": "https://creativecommons.org/licenses/by-nc-nd/3.0/igo/",
  "CC BY-ND 3.0 IGO": "https://creativecommons.org/licenses/by-nd/3.0/igo/",
  "CC BY 3.0 IGO": "https://creativecommons.org/licenses/by/3.0/igo/",
  LOv2: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
  "Licence Ouverte 2.0": "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
};

// Footer attribution for the active terminology.
function renderFooterCredit() {
  const box = $("#footAttrib");
  if (!box) return;
  const t = state.terms.find((x) => x.table_name === state.term);
  if (!t || (!t.source && !t.license)) { box.innerHTML = ""; return; }
  const name = `<b>${esc(t.table_name.toUpperCase())}</b>`;
  const parts = [t.version ? `${name} ${esc(t.version)}` : name];
  if (t.source) {
    parts.push("Source : " + (t.url
      ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.source)}</a>`
      : esc(t.source)));
  }
  if (t.license) {
    const licUrl = LICENSE_URLS[t.license];
    parts.push(licUrl
      ? `<a href="${esc(licUrl)}" target="_blank" rel="noopener">${esc(t.license)}</a>`
      : esc(t.license));
  }
  box.innerHTML = parts.join(" · ");
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
  state.current = null;
  $("#cartMenu").hidden = true;
  refreshCart(); // badge/menu follow the active terminology
  renderFooterCredit();
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

// ----------------------------------------------------------------- cart
// Per-terminology basket of concept codes, persisted in localStorage.
const CART_KEY = "termose-cart";
let cart = (() => { try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; } })();
const saveCart = () => localStorage.setItem(CART_KEY, JSON.stringify(cart));
const cartCodes = () => Object.keys(cart[state.term] || {});
const inCart = (code) => !!(cart[state.term] && Object.prototype.hasOwnProperty.call(cart[state.term], code));

function addToCart(code, label) {
  (cart[state.term] ||= {})[code] = label;
  saveCart();
  refreshCart();
}
function removeFromCart(code) {
  if (cart[state.term]) { delete cart[state.term][code]; saveCart(); refreshCart(); }
}
function clearCart() {
  cart[state.term] = {};
  saveCart();
  refreshCart();
}

function refreshCart() {
  const codes = cartCodes();
  const badge = $("#cartBadge");
  badge.textContent = String(codes.length);
  badge.hidden = codes.length === 0;
  if (!$("#cartMenu").hidden) renderCartMenu();
  // keep the concept-panel button label in sync if a concept is shown
  const btn = $("#conceptCartBtn");
  if (btn && state.current) {
    const on = inCart(state.current.code);
    btn.classList.toggle("in-cart", on);
    btn.textContent = on ? "✓ Dans le panier" : "Ajouter au panier";
  }
  $("#cartBtn").classList.toggle("has-items", codes.length > 0);
}

function renderCartMenu() {
  const map = cart[state.term] || {};
  const codes = Object.keys(map);
  $("#cartCount").textContent = `(${codes.length}) · ${(state.term || "").toUpperCase()}`;
  const box = $("#cartItems");
  box.innerHTML = "";
  if (!codes.length) {
    box.innerHTML = `<div class="cart-empty">Panier vide. Ajoutez un concept depuis le panneau de droite.</div>`;
    return;
  }
  codes.forEach((code) => {
    const item = el("div", "cart-item");
    item.innerHTML =
      `<span class="badge category">${esc(code)}</span>` +
      `<span class="ci-label" title="${esc(map[code])}">${esc(map[code])}</span>` +
      `<button class="ci-rm" title="Retirer" aria-label="Retirer">×</button>`;
    item.querySelector(".ci-rm").addEventListener("click", () => removeFromCart(code));
    box.appendChild(item);
  });
}

async function copyText(text, btn) {
  const original = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copié ✓"; }
  catch { btn.textContent = "Échec copie"; }
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function initCart() {
  const menu = $("#cartMenu");
  $("#cartBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) renderCartMenu();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest(".cart-wrap")) menu.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
  $("#cartCopyList").addEventListener("click", (e) => copyText(cartCodes().join("\n"), e.currentTarget));
  $("#cartCopySql").addEventListener("click", (e) =>
    copyText("code IN (" + cartCodes().map((c) => `'${c.replace(/'/g, "''")}'`).join(", ") + ")", e.currentTarget));
  $("#cartClear").addEventListener("click", () => clearCart());
}
// Placeholder shown in the right column toolbar when no concept is displayed.
const CRUMBS_PLACEHOLDER = `<span class="col-title">Concept</span>`;
function resetCrumbs() {
  $("#conceptCrumbs").innerHTML = CRUMBS_PLACEHOLDER;
  $("#conceptCartBtn").hidden = true;
}

function clearDetail() {
  resetCrumbs();
  $("#detail").innerHTML =
    `<div class="detail-empty"><p>Sélectionnez un concept dans l'arbre ou la liste de résultats pour afficher ses détails.</p></div>`;
}

// ====================================================================== TREE
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

// Colour the code badge by depth (generic across terminologies). A distinct hue per
// depth (OKLCH ramp, L/C fixed in CSS); 28° step → no repeat up to adicap's max depth
// (12) and beyond. The badge carries the hue via the `--hue` custom property.
const depthHue = (depth) => (265 + (Number(depth) || 0) * 28) % 360;

function nodeRow(n) {
  const node = el("div", "node");
  node.dataset.id = n.id; // integer id is the unique identifier (code is not unique in adicap)
  const isLeaf = n.rgt - n.lft <= 1; // nested-set: leaf has no descendants
  const row = el("div", "node-row" + (n.depth === 0 ? " is-chapter" : ""));
  row.innerHTML =
    `<span class="twisty${isLeaf ? " leaf" : ""}">${CHEVRON}</span>` +
    `<span class="badge" style="--hue:${depthHue(n.depth)}">${esc(n.code)}</span>` +
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
    `<span class="badge" style="--hue:${depthHue(n.depth)}">${esc(n.code)}</span>` +
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
// A 0..1 ratio (freq_rel / freq_abs) as a clamped 0..100 percentage for a bar width.
function fmtFreq(ratio) {
  return { pct: Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100))) };
}

// Absolute popularity for the concept panel: the raw subtree count + its global share.
// freq_abs is often < 1 %, so keep extra decimals near zero rather than rounding to 0.
function fmtAbs(c) {
  const absPct = (Number(c.freq_abs) || 0) * 100;
  const pctStr = absPct === 0 ? "0" : absPct < 0.1 ? absPct.toFixed(3) : absPct.toFixed(1);
  return { count: Number(c.concept_count || 0).toLocaleString("fr-FR"), pctStr };
}

function resultItem(n) {
  const item = el("div", "result");
  item.dataset.id = n.id; // identity = integer id; code is display-only
  const { pct } = fmtFreq(n.freq_rel);
  item.innerHTML =
    `<div class="r-top">` +
      `<span class="badge" style="--hue:${depthHue(n.depth)}">${esc(n.code)}</span>` +
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
      // One matched set feeds both the flat Résultats list and the filtered Hiérarchie.
      const { list, tree } = await db.searchBoth(state.term, q);
      renderResults(list, q);
      renderFilteredTree(tree);
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
    if (!c) { resetCrumbs(); detail.innerHTML = `<div class="detail-empty"><p>Concept introuvable (id ${esc(id)})</p></div>`; return; }
    state.current = { code: c.code, label: c.label }; // for the cart button
    const cols = await db.extraColumns(state.term);
    const anc = await db.ancestors(state.term, c.lft, c.rgt);
    const par = await db.parents(state.term, c.code);
    const kids = await db.children(state.term, c.path, c.depth); // first-level children only
    const { pct } = fmtFreq(c.freq_rel); // bar = share within the parent node
    const abs = fmtAbs(c); // absolute popularity: raw count + global share

    // Fréquence section: usage count, share within the parent (featured bar), global
    // share. Shown only when usage data is loaded (concept_count > 0) — otherwise a
    // muted note rather than three meaningless zeros (graceful degradation).
    const freqSection = c.concept_count > 0
      ? `<div class="section"><div class="section-h">Fréquence</div>
           <div class="freq-line">
             <div class="freq-thin" title="Fréquence relative (part du parent)"><i style="width:${pct}%"></i></div>
             <div class="ns-facts">
               ${factBlock("relative", pct + " %")}
               ${factBlock("globale", abs.pctStr + " %")}
               ${factBlock("utilisations", abs.count)}
             </div>
           </div></div>`
      : `<div class="section"><div class="section-h">Fréquence</div>
           <div class="freq-empty">Aucune donnée d'usage chargée pour ce concept.</div></div>`;

    // Breadcrumb shown in the right column toolbar: clickable ancestors then the
    // current concept as a trailing, non-clickable `current` crumb.
    const ancCrumbs = anc
      .map((a) => `<span class="crumb" data-id="${esc(a.id)}" title="${esc(a.label)}">${esc(a.code)}</span>`)
      .join('<span class="crumb-sep"></span>');
    const currentCrumb = `<span class="crumb current" title="${esc(c.label)}">${esc(c.code)}</span>`;
    const crumbs = (ancCrumbs ? ancCrumbs + '<span class="crumb-sep"></span>' : "") + currentCrumb;

    // Concepts parents — a code can have several parents (DAG flattened to a tree).
    const parentsHtml = par.length
      ? `<div class="section"><div class="section-h">Concepts parents <span class="cnt">${par.length}</span></div>
           <div class="rel-list">${par
             .map((pp) => `<div class="rel parent" data-id="${esc(pp.id)}" title="${esc(pp.label)}">
               <span class="badge" style="--hue:${depthHue(pp.depth)}">${esc(pp.code)}</span>
               <span class="rel-label">${esc(pp.label)}</span></div>`)
             .join("")}</div></div>`
      : "";

    // Concepts enfants — first-level children only (mirror of the parents section).
    const childrenHtml = kids.length
      ? `<div class="section"><div class="section-h">Concepts enfants <span class="cnt">${kids.length}</span></div>
           <div class="rel-list">${kids
             .map((k) => {
               const kp = fmtFreq(k.freq_rel).pct; // share of this child within the current node
               return `<div class="rel" data-id="${esc(k.id)}" title="${esc(k.label)}">
               <span class="badge" style="--hue:${depthHue(k.depth)}">${esc(k.code)}</span>
               <span class="rel-label">${esc(k.label)}</span>
               <span class="rel-freq"><span class="freq-bar"><i style="width:${kp}%"></i></span>
               <span class="freq-val">${kp}%</span></span></div>`;
             })
             .join("")}</div></div>`
      : "";

    // Only show attributes that have a value (skip null / "" / empty arrays).
    const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
    const filledCols = cols.filter((col) => !isEmpty(c[col]));
    const attrs = filledCols
      .map((col) => `<div class="attr"><div class="ak">${esc(col)}</div>${attrValue(c[col])}</div>`)
      .join("");

    detail.innerHTML = `<div class="detail-inner">
      <div class="d-head">
        <span class="d-code">${esc(c.code)}</span>
      </div>
      <h2 class="d-label">${esc(c.label)}</h2>
      ${freqSection}
      <div class="section"><div class="section-h">Position (nested set)</div><div class="ns-facts">
        ${factBlock("depth", c.depth)}${factBlock("lft", c.lft)}${factBlock("rgt", c.rgt)}
      </div></div>
      ${parentsHtml}
      ${childrenHtml}
      ${filledCols.length ? `<div class="section"><div class="section-h">Attributs</div><div class="attr-list">${attrs}</div></div>` : ""}
    </div>`;

    const crumbsBar = $("#conceptCrumbs");
    crumbsBar.innerHTML = crumbs;
    crumbsBar.querySelectorAll(".crumb[data-id]").forEach((cr) =>
      cr.addEventListener("click", () => selectConcept(cr.dataset.id)));
    detail.querySelectorAll(".rel[data-id]").forEach((r) =>
      r.addEventListener("click", () => selectConcept(r.dataset.id)));

    // Cart button lives in the toolbar (persistent element): set state + handler.
    // `.onclick` assignment (not addEventListener) avoids stacking listeners across selections.
    const cartBtn = $("#conceptCartBtn");
    cartBtn.hidden = false;
    cartBtn.classList.toggle("in-cart", inCart(c.code));
    cartBtn.textContent = inCart(c.code) ? "✓ Dans le panier" : "Ajouter au panier";
    cartBtn.onclick = () => {
      if (inCart(c.code)) removeFromCart(c.code);
      else addToCart(c.code, c.label);
    };
  } catch (e) {
    console.error(e);
    resetCrumbs();
    detail.innerHTML = `<div class="detail-empty"><p>Erreur : ${esc(e.message)}</p></div>`;
  }
}

// ============================================== generate-database modal
// Single status line that advances over time (idle → download → transform → done/error).
function setStatus(state, text) {
  $("#genStatus").dataset.state = state;
  $("#genStatusText").textContent = text;
}
function resetStatus() {
  setStatus("idle", "En attente du lancement…");
}

// Three-step dialog: 1 = options (intro + frequencies), 2 = licences, 3 = progress.
let _genView = 1;
function showGenView(n) {
  _genView = n;
  $("#genView1").hidden = n !== 1;
  $("#genView2").hidden = n !== 2;
  $("#genView3").hidden = n !== 3;
  $("#genDbNext").hidden = n !== 1;
  $("#genDbAccept").hidden = n !== 2;
  $("#genDbStart").hidden = n !== 3;
  $("#genDbBack").hidden = n === 1;
}

// Render the licence view from build.js's TERMINOLOGIES (single source of truth);
// the module is already cached via db.js, so this does not refetch duckdb.
let _licensesRendered = false;
async function renderLicenses() {
  if (_licensesRendered) return;
  const { TERMINOLOGIES } = await import("./build.js" + (_v ? `?v=${_v}` : ""));
  $("#licenseList").innerHTML = TERMINOLOGIES.map((t) => {
    const deed = LICENSE_URLS[t.license];
    const lic = deed
      ? `<a href="${esc(deed)}" target="_blank" rel="noopener">${esc(t.license)}</a>`
      : esc(t.license);
    const src = t.sourceUrl
      ? `<a href="${esc(t.sourceUrl)}" target="_blank" rel="noopener">${esc(t.source)}</a>`
      : esc(t.source);
    return `<li class="license-item">
      <div class="lic-head"><span class="lic-name">${esc(t.name.toUpperCase())}</span><span class="lic-ver">${esc(t.version)}</span></div>
      <div class="lic-row"><span class="k">Source :</span> ${src}</div>
      <div class="lic-row"><span class="k">Licence :</span> ${lic}</div>
    </li>`;
  }).join("");
  _licensesRendered = true;
}

function logLine(msg) {
  const log = $("#genLog");
  log.textContent += (log.textContent ? "\n" : "") + msg;
  log.scrollTop = log.scrollHeight;
}

const GEN_LOG_IDLE = "En attente du lancement…";
function openGenDb() {
  $("#genError").hidden = true;
  resetStatus();
  $("#genLog").textContent = GEN_LOG_IDLE;
  $("#genDbStart").disabled = false;
  $("#genDbStart").classList.add("modal-primary"); // restore the primary accent
  $("#genDbBack").disabled = false;
  $("#genDbCancel").classList.remove("modal-primary"); // drop the post-build accent
  showGenView(1);
  $("#genDbOverlay").hidden = false;
}
function closeGenDb() {
  $("#genDbOverlay").hidden = true;
}

async function runGenDb() {
  const startBtn = $("#genDbStart");
  const backBtn = $("#genDbBack");
  startBtn.disabled = true;
  backBtn.disabled = true; // no navigating back mid-build
  let ok = false;
  $("#genError").hidden = true;
  $("#genLog").textContent = "";
  setStatus("download", "Téléchargement…");
  logLine("Démarrage de la génération…");

  const done = {};
  const onProgress = (p) => {
    if (p.phase === "download") {
      setStatus("download", "Téléchargement…");
      if (p.total && p.loaded >= p.total && !done[p.file]) {
        done[p.file] = true;
        logLine(`✓ ${p.file} téléchargé (${(p.total / 1024 / 1024).toFixed(1)} Mo)`);
      }
    } else if (p.phase === "transform") {
      setStatus("transform", "Transformation…");
    } else if (p.phase === "log") {
      logLine(p.message);
    } else if (p.phase === "done") {
      setStatus("done", "Terminé");
      logLine("✓ Base prête.");
    }
  };

  try {
    const { generateDatabase } = await import("./build.js" + (_v ? `?v=${_v}` : ""));
    const freqFile = $("#freqFile").files[0] || undefined;
    await db.reset(); // release any read-only OPFS handle (regeneration) — exclusive access
    await db.clearStoredDb(); // remove the old file before rebuilding
    await generateDatabase({ onProgress, freqFile });
    await loadDatabase(); // re-open the freshly built DB read-only (app ready behind the modal)
    ok = true;
    // Build done: the freshly stored fingerprint now matches DB_VERSION, so the header
    // button is no longer stale — clear the amber immediately (don't wait on the async
    // checkDbStale fired inside loadDatabase).
    document.body.dataset.dbStale = "0";
    // Lock "Retour"/"Générer la base" and make "Fermer" the primary action (the only
    // thing left to do is close the dialog). Drop "Générer"'s primary accent so it reads
    // as a plain disabled button (like "Retour"), not a faded green one. Leave the dialog
    // open so the log stays readable.
    startBtn.classList.remove("modal-primary");
    $("#genDbCancel").classList.add("modal-primary");
  } catch (e) {
    console.error(e);
    setStatus("error", "Erreur");
    logLine("✗ Erreur : " + e.message);
    $("#genError").textContent = "Erreur : " + e.message;
    $("#genError").hidden = false;
  } finally {
    // On failure, re-enable so the user can retry; on success, keep them disabled.
    if (!ok) { startBtn.disabled = false; backBtn.disabled = false; }
  }
}

function initGenDb() {
  const overlay = $("#genDbOverlay");
  $("#genDbBtn").addEventListener("click", openGenDb);
  $("#genDbClose").addEventListener("click", closeGenDb);
  $("#genDbCancel").addEventListener("click", closeGenDb);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGenDb(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeGenDb(); });
  $("#genDbNext").addEventListener("click", async () => { await renderLicenses(); showGenView(2); });
  $("#genDbAccept").addEventListener("click", () => showGenView(3));
  $("#genDbBack").addEventListener("click", () => showGenView(_genView - 1));
  $("#genDbStart").addEventListener("click", runGenDb);
  $("#freqFile").addEventListener("change", updateFreqName);
}

// Reflect the chosen frequencies file next to the custom "Choisir un fichier" button.
function updateFreqName() {
  const f = $("#freqFile").files[0];
  const el = $("#freqName");
  el.textContent = f ? f.name : "Aucun fichier";
  el.classList.toggle("has-file", !!f);
}

// Shown when no database has been generated yet (DB_MISSING): invite the user to
// build it, and open the modal so the primary action is one click away.
function showDbMissing() {
  $("#tree").innerHTML =
    `<div class="empty-state">
       <p><b>Base non générée</b></p>
       <p>Générez la base pour télécharger les terminologies et la construire dans votre navigateur.</p>
       <p><button class="btn" id="genDbInline" style="border:1px solid var(--border)">Générer la base</button></p>
     </div>`;
  $("#genDbInline")?.addEventListener("click", openGenDb);
  openGenDb();
}

// ====================================================================== BOOT
// Flag the loaded DB as stale when its stored fingerprint differs from the current
// DB_VERSION (data OR schema changed since it was built) — drives the alert dot on the
// generate button. Lazy-import build.js (same ?v= pattern as renderLicenses) so boot
// stays light; getStoredVersion is re-exported by db.js. Non-blocking / best-effort.
async function checkDbStale() {
  try {
    const { DB_VERSION } = await import("./build.js" + (_v ? `?v=${_v}` : ""));
    const stale = db.getStoredVersion() !== DB_VERSION;
    document.body.dataset.dbStale = stale ? "1" : "0";
    $("#genDbBtn").title = stale
      ? "Mise à jour disponible — régénérez la base"
      : "Générer la base de données";
  } catch { /* non-critical: leave the button as-is */ }
}

async function loadDatabase() {
  try {
    showBootSpinner();
    await db.init();
    state.terms = await db.listTerminologies();
    // Prefer CIM-10 as the default (the headline terminology); fall back to first.
    state.term = (state.terms.find((t) => t.table_name === "cim10") || state.terms[0])?.table_name || null;
    renderTermSelect();
    renderFooterCredit();
    refreshCart();
    clearResults();
    clearDetail();
    await loadTree();
    checkDbStale(); // fire-and-forget: light up the generate button if the DB is stale
    document.body.dataset.ready = "1"; // signal for headless UI harness
  } catch (e) {
    if (e && e.code === "DB_MISSING") { showDbMissing(); return; }
    console.error(e);
    fatal("Impossible de charger la base de données.", e.message);
  }
}

async function boot() {
  initTheme();
  initSplitters();
  initShortcuts();
  initTabs();
  initCart();
  initGenDb();
  setTab("tree");
  initSearch();
  $("#collapseBtn").addEventListener("click", () => {
    document.querySelectorAll("#tree .kids.open").forEach((k) => k.classList.remove("open"));
    document.querySelectorAll("#tree .twisty.open").forEach((t) => t.classList.remove("open"));
  });
  await loadDatabase();
}

boot();
