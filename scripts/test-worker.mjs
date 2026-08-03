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
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/* ---------------------------------------------------------------------------
 * Spotify rejects an explicit `limit` above 5.
 *
 * Not documented, and it is stranger than a plain cap: limit=20 is refused on the
 * artist-albums endpoint even though 20 is the DEFAULT Spotify applies when the
 * parameter is omitted. So the parameter itself is being validated, not the
 * number, and every rejection said exactly {"status":400,"message":"Invalid
 * limit"} and nothing about `market` or `include_groups`.
 *
 * The cost of getting this wrong is invisible rather than loud. Every catalogue
 * call 400s, so Spotify resolves nothing, every lookup falls through to
 * MusicBrainz at one request per second, and the only symptom is that release
 * lookups take hours. It was reported as "Spotify: 0 of 289 tracks resolved" and
 * read as a configuration problem.
 *
 * So it is asserted on the source, because the failure is silent and the obvious
 * "optimisation" of raising the page size to 50 reintroduces it. The temporary
 * /api/spotify/diag block is excluded: it contains the broken shape deliberately,
 * as a control.
 * ------------------------------------------------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");

  /*
   * The temporary /api/spotify/diag probe has been removed now that it has
   * answered its question. This asserts it is gone, because a debug endpoint that
   * enumerates upstream request shapes has no business on a public Worker, and
   * "remove it later" is how it would have stayed.
   */
  ok(!/DIAG-BEGIN|spotify\/diag/.test(src),
     "the temporary diagnostic endpoint is gone from the Worker");
  const live = src;

  /*
   * Scanned over a WINDOW around each `limit=`, not line by line.
   *
   * The line-by-line version of this check passed while the bug was present. A
   * request path is built from several concatenated template literals:
   *
   *     `/artists/${hit.id}/albums?include_groups=album,single,compilation` +
   *     `&limit=50&market=${SP_MARKET}`
   *
   * so the line holding `limit=50` contains no path at all and matched nothing. I
   * only found that out by putting the bug back and watching the test stay green,
   * which is the sole reason this comment exists.
   *
   * MusicBrainz legitimately uses limit=25 and limit=100 and must not be flagged.
   * Its URLs always carry `fmt=json`, which Spotify's never do, so that is the
   * discriminator rather than a list of paths.
   */
  /*
   * 10, established by probing the live API one value at a time: 6, 8 and 10 are
   * accepted, 15 and 50 are refused. Omitting the parameter gives pages of 5,
   * not the documented 20, so neither the ceiling nor the default matches the
   * documentation and both had to be measured.
   */
  const SP_LIMIT_CEILING = 10;
  ok(new RegExp(`const SP_PAGE = ${SP_LIMIT_CEILING};`).test(live),
     `SP_PAGE is pinned to the probed ceiling of ${SP_LIMIT_CEILING}`);

  const offenders = [];
  for (const m of live.matchAll(/limit=(\d+)/g)) {
    if (Number(m[1]) <= SP_LIMIT_CEILING) continue;
    const around = live.slice(Math.max(0, m.index - 250), m.index + 250);
    const isMusicBrainz = /fmt=json|\/ws\/2|\$\{MB\}/.test(around);
    const isSpotify = /SP_MARKET|\/search\?type=|\/artists\/|\/albums\?/.test(around);
    if (isSpotify && !isMusicBrainz) {
      offenders.push(around.split("\n").find((l) => l.includes(m[0]))?.trim() || m[0]);
    }
  }
  ok(offenders.length === 0,
     offenders.length
       ? `Spotify refuses these: ${offenders.join("  |  ")}`
       : `no Spotify call sends an explicit limit above ${SP_LIMIT_CEILING}`);

  // Prove the check can actually fail, on a copy of the real broken line.
  {
    const broken = live.replace("&limit=${SP_PAGE}&market=", "&limit=50&market=");
    let caught = 0;
    for (const m of broken.matchAll(/limit=(\d+)/g)) {
      if (Number(m[1]) <= SP_LIMIT_CEILING) continue;
      const around = broken.slice(Math.max(0, m.index - 250), m.index + 250);
      if (/SP_MARKET|\/search\?type=|\/artists\//.test(around) &&
          !/fmt=json|\/ws\/2/.test(around)) caught++;
    }
    ok(caught > 0,
       "and the check catches limit=50 when it is reintroduced on a continuation line");
  }

  // The paging loop must not follow Spotify's own `next` URL, because Spotify
  // builds it WITH the limit it used. Following it would 400 on page two, which
  // only shows up for artists with more than 20 releases: the case that matters.
  const albumsFn = live.slice(live.indexOf("async function spArtistAlbums"));
  const body = albumsFn.slice(0, albumsFn.indexOf("\n}"));
  ok(!/page\.next\s*\?/.test(body) && !/page\.next\.replace/.test(body),
     "the album loop does not follow page.next, which embeds the rejected limit");
  ok(/offset=/.test(body), "it pages by offset instead");
  ok(/page\.total|\.total\b/.test(body),
     "and bounds itself on the reported total rather than trusting next");

  // Paging is concurrent now, so there is no loop to terminate. What matters
  // instead is that the offsets are derived from a reported total and bounded,
  // and that overlapping pages cannot duplicate albums.
  ok(/Promise\.all/.test(body), "remaining pages are fetched concurrently");
  ok(/CONCURRENCY/.test(body),
     "with a bounded batch size, so one artist cannot burst twenty requests");
  ok(/step > 0/.test(body),
     "a zero-length first page stops it, so a malformed reply cannot loop");
  ok(/new Set\(\)/.test(body) && /seen\.has/.test(body),
     "and pages are de-duplicated on id, since offsets are arithmetic against " +
     "a catalogue that can shift mid-read");
  ok(/SP_ALBUM_CAP/.test(body), "the album cap is still enforced");

  // market and include_groups were proven innocent, so they must stay: dropping
  // include_groups would pull in `appears_on` compilations and make almost
  // anything look officially released.
  ok(/include_groups=album,single,compilation/.test(body),
     "include_groups is still sent, so appears_on stays excluded");
  ok(/market=\$\{SP_MARKET\}/.test(body),
     "market is still sent, which keeps available_markets out of the response");
}

