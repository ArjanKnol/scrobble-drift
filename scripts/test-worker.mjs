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
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
