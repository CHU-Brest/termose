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
