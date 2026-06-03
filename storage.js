// storage.js — persistence for the locally-built DuckDB database.
//
// On the `license` branch the database is NOT shipped: it is built in the browser
// from the data.gouv parquets (build.js) and persisted in the Origin Private File
// System (OPFS) so it is only generated once. DuckDB-WASM reads and writes the
// `opfs://` path natively, so there is no buffer copy: db.js opens it read-only,
// build.js opens it read-write.

export const DB_FILE = "termose.duckdb"; // OPFS entry name
export const DB_PATH = "opfs://termose.duckdb"; // path passed to DuckDB-WASM
const VERSION_KEY = "termose-db-version"; // fingerprint of the baked-in terminology versions

// True once a database has been generated (the OPFS file exists).
export async function dbExists() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (name === DB_FILE) return true;
    }
  } catch {
    /* OPFS unavailable → treat as no DB */
  }
  return false;
}

// Cheap existence probe for a pre-built base at `url`: a HEAD request, falling back
// to a 1-byte ranged GET for servers that reject HEAD. Returns true only on a clearly
// OK response — drives whether the dialog offers the "use an available base" option.
export async function dbUrlExists(url) {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) return true;
    if (head.status !== 405 && head.status !== 501) return false; // real 404/403/…
  } catch {
    /* HEAD unsupported or network hiccup → try a tiny GET below */
  }
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
    return res.ok; // 200 (no range support) or 206 (partial)
  } catch {
    return false;
  }
}

// Download a pre-built database from `url` and install it into OPFS, so a
// deployment (e.g. a local GitLab) can ship `termose.duckdb` instead of having
// every client rebuild it from the parquets. Streams progress via
// onProgress({phase:"download", file, loaded, total}) — same shape as build.js's
// downloadParquet, so the dialog's existing handler renders it unchanged.
// The bytes are a complete (checkpointed) DuckDB file; db.js reopens it read-only.
export async function installDbFromUrl(url, onProgress = () => {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement de la base échoué (HTTP ${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ phase: "download", file: "base", loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }

  // Replace any existing file (and stale WAL) then write the downloaded bytes.
  await clearStoredDb();
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(DB_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

// Remove the generated database (and its WAL) — used before a regeneration.
export async function clearStoredDb() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DB_FILE).catch(() => {});
    await root.removeEntry(DB_FILE + ".wal").catch(() => {});
  } catch {
    /* nothing to remove */
  }
  try { localStorage.removeItem(VERSION_KEY); } catch { /* ignore */ }
}

export function getStoredVersion() {
  try { return localStorage.getItem(VERSION_KEY); } catch { return null; }
}

export function setStoredVersion(version) {
  try { localStorage.setItem(VERSION_KEY, version); } catch { /* ignore */ }
}
