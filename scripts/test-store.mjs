/**
 * Cache retention rules in docs/store.js.
 *
 * The rule being pinned: a POSITIVE answer never expires, a NEGATIVE one expires
 * after thirty days.
 *
 * Positives are historical facts. Once MusicBrainz says Rodeo came out in 2015
 * that will not change, and re-asking spends a one-per-second budget to learn
 * nothing. Negatives are not facts at all, only statements about today, and D14e
 * exists specifically to notice that a leak has since had an official release.
 * Caching absence forever meant that detector could never fire again for anyone
 * who had already scanned: the cache silently switched off the feature.
 *
 * IndexedDB is faked, because the point is the retention logic and not the
 * browser. Run: node scripts/test-store.mjs
 */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)})`);

/* ---- a fake IndexedDB, just enough for store.js -------------------------- */
/*
 * `tx()` resolves on the TRANSACTION's oncomplete, not on each request's
 * onsuccess, so the fake has to fire oncomplete after the operations settle. The
 * first version of this fake only fired request callbacks, and every await hung
 * forever with no error: exactly the failure mode a test double is supposed to
 * avoid producing.
 */
const backing = new Map();

const makeTx = () => {
  const t = { oncomplete: null, onerror: null, onabort: null };
  let pending = 0;
  const done = () => { if (--pending === 0) setTimeout(() => t.oncomplete?.(), 0); };
  const later = (fn) => {
    pending++;
    const r = {};
    setTimeout(() => { fn(r); r.onsuccess?.(); done(); }, 0);
    return r;
  };
  t.objectStore = () => ({
    get:    (k)    => later((r) => { r.result = backing.get(k); }),
    put:    (v, k) => later(() => { backing.set(k, v); }),
    count:  ()     => later((r) => { r.result = backing.size; }),
    delete: (k)    => later(() => { backing.delete(k); }),
    clear:  ()     => later(() => backing.clear()),
  });
  // If the caller queues nothing, the transaction still has to complete.
  setTimeout(() => { if (pending === 0) t.oncomplete?.(); }, 0);
  return t;
};

globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction: () => makeTx(),
      };
      req.onsuccess?.({ target: req });
    }, 0);
    return req;
  },
};

const store = await import("../docs/store.js");
const DAY = 24 * 60 * 60 * 1000;
const settle = () => new Promise((r) => setTimeout(r, 5));

/* ---- positives are kept forever ----------------------------------------- */
{
  backing.clear();
  await store.putLookup("rg", "travis scott", "rodeo",
                        { exists: true, matches: [{ title: "Rodeo" }] });

  // Backdate it by five years. A release date does not rot.
  const k = "rg:travis scott:rodeo";
  backing.set(k, { ...backing.get(k), t: Date.now() - 5 * 365 * DAY });

  const hit = await store.getLookup("rg", "travis scott", "rodeo");
  ok(hit !== null, "a five-year-old POSITIVE answer is still served");
  eq(hit.exists, true, "and is returned unwrapped, exactly as stored");
}

/* ---- negatives expire ---------------------------------------------------- */
{
  backing.clear();
  await store.putLookup("rg", "some artist", "unreleased thing",
                        { exists: false, matches: [], near: [] });
  const k = "rg:some artist:unreleased thing";

  const fresh = await store.getLookup("rg", "some artist", "unreleased thing");
  ok(fresh !== null, "a fresh negative answer is served, so no lookup is wasted");

  backing.set(k, { ...backing.get(k), t: Date.now() - 31 * DAY });
  const stale = await store.getLookup("rg", "some artist", "unreleased thing");
  ok(stale === null,
     "a negative answer older than 30 days is discarded, so D14e can fire");

  backing.set(k, { ...backing.get(k), t: Date.now() - 29 * DAY });
  ok(await store.getLookup("rg", "some artist", "unreleased thing") !== null,
     "and one inside the window is still trusted");
}

/* ---- every shape of "no" is recognised ---------------------------------- */
{
  const negatives = [
    ["found flag",   { found: false, mbid: null }],
    ["exists flag",  { exists: false, matches: [] }],
    ["empty groups", { groups: [] }],
    ["no releases",  { releases: [], total: 0 }],
  ];
  for (const [label, value] of negatives) {
    backing.clear();
    await store.putLookup("k", "a", label);
    backing.set(`k:a:${label}`.toLowerCase(),
                { v: value, t: Date.now() - 40 * DAY });
    ok(await store.getLookup("k", "a", label) === null,
       `an aged negative is expired: ${label}`);
  }

  const positives = [
    ["found true",    { found: true, mbid: "x" }],
    ["exists true",   { exists: true, matches: [{}] }],
    ["some groups",   { groups: [{ title: "x" }] }],
    ["some releases", { releases: [{ title: "x" }], total: 1 }],
  ];
  for (const [label, value] of positives) {
    backing.clear();
    await store.putLookup("k", "a", label);
    backing.set(`k:a:${label}`.toLowerCase(),
                { v: value, t: Date.now() - 5 * 365 * DAY });
    ok(await store.getLookup("k", "a", label) !== null,
       `an aged positive is kept: ${label}`);
  }
}

/* ---- entries written before any of this existed ------------------------- */
{
  backing.clear();
  // The old format: the bare value, no wrapper, no timestamp.
  backing.set("rg:legacy:thing", { exists: true, matches: [{ title: "Old" }] });

  const hit = await store.getLookup("rg", "legacy", "thing");
  ok(hit !== null, "a legacy entry is still readable, so no cache is thrown away");
  eq(hit.exists, true, "and unwrapping does not mangle it");

  await settle();                      // the lazy re-stamp is fire and forget
  const rec = backing.get("rg:legacy:thing");
  ok(rec && "t" in rec && "v" in rec,
     "and it gets stamped with now, starting the clock rather than losing the row");
  ok(Math.abs(Date.now() - rec.t) < 5000, "stamped with the current time");

  // A legacy NEGATIVE must not be expired instantly: on an unreleased-heavy
  // library that would discard thousands of rows and re-fetch at one per second.
  backing.clear();
  backing.set("rg:legacy:neg", { exists: false, matches: [] });
  ok(await store.getLookup("rg", "legacy", "neg") !== null,
     "a legacy negative is kept once, and re-checked thirty days from now");
}

/* ---------------------------------------------------------------------------
 * Storage can fail, but it must never HANG.
 *
 * This module says a storage failure never stops a working scan. That held for
 * errors and not for silence: an await on a request that never settles blocks
 * forever, with nothing on screen to explain it.
 *
 * Seen live. IndexedDB was left wedged by a deleteDatabase issued while the app
 * still held a connection; `indexedDB.open` then stopped answering entirely, the
 * ingest loop blocked on its final save, and the scan sat unchanged for four
 * minutes. Quota exhaustion and private browsing produce the same silence.
 * ------------------------------------------------------------------------- */
{
  const real = globalThis.indexedDB;
  // A database that accepts the open request and then never replies.
  globalThis.indexedDB = { open() { return {}; } };

  const mod = await import("../docs/store.js?wedged=" + Date.now());
  const t = Date.now();
  const got = await mod.getLookup("k", "a", "b");
  const ms = Date.now() - t;

  eq(got, null, "a wedged database returns the fallback rather than hanging");
  ok(ms < 12000, `and gives up in ${(ms / 1000).toFixed(1)}s instead of never`);
  ok(ms > 1000, "  after a real wait, so it is a timeout and not a silent skip");

  globalThis.indexedDB = real;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