/* ---------------------------------------------------------------------------
 * An error response must never be cacheable.
 *
 * Observed live: with the Spotify fix deployed and provably working, the same URL
 * kept returning the old 400 while the identical URL plus one throwaway query
 * parameter returned data. The failure had been cached and was being served over
 * a working Worker, which looks exactly like "the deploy did not land" and cost a
 * round of confusion chasing the wrong thing.
 *
 * A success is a fact and may be cached. A failure describes one moment and must
 * not be. This project has now been bitten by a cached negative three times.
 * ------------------------------------------------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");

  // The 502 path.
  const m502 = src.match(/error: "upstream failure",[\s\S]{0,400}?\}, 502, ([^;]+)\);/);
  ok(Boolean(m502), "the 502 handler is found");
  ok(m502 && /no-store/.test(m502[1]),
     "the 502 response sets Cache-Control: no-store");

  // The 429 path, which also carries Retry-After and so is easy to forget.
  const m429 = src.match(/retry_after: err\.retryAfter \}, 429,([\s\S]{0,220}?)\);/);
  ok(Boolean(m429), "the 429 handler is found");
  ok(m429 && /no-store/.test(m429[1]),
     "the 429 response sets no-store too, so a rate-limit reply is not pinned");
  ok(m429 && /Retry-After/.test(m429[1]),
     "and still sends Retry-After, which the client honours exactly");

  // Successes must stay cacheable, or the shared cache is pointless.
  ok(/"Cache-Control": "public, max-age=86400"/.test(src),
     "successful lookups remain cacheable");

  /*
   * /api/health is the exception among successes. It reports what is deployed and
   * which bindings are live, and it WAS cacheable: a client that had asked once
   * kept getting the old answer, which produced a reading where `build` had
   * vanished and `mb_cache` was false straight after a deploy that had succeeded.
   * The obvious reading was that the deploy had rolled back. Anything describing
   * current state must not be cached.
   */
  const health = src.slice(src.indexOf('/api/health'),
                           src.indexOf('/api/lastfm'));
  ok(/no-store/.test(health),
     "/api/health sets no-store, so it cannot report a stale deployment");
  ok(!/public, max-age/.test(health),
     "and is not marked publicly cacheable");
  ok(/build: BUILD/.test(health) && /mb_cache:/.test(health),
     "while still reporting the build and whether the cache is wired up");
}

