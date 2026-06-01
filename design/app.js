/* ===================================================================
   Explorateur SMT — logique applicative (vanilla)
   =================================================================== */
(function () {
  "use strict";

  /* ---------- petites aides DOM ---------- */
  const $ = (s) => document.querySelector(s);
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const norm = (s) => stripAccents(String(s).toLowerCase());

  /* ---------- fréquence d'utilisation (synthétique, déterministe) ---------- */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // les concepts réellement codés (feuilles) ressortent plus que les regroupements
  const FREQ_BASE = { chapter: 7000, block: 11000, category: 21000, subcategory: 31000, subchapter: 11000, paragraph: 14000, acte: 25000 };
  function computeFreq(code, type) {
    const raw = (hashStr(code) % 10000) / 10000;
    const base = FREQ_BASE[type] || 12000;
    return Math.round(base * (0.06 + 0.94 * raw * raw));
  }
  function fmtCompact(n) {
    if (n >= 1000) {
      const k = n / 1000;
      return (k >= 10 ? String(Math.round(k)) : String(Math.round(k * 10) / 10).replace(".", ",")) + " k";
    }
    return String(n);
  }
  const fmtFull = (n) => n.toLocaleString("fr-FR");
  const freqScore = (model, n) => Math.round((n.freq / model.maxFreq) * 100);
  function freqLabel(score) {
    if (score >= 60) return ["Très fréquent", "vf"];
    if (score >= 30) return ["Fréquent", "f"];
    if (score >= 10) return ["Peu fréquent", "p"];
    return ["Rare", "r"];
  }

  /* ---------- colonnes (attributs) propres à chaque terminologie ---------- */
  // au-delà des colonnes structurelles (code, label, path, depth, left, right)
  const COLUMN_SPECS = {
    cim10: [
      ["type", (n) => n.type],
      ["domain", (n, m) => { const a = ancestors(m, n.code); return a.length ? a[0].label : n.label; }],
      ["synonymes", (n) => n.syn],
      ["inclusion_note", (n) => n.inc],
      ["exclusion_note", (n) => n.exc],
    ],
    ccam: [
      ["type", (n) => n.type],
      ["topographie", (n) => n.topo],
      ["mode_acces", (n) => n.mode],
      ["definition", (n) => n.def],
    ],
  };

  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  /* ---------- modèle : nested set (comme smt2parquet) ---------- */
  const modelCache = {};
  function buildModel(key) {
    if (modelCache[key]) return modelCache[key];
    const term = TERMINOLOGIES[key];
    const nodes = [];
    const byCode = new Map();
    let counter = 1;
    function visit(raw, parent) {
      const node = {
        code: raw.c, label: raw.l, type: raw.t,
        syn: raw.syn || [], inc: raw.inc || null, exc: raw.exc || null,
        topo: raw.topo || null, mode: raw.mode || null, def: raw.def || null,
        parent: parent ? parent.code : null,
        depth: parent ? parent.depth + 1 : 0,
        children: [], lft: counter++,
      };
      node.path = (parent ? parent.path + "/" : "") + node.code;
      nodes.push(node);
      byCode.set(node.code, node);
      if (parent) parent.children.push(node.code);
      (raw.ch || []).forEach((ch) => visit(ch, node));
      node.rgt = counter++;
    }
    term.tree.forEach((r) => visit(r, null));
    nodes.forEach((n) => { n.freq = computeFreq(n.code, n.type); });
    const maxFreq = nodes.reduce((mx, n) => Math.max(mx, n.freq), 1);
    const m = { term, key, nodes, byCode, maxFreq };
    modelCache[key] = m;
    return m;
  }

  const descCount = (n) => (n.rgt - n.lft - 1) / 2;
  function ancestors(model, code) {
    const arr = [];
    let n = model.byCode.get(code);
    while (n && n.parent) { n = model.byCode.get(n.parent); arr.unshift(n); }
    return arr;
  }

  /* ---------- état ---------- */
  const state = {
    termKey: "cim10",
    model: null,
    selected: null,
    expanded: new Set(),
    query: "",
    scope: new Set(), // types désactivés (vide = tous actifs)
  };

  /* ---------- éléments ---------- */
  const treeEl = $("#tree");
  const resultsEl = $("#results");
  const resultsMetaEl = $("#resultsMeta");
  const detailEl = $("#detail");
  const searchEl = $("#search");
  const clearBtn = $("#clearBtn");
  const rowRefs = new Map(); // code -> {row, kids, twisty}

  /* ============================================================
     TOP BAR : sélecteur de terminologie + métadonnées
     ============================================================ */
  function renderTermSelect() {
    const sel = document.querySelector("#termSelect");
    sel.innerHTML = "";
    Object.keys(TERMINOLOGIES).forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = TERMINOLOGIES[k].name;
      o.title = TERMINOLOGIES[k].longName;
      if (k === state.termKey) o.selected = true;
      sel.appendChild(o);
    });
  }
  function renderMetaChip() {
    const m = state.model.term.meta;
    $("#metaChip").innerHTML =
      `<b>${esc(state.model.nodes.length.toLocaleString("fr-FR"))}</b> concepts` +
      ` &nbsp;·&nbsp; v.${esc(m.version)}`;
  }

  /* ============================================================
     SCOPE (filtres par type)
     ============================================================ */
  function renderScope() {
    const row = $("#scopeRow");
    row.innerHTML = "";
    const types = state.model.term.types;
    const shortLabel = { subcategory: "Sous-cat.", subchapter: "Sous-chap." };
    Object.keys(types).forEach((t) => {
      const chip = el("button", "scope-chip", shortLabel[t] || types[t]);
      chip.setAttribute("aria-pressed", String(!state.scope.has(t)));
      chip.onclick = () => {
        if (state.scope.has(t)) state.scope.delete(t); else state.scope.add(t);
        // jamais tout désactiver
        if (state.scope.size >= Object.keys(types).length) state.scope.clear();
        chip.setAttribute("aria-pressed", String(!state.scope.has(t)));
        renderScope();
        renderResults();
      };
      row.appendChild(chip);
    });
  }

  /* ============================================================
     ARBRE
     ============================================================ */
  function buildTree() {
    treeEl.innerHTML = "";
    rowRefs.clear();
    state.model.term.tree.forEach((raw) => treeEl.appendChild(makeNode(raw.c)));
  }

  function makeNode(code) {
    const n = state.model.byCode.get(code);
    const wrap = el("div", "node");

    const row = el("div", "node-row" + (n.type === "chapter" ? " is-chapter" : ""));
    row.dataset.code = code;
    row.style.paddingLeft = 8 + n.depth * 18 + "px";

    const tw = el("div", "twisty" + (n.children.length ? "" : " leaf"), CHEVRON);
    const badge = el("span", "badge " + n.type, esc(n.code));
    const label = el("span", "node-label", esc(n.label));
    label.title = n.label;
    row.append(tw, badge, label);

    const kids = el("div", "kids");
    n.children.forEach((c) => kids.appendChild(makeNode(c)));

    tw.onclick = (e) => { e.stopPropagation(); toggle(code); };
    row.onclick = () => selectNode(code);

    wrap.append(row, kids);
    rowRefs.set(code, { row, kids, twisty: tw });
    return wrap;
  }

  function toggle(code, force) {
    const ref = rowRefs.get(code);
    if (!ref || ref.twisty.classList.contains("leaf")) return;
    const open = force != null ? force : !state.expanded.has(code);
    if (open) state.expanded.add(code); else state.expanded.delete(code);
    ref.kids.classList.toggle("open", open);
    ref.twisty.classList.toggle("open", open);
  }

  function applyExpansion() {
    rowRefs.forEach((ref, code) => {
      const open = state.expanded.has(code);
      ref.kids.classList.toggle("open", open);
      ref.twisty.classList.toggle("open", open);
    });
  }

  function expandAll() {
    state.model.nodes.forEach((n) => { if (n.children.length) state.expanded.add(n.code); });
    applyExpansion();
  }
  function collapseAll() {
    state.expanded.clear();
    applyExpansion();
  }

  function highlightSelectedRow() {
    rowRefs.forEach((ref, code) => ref.row.classList.toggle("selected", code === state.selected));
  }

  function revealInTree(code, flash) {
    ancestors(state.model, code).forEach((a) => toggle(a.code, true));
    const ref = rowRefs.get(code);
    if (!ref) return;
    requestAnimationFrame(() => {
      const r = ref.row.getBoundingClientRect();
      const t = treeEl.getBoundingClientRect();
      treeEl.scrollTop += r.top - t.top - treeEl.clientHeight / 2 + r.height / 2;
      if (flash) {
        ref.row.classList.remove("flash");
        void ref.row.offsetWidth;
        ref.row.classList.add("flash");
      }
    });
  }

  /* ============================================================
     SÉLECTION + DÉTAIL
     ============================================================ */
  function selectNode(code, fromSearch) {
    state.selected = code;
    highlightSelectedRow();
    renderDetail();
    revealInTree(code, true);
    if (!fromSearch) {
      // refléter la sélection dans la liste si présente
      resultsEl.querySelectorAll(".result").forEach((r) =>
        r.classList.toggle("active", r.dataset.code === code));
    }
  }

  function renderDetail() {
    if (!state.selected) {
      detailEl.innerHTML = "";
      const empty = el("div", "detail-empty");
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/><path d="M12 7v4M12 11H6.5a1 1 0 0 0-1 1v3.5M12 11h5.5a1 1 0 0 1 1 1v3.5"/></svg>' +
        "<p>Sélectionnez un concept dans l’arbre ou la liste de résultats pour afficher ses détails.</p>";
      detailEl.appendChild(empty);
      return;
    }
    const n = state.model.byCode.get(state.selected);
    const root = el("div", "detail-inner");

    // head
    const head = el("div", "d-head");
    head.append(el("span", "d-code", esc(n.code)));
    root.appendChild(head);
    root.appendChild(el("h2", "d-label", esc(n.label)));

    // score discret sous le label
    const sScore = freqScore(state.model, n);
    const dScore = el("div", "d-score");
    dScore.title = "Fréquence d'utilisation relative";
    dScore.innerHTML =
      '<span class="d-score-bar"><i style="width:' + sScore + '%"></i></span>' +
      '<span class="d-score-txt">Usage : ' + sScore + " %</span>";
    root.appendChild(dScore);

    // chemin (path)
    root.appendChild(section("Chemin", null, () => {
      const bc = el("div", "d-breadcrumb");
      const anc = ancestors(state.model, n.code);
      anc.forEach((a) => {
        const c = el("span", "crumb", esc(a.code));
        c.title = a.label;
        c.onclick = () => selectNode(a.code);
        bc.appendChild(c);
        bc.appendChild(el("span", "crumb-sep", "/"));
      });
      bc.appendChild(el("span", "crumb current", esc(n.code)));
      return bc;
    }));

    // score (fréquence d'utilisation)
    // (affiché discrètement sous le label, voir .d-score)

    // position : depth / left / right
    root.appendChild(section("Position dans l’arbre · nested set", null, () => {
      const g = el("div", "facts");
      g.appendChild(fact("depth", n.depth));
      g.appendChild(fact("left", n.lft));
      g.appendChild(fact("right", n.rgt));
      return g;
    }));

    // enfants directs (premier niveau)
    if (n.children.length) {
      root.appendChild(section("Enfants directs", n.children.length, () => {
        const box = el("div", "rel-list");
        n.children.forEach((cc) => {
          const c = state.model.byCode.get(cc);
          const rel = el("div", "rel");
          rel.append(
            el("span", "badge " + c.type, esc(c.code)),
            el("span", "rel-label", esc(c.label)),
            el("span", "rel-arrow", ARROW)
          );
          rel.onclick = () => selectNode(c.code);
          box.appendChild(rel);
        });
        return box;
      }));
    }

    // colonnes du concept (attributs propres à la terminologie)
    const specs = COLUMN_SPECS[state.termKey] || [];
    if (specs.length) {
      root.appendChild(section("Colonnes du concept", specs.length, () => {
        const box = el("div", "attr-list");
        specs.forEach(([key, getter]) => {
          const v = getter(n, state.model);
          const row = el("div", "attr");
          const av = el("div", "av");
          if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) {
            av.classList.add("null");
            av.textContent = "null";
          } else if (Array.isArray(v)) {
            av.textContent = v.join(", ");
          } else {
            av.textContent = v;
          }
          row.append(el("div", "ak", esc(key)), av);
          box.appendChild(row);
        });
        return box;
      }));
    }

    detailEl.innerHTML = "";
    detailEl.appendChild(root);
    detailEl.scrollTop = 0;
  }

  function section(title, count, builder, countOverride) {
    const s = el("div", "section");
    const h = el("div", "section-h");
    h.appendChild(document.createTextNode(title));
    const c = countOverride != null ? countOverride : count;
    if (c != null) h.appendChild(el("span", "cnt", String(c)));
    s.appendChild(h);
    s.appendChild(builder());
    return s;
  }
  function rawSection(node) { const s = el("div", "section"); s.appendChild(node); return s; }
  function noteBlock(kind, tag, text) {
    const n = el("div", "note " + kind);
    n.append(el("span", "note-tag", tag), document.createTextNode(text));
    return n;
  }
  function fact(k, v) {
    const f = el("div", "fact");
    f.append(el("div", "k", k), el("div", "v", String(v)));
    return f;
  }
  function relArrowUp() {
    const s = el("span", "rel-arrow");
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
    return s;
  }

  /* ============================================================
     RECHERCHE + RÉSULTATS
     ============================================================ */
  function scopeActive(type) { return !state.scope.has(type); }

  function renderResults() {
    const q = norm(state.query.trim());
    resultsEl.innerHTML = "";

    if (!q) {
      // état initial : parcourir les chapitres
      const roots = state.model.nodes.filter((n) => n.depth === 0);
      resultsMetaEl.innerHTML = `<b>Parcourir</b> · ${roots.length} ${roots.length > 1 ? "racines" : "racine"}`;
      roots.forEach((n) => resultsEl.appendChild(resultItem(n, null)));
      return;
    }

    const matches = [];
    state.model.nodes.forEach((n) => {
      if (!scopeActive(n.type)) return;
      const codeN = norm(n.code), labelN = norm(n.label);
      let field = null, synHit = null, rank = 99;
      if (codeN === q) { field = "code"; rank = 0; }
      else if (codeN.startsWith(q)) { field = "code"; rank = 1; }
      else if (labelN.startsWith(q)) { field = "label"; rank = 2; }
      else if (codeN.includes(q)) { field = "code"; rank = 3; }
      else if (labelN.includes(q)) { field = "label"; rank = 4; }
      else {
        synHit = n.syn.find((s) => norm(s).includes(q));
        if (synHit) { field = "syn"; rank = 5; }
      }
      if (field) matches.push({ n, rank, synHit });
    });
    matches.sort((a, b) => a.rank - b.rank || b.n.freq - a.n.freq || a.n.lft - b.n.lft);

    resultsMetaEl.innerHTML = matches.length
      ? `<b>${matches.length}</b> résultat${matches.length > 1 ? "s" : ""} pour « ${esc(state.query.trim())} »`
      : `Aucun résultat`;

    if (!matches.length) {
      const e = el("div", "empty-state");
      e.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>' +
        "<p>Aucun concept ne correspond.<br>Vérifiez les filtres de type ou essayez un autre terme.</p>";
      resultsEl.appendChild(e);
      return;
    }
    matches.slice(0, 300).forEach((m) => resultsEl.appendChild(resultItem(m.n, q, m.synHit)));
  }

  function hl(text, q) {
    if (!q) return esc(text);
    const i = norm(text).indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function resultItem(n, q, synHit) {
    const item = el("div", "result");
    item.dataset.code = n.code;
    if (n.code === state.selected) item.classList.add("active");

    const top = el("div", "r-top");
    const badge = el("span", "badge " + n.type);
    badge.innerHTML = hl(n.code, q);
    const label = el("span", "r-label");
    label.innerHTML = hl(n.label, q);
    top.append(badge, label);
    item.appendChild(top);

    if (synHit) {
      const syn = el("div", "r-syn");
      syn.innerHTML = "« " + hl(synHit, q) + " »";
      item.appendChild(syn);
    }

    const foot = el("div", "r-foot");
    const anc = ancestors(state.model, n.code);
    const path = el("div", "r-path", anc.length ? esc(anc.map((a) => a.code).join(" / ")) : "");
    const freq = el("span", "freq");
    freq.title = "Fréquence d'utilisation estimée : " + fmtFull(n.freq) + " / an";
    freq.innerHTML = '<span class="freq-val">' + esc(fmtCompact(n.freq)) + "</span>";
    foot.append(path, freq);
    item.appendChild(foot);

    item.onclick = () => {
      selectNode(n.code, true);
      resultsEl.querySelectorAll(".result").forEach((r) => r.classList.toggle("active", r.dataset.code === n.code));
    };
    return item;
  }

  /* ============================================================
     TERMINOLOGIE
     ============================================================ */
  function switchTerm(key) {
    if (key === state.termKey && state.model) return;
    state.termKey = key;
    state.model = buildModel(key);
    state.selected = null;
    state.expanded = new Set();
    state.scope = new Set();
    state.query = "";
    searchEl.value = "";
    clearBtn.classList.remove("show");
    // déplier les racines par défaut
    state.model.nodes.forEach((n) => { if (n.depth === 0 && n.children.length) state.expanded.add(n.code); });
    renderTermSelect();
    renderMetaChip();
    buildTree();
    applyExpansion();
    renderResults();
    renderDetail();
  }

  /* ============================================================
     SPLITTERS (colonnes redimensionnables)
     ============================================================ */
  function initResizers() {
    const main = document.querySelector(".main");
    document.querySelectorAll(".splitter").forEach((sp) => {
      sp.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const which = sp.dataset.resize;
        sp.classList.add("dragging");
        try { sp.setPointerCapture(e.pointerId); } catch (err) {}
        const cs = getComputedStyle(document.documentElement);
        const startX = e.clientX;
        const startLeft = parseFloat(cs.getPropertyValue("--panel-left")) || 400;
        const startRight = parseFloat(cs.getPropertyValue("--panel-right")) || 412;
        const mainW = main.getBoundingClientRect().width;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";

        function move(ev) {
          const dx = ev.clientX - startX;
          if (which === "left") {
            let w = startLeft + dx;
            w = Math.max(240, Math.min(w, mainW - startRight - 220));
            document.documentElement.style.setProperty("--panel-left", w + "px");
          } else {
            let w = startRight - dx;
            w = Math.max(280, Math.min(w, mainW - startLeft - 220));
            document.documentElement.style.setProperty("--panel-right", w + "px");
          }
        }
        function up() {
          sp.classList.remove("dragging");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    });
  }

  /* ============================================================
     THÈME
     ============================================================ */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("smt-theme", t); } catch (e) {}
  }
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  };

  /* ============================================================
     INIT
     ============================================================ */
  function init() {
    try {
      const saved = localStorage.getItem("smt-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) {}

    searchEl.addEventListener("input", () => {
      state.query = searchEl.value;
      clearBtn.classList.toggle("show", !!searchEl.value);
      renderResults();
    });
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = resultsEl.querySelector(".result");
        if (first) first.click();
      }
      if (e.key === "Escape") { searchEl.value = ""; state.query = ""; clearBtn.classList.remove("show"); renderResults(); }
    });
    clearBtn.onclick = () => { searchEl.value = ""; state.query = ""; clearBtn.classList.remove("show"); renderResults(); searchEl.focus(); };

    $("#collapseBtn").onclick = collapseAll;
    document.querySelector("#termSelect").onchange = (e) => switchTerm(e.target.value);
    initResizers();

    switchTerm("cim10");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // exposé pour le panneau Tweaks
  window.SMT = { state, applyTheme };
})();
