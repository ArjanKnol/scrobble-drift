/**
 * Offline tests for the Worker's pure logic.
 *
 * Only the functions with no I/O: the Spotify-to-MusicBrainz shape adaptation
 * and the comparison normaliser. Everything else in the Worker needs the
 * Cloudflare runtime (caches, rate-limit bindings, secrets) and is verified by
 * deploying, not here.
 *
 * These two are worth testing because they encode accuracy decisions rather
 * than plumbing: get the release-type mapping wrong and d14eReleasedSince
 * silently stops recognising officially released material.
 *
 * Run: node scripts/test-worker.mjs
 */

import { spAlbumToGroup, spNorm } from "../worker/src/index.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};
const eq = (a, b, msg) =>
  ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b),
     `${msg}  (got ${JSON.stringify(a)})`);

const al = (o) => ({ id: "x", name: "T", release_date: "2020-01-01", ...o });

/* ------------------------------------------------------------------------- */
console.log("\nspAlbumToGroup: release type mapping");

eq(spAlbumToGroup(al({ album_type: "album", total_tracks: 14 })).primary,
   "Album", "album_type album maps to Album");

eq(spAlbumToGroup(al({ album_type: "single", total_tracks: 1 })).primary,
   "Single", "a 1-track single is a Single");

eq(spAlbumToGroup(al({ album_type: "single", total_tracks: 2 })).primary,
   "Single", "a 2-track single is still a Single");

// Spotify has no EP type at all, so EPs arrive as album_type "single". Track
// count is the only signal available, and getting this wrong matters: EP is one
// of the three primary types d14eReleasedSince accepts as an official release.
eq(spAlbumToGroup(al({ album_type: "single", total_tracks: 5 })).primary,
   "EP", "a 5-track 'single' is recovered as an EP");

eq(spAlbumToGroup(al({ album_type: "single", total_tracks: 8 })).primary,
   "EP", "8 tracks is the top of the EP band");

eq(spAlbumToGroup(al({ album_type: "single", total_tracks: 9 })).primary,
   "Single", "beyond the band it falls back rather than guessing Album");

/* ------------------------------------------------------------------------- */
console.log("\nspAlbumToGroup: compilations");

{
  const g = spAlbumToGroup(al({ album_type: "compilation", total_tracks: 20 }));
  eq(g.primary, "Album", "a compilation is primary Album...");
  eq(g.secondary, ["Compilation"], "...with a Compilation secondary type");
  // This exact shape is what d0Resolve filters on: it picks the earliest Album
  // that is NOT a compilation, so that a single resolves to the studio album
  // rather than to a greatest-hits package.
  ok(g.secondary.includes("Compilation"),
     "so d0Resolve will skip it when choosing a consolidation target");
}

{
  const g = spAlbumToGroup(al({ album_type: "album", total_tracks: 10 }));
  eq(g.secondary, [], "a plain album carries no secondary types");
}

/* ------------------------------------------------------------------------- */
console.log("\nspAlbumToGroup: status and identity");

{
  const g = spAlbumToGroup(al({ album_type: "album", total_tracks: 1, id: "abc" }));
  // Everything on Spotify is a licensed commercial release, which is what
  // MusicBrainz means by Official. d14eReleasedSince filters on exactly this.
  eq(g.status, "Official", "status is Official, matching the MusicBrainz vocabulary");
  eq(g.rg_id, "spotify:abc", "ids are namespaced so they cannot collide with MBIDs");
  eq(g.source, "spotify", "the source is recorded for provenance");
}

{
  // The Worker reads al.name; the browser-side index re-emits it as al.title.
  // Both paths must work or catalogue rehydration silently loses every title.
  eq(spAlbumToGroup(al({ name: "Rodeo" })).title, "Rodeo", "reads .name");
  eq(spAlbumToGroup({ id: "x", title: "Rodeo" }).title, "Rodeo",
     "and prefers .title when already adapted");
}

{
  const g = spAlbumToGroup(al({ total_tracks: 0 }));
  eq(g.total_tracks, null, "a zero track count becomes null, not 0");
  eq(g.primary, "Album", "and an unknown album_type defaults to Album");
}