/* ---------------------------------------------------------------------------
 * The build marker.
 *
 * Exists because three rounds of debugging were lost to a deployed Worker being
 * older than the source, and each time the symptom was indistinguishable from a
 * real bug. Behaviour cannot answer "is the running code current?" when behaviour
 * is the thing in question, so /api/health states it outright.
 * ------------------------------------------------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");
  const m = src.match(/const BUILD = "([^"]+)"/);
  ok(Boolean(m), "a BUILD constant exists");
  ok(m && /^\d{4}-\d{2}-\d{2}/.test(m[1]),
     `and starts with a date so staleness is obvious at a glance (${m?.[1]})`);
  /*
   * Checked against GIT, not against a string written here.
   *
   * This used to assert that BUILD matched a literal in this file, which cannot
   * catch a forgotten bump: it only catches a bump that disagrees with a second
   * constant you also had to remember to update. Both were then missed in the same
   * edit, the Worker shipped reporting a stale version, and the marker whose entire
   * purpose is answering "is the running code current" gave the wrong answer.
   *
   * The invariant that actually matters: if worker/src/index.js differs from HEAD,
   * BUILD must differ from HEAD's BUILD too. That needs no second constant and no
   * memory. Skipped rather than failed where git is unavailable, because a missing
   * git is not a bug in the Worker.
   */
  let headSrc = null;
  try {
    headSrc = execFileSync("git", ["show", "HEAD:worker/src/index.js"],
      // fileURLToPath, not URL.pathname: this repo's path contains a space, and
      // pathname hands back "Last.fm%20app", which git cannot chdir into. The
      // check then skipped silently, which is how a guard passes while testing
      // nothing.
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"] });
  } catch { /* no git, no HEAD, or a fresh repo */ }

  if (headSrc === null) {
    ok(true, "BUILD-vs-git check skipped: git or HEAD unavailable");
  } else if (headSrc === src) {
    ok(true, "the Worker matches HEAD, so BUILD needs no bump");
  } else {
    const headBuild = headSrc.match(/const BUILD = "([^"]+)"/)?.[1];
    ok(m[1] !== headBuild,
       `worker/src/index.js changed, so BUILD must change too ` +
       `(HEAD ${JSON.stringify(headBuild)}, now ${JSON.stringify(m?.[1])})`);
  }
  ok(/build: BUILD/.test(src), "and /api/health reports it");
}

