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
/*
 * Every storage call resolves, even if IndexedDB never answers.
 *
 * This file says storage is best-effort and that a failure never stops a working
 * scan. That was true for errors and false for silence: an `await` on a request
 * that never settles hangs the scan forever, with no error and nothing on screen
 * to explain it.
 *
 * Seen live. A `deleteDatabase` issued while the app still held an open connection
 * left IndexedDB wedged: `indexedDB.open` stopped answering at all, the ingest
 * loop blocked on its final `saveScrobbles`, and the scan sat at "Fetching 3,200
 * of 2,000 scrobbles" indefinitely. The trigger was a test harness, but quota
 * exhaustion, private browsing and a corrupted profile all produce the same
 * silence, and the app would hang identically for a real user.
 *
 * Eight seconds is far longer than any real transaction here and short enough that
 * a wedged database degrades to "no cache" rather than "no scan".
 */
const TX_TIMEOUT_MS = 8000;

const withTimeout = (promise, fallback) => new Promise((resolve) => {
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; resolve(v); } };
  const timer = setTimeout(() => done(fallback), TX_TIMEOUT_MS);
  promise.then((v) => { clearTimeout(timer); done(v); },
               () => { clearTimeout(timer); done(fallback); });
});

async function tx(storeName, mode, fn, fallback = null) {
  return withTimeout(txInner(storeName, mode, fn, fallback), fallback);
}

async function txInner(storeName, mode, fn, fallback = null) {
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
/*
 * How long a cached answer is allowed to live.
 *
 * A POSITIVE answer never expires, and that is not laziness: a release group, its
 * type and its first release date are historical facts. Once MusicBrainz says
 * Rodeo came out in 2015 that will not change, and re-asking would spend a
 * one-per-second budget to be told the same thing.
 *
 * A NEGATIVE answer is completely different, and treating the two the same was a
 * bug. "MusicBrainz has never heard of this" is only ever a statement about
 * today. D14e exists precisely to notice that a leak has since had an official
 * release, so caching its absence forever guaranteed that the one detector whose
 * whole job is to spot a change over time could never fire again for anyone who
 * had already scanned. The cache silently disabled the feature.
 *
 * Same family as every other bug in this project: an absent answer recorded as a
 * permanent fact.
 */
const NEG_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 days

/**
 * Does this answer mean "not found"?
 *
 * Judged from the VALUE rather than from a flag written alongside it, so that
 * entries stored before any of this existed are classified correctly too. Each
 * shape below is one of the four lookup kinds' way of saying no.
 */
const isNegative = (v) =>
  Boolean(v) && typeof v === "object" && (
    v.found === false || v.exists === false ||
    (Array.isArray(v.groups) && v.groups.length === 0) ||
    (Array.isArray(v.releases) && v.releases.length === 0)
  );

const KEY = (kind, a, b) => `${kind}:${a}:${b}`.toLowerCase();

export async function getLookup(kind, a, b) {
  const rec = await tx("lookups", "readonly", (store, set) => {
    const r = store.get(KEY(kind, a, b));
    r.onsuccess = () => set(r.result ?? null);
  }, null);
  if (rec == null) return null;

  // Wrapped records carry a timestamp. Anything else was written before this
  // existed, so its age is unknown.
  const wrapped = typeof rec === "object" && rec !== null &&
                  "v" in rec && "t" in rec;
  if (!wrapped) {
    /*
     * Legacy entry. Stamped with NOW rather than discarded.
     *
     * Discarding every un-aged negative would be the strictly correct reading,
     * but on an unreleased-heavy library most entries are negative and that
     * would throw away thousands of answers and re-fetch them at one per second.
     * Starting the clock now costs nothing, keeps the cache, and means the
     * thirty-day re-check happens from here on. The only thing lost is one cycle
     * of freshness for entries that were already stale, which is the cheapest
     * possible way out of a mistake that was already made.
     */
    putLookup(kind, a, b, rec);            // fire and forget, never awaited
    return rec;
  }

  if (isNegative(rec.v) && Date.now() - rec.t > NEG_TTL_MS) return null;
  return rec.v;
}

export async function putLookup(kind, a, b, value) {
  return tx("lookups", "readwrite", (store) => {
    // `t` is what makes the negative TTL above possible. The value itself is
    // nested rather than annotated, so a stored answer is never confused with
    // its own metadata.
    store.put({ v: value, t: Date.now() }, KEY(kind, a, b));
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
