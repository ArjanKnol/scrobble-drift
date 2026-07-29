/**
 * Local persistence for Scrobble Drift, backed by IndexedDB.
 *
 * WHY: a full-history scan can take an hour, most of it waiting on
 * MusicBrainz at one lookup per second. Losing that to an accidental reload is
 * miserable, and re-running it wastes MusicBrainz's bandwidth for no reason.
 *
 * WHAT IS STORED, and this is the honest list because the UI promises it:
 *   - scrobbles   the fetched history, so an interrupted scan can resume
 *   - lookups     MusicBrainz answers, which never change, so a repeat scan is
 *                 instant instead of taking another hour
 *   - state       which user, how deep, and which page to continue from
 *
 * All of it lives in the visitor's own browser. Nothing is uploaded, and there
 * is no server to upload it to. clearAll() wipes the lot, and the UI exposes a
 * button for it.
 *
 * localStorage is not an option: it caps around 5MB and 139,000 scrobbles is
 * closer to 100MB. IndexedDB quotas are typically a large share of free disk.
 *
 * EVERY function here is best-effort. Storage can be unavailable (private
 * browsing, disabled, quota exhausted) and a failure to persist must never
 * break a scan that is otherwise working. Failures resolve to null or false
 * rather than throwing.
 */

const DB_NAME = "scrobble-drift";
const DB_VERSION = 1;
const CHUNK = 5000;         // scrobbles per record: keeps values a sane size

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);                 // IndexedDB blocked entirely
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("scrobbles")) {
        db.createObjectStore("scrobbles");   // key: `${user}:${chunkIndex}`
      }
      if (!db.objectStoreNames.contains("lookups")) {
        db.createObjectStore("lookups");     // key: `${kind}:${artist}:${name}`
      }
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state");       // key: "scan"
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Wrap one transaction. Resolves to `fallback` on any failure. */
async function tx(storeName, mode, fn, fallback = null) {
  const db = await open();
  if (!db) return fallback;
  return new Promise((resolve) => {
    let t;
    try {
      t = db.transaction(storeName, mode);
    } catch {
      return resolve(fallback);
    }
    let result = fallback;
    t.oncomplete = () => resolve(result);
    // QuotaExceededError lands here. Swallowed on purpose: a scan that cannot
    // save is still a scan that works.
    t.onerror = () => resolve(fallback);
    t.onabort = () => resolve(fallback);
    try {
      fn(t.objectStore(storeName), (v) => { result = v; });
    } catch {
      resolve(fallback);
    }
  });
}

export const available = async () => Boolean(await open());

/* ------------------------------------------------------------- scrobbles */

export async function saveScrobbles(user, rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
  return tx("scrobbles", "readwrite", (store) => {
    // Replace wholesale rather than appending, so a restarted scan cannot
    // interleave with a previous one.
    const clear = store.openCursor();
    clear.onsuccess = () => {
      const cur = clear.result;
      if (cur) {
        if (String(cur.key).startsWith(`${user}:`)) cur.delete();
        cur.continue();
      } else {
        chunks.forEach((c, i) => store.put(c, `${user}:${i}`));
      }
    };
  }, false).then(() => true, () => false);
}

export async function loadScrobbles(user) {
  return tx("scrobbles", "readonly", (store, set) => {
    const out = [];
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        if (String(c.key).startsWith(`${user}:`)) out.push([c.key, c.value]);
        c.continue();
      } else {
        // Sort by chunk index numerically, not lexically: "10" must follow "9".
        out.sort((a, b) => Number(String(a[0]).split(":")[1]) -
                           Number(String(b[0]).split(":")[1]));
        set(out.flatMap(([, v]) => v));
      }
    };
  }, null);
}

/* --------------------------------------------------- MusicBrainz lookups */

/**
 * Cached MusicBrainz answers, with no expiry.
 *
 * Deliberate: release groups, types and dates are historical facts. A cached
 * answer from last month is as good as a fresh one, and this cache is what
 * turns a 50-minute resolution phase into an instant one on the second run.
 */
export async function getLookup(kind, a, b) {
  return tx("lookups", "readonly", (store, set) => {
    const r = store.get(`${kind}:${a}:${b}`.toLowerCase());
    r.onsuccess = () => set(r.result ?? null);
  }, null);
}

export async function putLookup(kind, a, b, value) {
  return tx("lookups", "readwrite", (store) => {
    store.put(value, `${kind}:${a}:${b}`.toLowerCase());
  }, false).then(() => true, () => false);
}

export async function countLookups() {
  return tx("lookups", "readonly", (store, set) => {
    const r = store.count();
    r.onsuccess = () => set(r.result || 0);
  }, 0);
}

/* ------------------------------------------------------------ scan state */

export async function saveState(state) {
  return tx("state", "readwrite", (store) => {
    store.put({ ...state, saved: Date.now() }, "scan");
  }, false).then(() => true, () => false);
}

export async function loadState() {
  return tx("state", "readonly", (store, set) => {
    const r = store.get("scan");
    r.onsuccess = () => set(r.result ?? null);
  }, null);
}

export async function clearState() {
  return tx("state", "readwrite", (store) => store.delete("scan"), false);
}

/* ----------------------------------------------------------------- admin */

/** Wipe everything this site has stored. Backs the "clear data" button. */
export async function clearAll() {
  const db = await open();
  if (!db) return false;
  for (const name of ["scrobbles", "lookups", "state"]) {
    await tx(name, "readwrite", (store) => store.clear(), false);
  }
  return true;
}

/** Rough bytes used, for showing the user what is actually on their disk. */
export async function usage() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage: used, quota } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return null;
  }
}

export const humanBytes = (n) => {
  if (!n && n !== 0) return "unknown";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