/* ---------------------------------------------------------------------------
 * Spotify goes through the same shared cache, and the batch size is back to 20.
 *
 * The catalogue is the expensive thing in a scan: about eight round trips per
 * artist, byte-identical for every visitor, and the answer to every release
 * question about that artist. It was cached only in the browser and at the
 * Cloudflare edge, and the edge cache is per LOCATION, so the same artist could
 * be fetched once per datacentre and a new visitor paid full price for artists
 * thousands of people had already looked up.
 *
 * SP_BATCH was 10 as a workaround for the `available_markets` CPU blowup, which
 * was actually fixed by pinning a market on that call. The halved batch then sat
 * there costing twice the requests for a reason that no longer existed.
 * ------------------------------------------------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");

  // ---- the batch size ---------------------------------------------------- //
  ok(/const SP_BATCH = 20;/.test(src),
     "SP_BATCH is back to Spotify's documented maximum of 20");
  const tracksFn = src.slice(src.indexOf("async function spAlbumTracks"));
  const tracksBody = tracksFn.slice(0, tracksFn.indexOf("\n}"));
  ok(/market=\$\{SP_MARKET\}/.test(tracksBody),
     "and the tracklist call still pins a market, which is what makes 20 safe");

  // ---- every Spotify endpoint is cached ---------------------------------- //
  for (const fn of ["spTrack", "spArtistAlbums", "spAlbumTracks", "spAlbum"]) {
    const at = src.indexOf(`async function ${fn}(`);
    ok(at > 0, `${fn} exists`);
    const body = src.slice(at, src.indexOf("\n}", at));
    ok(/spShared\(/.test(body), `${fn} answers from the shared cache`);
  }

  // ---- the two upstreams share one table but not one namespace ----------- //
  ok(/sharedCache\(env, `sp:\$\{key\}`/.test(src),
     "Spotify keys are namespaced with sp:, so they cannot collide with MusicBrainz");
  ok(/const SP_TTL_DAYS = 7;/.test(src) && /const MB_TTL_DAYS = 30;/.test(src),
     "Spotify expires sooner than MusicBrainz, because catalogues actually change");

  // ---- the per-track endpoint is a DROP-IN for the MusicBrainz one ------- //
  const trackAt = src.indexOf("async function spTrack(");
  const trackBody = src.slice(trackAt, src.indexOf("\n}", trackAt));
  ok(/return \{ groups \}/.test(trackBody),
     "spTrack returns { groups }, the same shape as /api/mb/recording");
  ok(/spNorm\(t\.name\) === wantTrack/.test(trackBody) &&
     /spNorm\(a\.name\) === wantArtist/.test(trackBody),
     "and requires an exact normalised match on BOTH track and artist");
  ok(!/limit=/.test(trackBody),
     "it sends no explicit limit, which Spotify refuses above 10");
  ok(/first_release \|\| "9999"/.test(trackBody),
     "earliest edition wins, so a deluxe reissue cannot shadow the original");

  ok(/url\.pathname === "\/api\/spotify\/track"/.test(src),
     "and it is actually routed");
}

/* ---------------------------------------------------------------------------
 * A failed page must not discard the pages that already worked.
 *
 * Seen live: a deep scan reached 128,000 of 250,000 scrobbles and Last.fm returned
 * HTTP 500 on a high page number. Only `Retryable` was handled that way, so a
 * rate limit resumed gracefully while a plain 500 threw and took the seven
 * already-fetched pages of the batch with it, ending a fifteen-minute run.
 *
 * `fetched` tracks the last page that actually worked and `next` is derived from
 * it, so keeping the partial batch also hands back the exact resume point.
 * ------------------------------------------------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf("async function scrobbles(");
  const body = src.slice(at, src.indexOf("\n}", at));

  ok(/if \(out\.length\) \{ stoppedAt = page; break; \}/.test(body),
     "a non-retryable upstream error keeps the pages already collected");
  ok(/if \(out\.length\) break;/.test(body),
     "and a rate limit still does the same");

  // Throwing on an empty batch is what stops a no-progress request from becoming
  // a silent empty response the client would loop on forever.
  const errBlock = body.slice(body.indexOf("} catch (err) {"));
  ok(/throw err;/.test(errBlock),
     "but a batch that collected nothing still throws, so no-progress is an error");

  ok(/partial_at: stoppedAt/.test(body),
     "the response says where it was cut short, so the scan can report turbulence");
  ok(/next: fetched < totalPages \? fetched \+ 1 : null/.test(body),
     "and `next` still derives from the last page that worked, giving the resume point");

  // The client half: 5xx deserves more patience than 4xx.
  const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
  ok(/res\.status >= 500 \? 6 : 3/.test(html),
     "the client retries a 5xx more times than a 4xx, which will not fix itself");
  ok(/pages_retried/.test(html),
     "and a scan that hit turbulence says so rather than reporting a clean run");
}

/* ---- the `to` window on /api/scrobbles ---------------------------------- */
{
  const src = await readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8");
  const at = src.indexOf("async function scrobbles(");
  const body = src.slice(at, src.indexOf("\n}", at));

  ok(/if \(to\) params\.to = to;/.test(body),
     "the timestamp window is forwarded to Last.fm when supplied");
  ok(/\^\\d\{1,11\}\$/.test(body),
     "and validated as digits only, so nothing arbitrary reaches the query string");
  ok(/: null;/.test(body.slice(body.indexOf("const to ="))),
     "an invalid value becomes null rather than being passed through");

  // It must stay optional: a normal scan sends no `to` at all.
  ok(/params\.to = to;/.test(body) && !/params\.to = to \|\|/.test(body),
     "no `to` means an unwindowed query, which is the normal path");
}

console.log(`\n${pass} passed, ${fail} failed (including MusicBrainz cache block)\n`);
process.exit(fail ? 1 : 0);