/* ------------------------------------------------------------------------- */
console.log("\nspNorm: must agree with drift.js norm()");

const { norm } = await import("../docs/drift.js");
for (const s of ["Travis Scott", "JAŸ-Z", "Beyoncé", "A$AP Rocky",
                 "Tyler, The Creator", "  spaced   out  ", "Kanye  West",
                 "MØ", "Café", "$uicideboy$", "21 Savage"]) {
  eq(spNorm(s), norm(s), `agrees on ${JSON.stringify(s)}`);
}

// The consequence of disagreement: the Worker rejects an artist match that the
// browser would have accepted, so the catalogue silently comes back empty and
// every one of that artist's tracks falls through to the slow path.
eq(spNorm("Sef"), "sef", "short names normalise cleanly");
ok(spNorm("Sefyu") !== spNorm("Sef"),
   "and stay distinct, so fuzzy search results are correctly rejected");

/* ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * The shared MusicBrainz answer cache.
 *
 * MusicBrainz allows one request per second per application and blocks IPs that
 * exceed it. The only pacing that existed was a 1/s limiter in each visitor's
 * BROWSER, which is per tab, so thirty concurrent visitors made thirty requests
 * a second from Cloudflare IPs under one shared User-Agent.
 *
 * `mbShared` is the layer that actually fixes that, by making a second lookup of
 * the same artist cost nothing. It is worth testing here rather than by deploying
 * because it encodes two decisions that would be invisible if wrong:
 *
 *   - a FAILURE must never be cached, or one outage is served for thirty days
 *   - a NEGATIVE answer must BE cached, because "MusicBrainz has never heard of
 *     this" is a real, stable answer and unreleased material is the whole point
 *
 * A fake D1 stands in for the real one. It records every call, so the tests can
 * assert on what was written rather than only on what was returned.
 * ------------------------------------------------------------------------- */
{
  const { mbShared, chargeMb } = await import("../worker/src/index.js");

  /** Minimal D1 double: same call shape as the real binding. */
  const fakeD1 = ({ rows = new Map(), failRead = false, failWrite = false } = {}) => {
    const log = { reads: 0, writes: 0 };
    return {
      rows, log,
      prepare(sql) {
        const isRead = /^SELECT/i.test(sql.trim());
        let args = [];
        const stmt = {
          bind(...a) { args = a; return stmt; },
          async first(col) {
            log.reads++;
            if (failRead) throw new Error("d1 unavailable");
            if (/COUNT/i.test(sql)) return rows.size;
            const [k, cutoff] = args;
            const hit = rows.get(k);
            if (!hit || hit.created <= cutoff) return null;
            return col ? hit[col] : { v: hit.v };
          },
          async run() {
            log.writes++;
            if (failWrite) throw new Error("d1 read-only");
            const [k, v, created] = args;
            rows.set(k, { v, created });
            return { success: true };
          },
        };
        return stmt;
      },
    };
  };

  const now = () => Math.floor(Date.now() / 1000);

  // ---- a miss produces, a hit does not ----------------------------------- //
  {
    const db = fakeD1();
    let produced = 0;
    const produce = async () => { produced++; return { found: true, mbid: "x" }; };

    const a = await mbShared({ MB_CACHE: db }, "aid:kanye west", produce);
    eq(a.shared, false, "first call is a miss");
    eq(a.body.mbid, "x", "and returns the produced answer");
    eq(produced, 1, "producing happened exactly once");

    const b = await mbShared({ MB_CACHE: db }, "aid:kanye west", produce);
    eq(b.shared, true, "second call is served from the shared cache");
    eq(b.body.mbid, "x", "with the same answer");
    eq(produced, 1, "and MusicBrainz was NOT asked again");
    eq(db.log.writes, 1, "only the miss wrote a row");
  }

  // ---- a failure must never be cached ------------------------------------ //
  {
    const db = fakeD1();
    let calls = 0;
    const boom = async () => { calls++; throw new Error("musicbrainz http 503"); };

    let threw = false;
    try { await mbShared({ MB_CACHE: db }, "cat:abc:0", boom); }
    catch { threw = true; }
    ok(threw, "a failing lookup propagates rather than being swallowed");
    eq(db.log.writes, 0, "and writes NOTHING: an outage must not be cached");
    eq(db.rows.size, 0, "the table stays empty");

    // The next visitor must get a real attempt, not a cached error.
    const ok2 = await mbShared({ MB_CACHE: db }, "cat:abc:0",
                               async () => ({ releases: [] }));
    eq(ok2.shared, false, "so the next caller still reaches MusicBrainz");
    eq(calls, 1, "and the failed attempt was not retried inside mbShared");
  }

  // ---- a negative answer IS cached --------------------------------------- //
  {
    const db = fakeD1();
    let produced = 0;
    const notFound = async () => { produced++; return { found: false, mbid: null }; };

    await mbShared({ MB_CACHE: db }, "aid:some leaked mixtape", notFound);
    const second = await mbShared({ MB_CACHE: db }, "aid:some leaked mixtape", notFound);
    eq(second.shared, true, "'MusicBrainz has never heard of this' is cached");
    eq(second.body.found, false, "and the negative answer survives the round trip");
    eq(produced, 1,
       "genuinely unreleased material costs one lookup ever, not one per scan");
  }

  // ---- staleness --------------------------------------------------------- //
  {
    const db = fakeD1();
    // Written 40 days ago, past the 30-day freshness window.
    db.rows.set("cat:old:0", {
      v: JSON.stringify({ releases: ["stale"] }),
      created: now() - 40 * 86400,
    });
    const r = await mbShared({ MB_CACHE: db }, "cat:old:0",
                             async () => ({ releases: ["fresh"] }));
    eq(r.shared, false, "a row older than the TTL is not used");
    eq(r.body.releases[0], "fresh", "and is replaced with a fresh answer");

    db.rows.set("cat:new:0", {
      v: JSON.stringify({ releases: ["recent"] }),
      created: now() - 3 * 86400,
    });
    const r2 = await mbShared({ MB_CACHE: db }, "cat:new:0",
                              async () => ({ releases: ["should not run"] }));
    eq(r2.shared, true, "a row inside the TTL is used");
    eq(r2.body.releases[0], "recent", "and returns the cached answer");
  }

  // ---- the cache is an optimisation, never a dependency ------------------ //
  {
    // No binding at all: the state the Worker deploys in before D1 is created.
    let produced = 0;
    const r = await mbShared({}, "aid:x", async () => { produced++; return { a: 1 }; });
    eq(r.shared, false, "with no MB_CACHE binding it is a pass-through");
    eq(r.body.a, 1, "and still answers");
    eq(produced, 1, "by asking MusicBrainz, exactly as before");

    // A broken cache must degrade to asking MusicBrainz, not fail the request.
    const bad = fakeD1({ failRead: true });
    const r2 = await mbShared({ MB_CACHE: bad }, "aid:y",
                              async () => ({ a: 2 }));
    eq(r2.body.a, 2, "a read fault degrades to a live lookup");
    eq(r2.shared, false, "and reports itself as not shared");

    const bad2 = fakeD1({ failWrite: true });
    const r3 = await mbShared({ MB_CACHE: bad2 }, "aid:z",
                              async () => ({ a: 3 }));
    eq(r3.body.a, 3, "a write fault still returns the answer");
  }

  // ---- chargeMb fails open, consistently with the other limiters --------- //
  {
    let threw = false;
    try { await chargeMb({}, "1.2.3.4"); } catch { threw = true; }
    ok(!threw, "no limiter bindings means no throw, so a fresh deploy works");

    const deny = { limit: async () => ({ success: false }) };
    let msg = "";
    try { await chargeMb({ RL_MB: deny }, "1.2.3.4"); }
    catch (e) { msg = e.message; }
    ok(/MusicBrainz/.test(msg) && /one request per second/.test(msg),
       "a denied per-visitor budget explains WHY, naming the real constraint");

    msg = "";
    try { await chargeMb({ RL_MB_SHARED: deny }, "1.2.3.4"); }
    catch (e) { msg = e.message; }
    ok(/findings are unaffected/.test(msg),
       "and a denied shared budget says the findings still stand");
  }
}

console.log(`\n${pass} passed, ${fail} failed (including MusicBrainz cache block)\n`);
process.exit(fail ? 1 : 0);
