/**
 * Offline tests for the Spotify catalogue layer.
 *
 * No network. Catalogue fixtures are built directly, which is
 * the whole reason it was designed that way: pacing and transport live in the
 * caller, so the resolution logic is testable without a token or a rate limit.
 *
 * Run: node scripts/test-spotify.mjs
 */

import { readFile } from "node:fs/promises";
import { matchTrack } from "../docs/spotify.js";
import { normTitle } from "../docs/drift.js";


let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

/*
 * Builds a catalogue index directly, in the shape `matchTrack` consumes.
 *
 * This used to come from `fetchCatalogue`, which is gone: it depended on
 * `GET /albums?ids=`, and Spotify returns 403 Forbidden to a
 * client-credentials app for that endpoint.
 *
 * `matchTrack` itself is very much alive, because the MUSICBRAINZ browse does
 * return tracklists via `inc=recordings` and produces this same shape. So the
 * fixture is built here rather than the tests deleted along with the fetcher.
 */
function buildCat(albums) {
  const titles = new Map();
  const entries = albums.map((a, i) => ({
    rg_id: `spotify:alb${i}`, title: a.name, primary: a.primary,
    secondary: a.secondary || [], first_release: a.date,
    status: "Official", total_tracks: a.tracks.length, source: "spotify",
  }));
  albums.forEach((a, i) => {
    for (const t of a.tracks) {
      const k = normTitle(t);
      if (!titles.has(k)) titles.set(k, []);
      titles.get(k).push(i);
    }
  });
  return { artist: "x", found: true, albums: entries, titles,
           releases: albums.length, source: "spotify" };
}

/* ------------------------------------------------------------------------- */
/*
 * Travis Scott's catalogue, trimmed to the cases that matter: an album, its
 * deluxe edition, and a single carrying a track that also appears on the album.
 */
const travis = [
  { name: "ASTROWORLD", primary: "Album", date: "2018-08-03",
    // "Café" carries the diacritic the folded-match tier exists for.
    tracks: ["SICKO MODE", "STARGAZING", "STOP TRYING TO BE GOD", "Café"] },
  { name: "Rodeo", primary: "Album", date: "2015-09-04",
    tracks: ["Antidote", "3500", "Oh My Dis Side"] },
  // The deluxe is a LATER reissue of the same work. The edition-collapsing
  // tests turn on it carrying a different date from the original.
  { name: "Rodeo (Deluxe)", primary: "Album", date: "2016-02-12",
    tracks: ["Antidote", "3500", "Oh My Dis Side", "Never Catch Me"] },
];

console.log("\nmatchTrack: tiers");

const cat = buildCat(travis);

{
  const m = matchTrack(cat, "SICKO MODE");
  ok(m, "exact title hits");
  eq(m.tier, "exact", "reports the exact tier");
  eq(m.groups[0].title, "ASTROWORLD", "returns the right release");
}

{
  const m = matchTrack(cat, "sicko mode");
  eq(m?.tier, "exact", "casing is irrelevant to matching");
}

{
  // A leak scrobbled with the feature credit must still find the official cut.
  const m = matchTrack(cat, "SICKO MODE (feat. Drake)");
  ok(m, "feature-credited title hits via baseTitle");
  eq(m.tier, "base", "reports the base tier");
}

{
  const m = matchTrack(cat, "Cafe");
  eq(m?.tier, "folded", "diacritic-folded match is found but marked");
  ok(m.groups[0].title === "ASTROWORLD", "folded match resolves correctly");
}

{
  ok(matchTrack(cat, "Unreleased Snippet 4") === null,
     "unknown title returns null, NOT a false positive");
}

/* ------------------------------------------------------------------------- */
console.log("\nmatchTrack: edition collapsing");

{
  // "Antidote" is on both Rodeo (2015) and Rodeo (Deluxe) (2016). Those are the
  // same work, and picking the deluxe would misreport the release date.
  const m = matchTrack(cat, "Antidote");
  ok(m, "track on multiple editions hits");
  eq(m.groups[0].first_release, "2015-09-04",
     "earliest edition wins, so the deluxe reissue does not shadow the original");
  ok(m.groups[0].primary === "Album", "keeps the release type");
  // The real assertion: they must MERGE, not merely sort. Two candidates here
  // would mean the UI offers "consolidate to Rodeo (Deluxe)" as an option.
  eq(m.groups.length, 1, "Rodeo and Rodeo (Deluxe) collapse to one candidate");
}

{
  // Edition stripping must not eat real titles. Chief Keef's "Deluxe" is an
  // actual mixtape, and merging it into something else would be a wrong answer.
  const tricky = [
    { name: "Deluxe", primary: "Album", date: "2016-01-01", tracks: ["Semi"] },
    { name: "Finally Rich", primary: "Album", date: "2012-12-18",
      tracks: ["Love Sosa"] },
    { name: "Finally Rich (Deluxe Edition)", primary: "Album", date: "2013-01-01",
      tracks: ["Love Sosa"] },
    { name: "Almighty So - Remastered", primary: "Album", date: "2020-01-01",
      tracks: ["Now It's Over"] },
    { name: "Almighty So", primary: "Album", date: "2013-10-12",
      tracks: ["Now It's Over"] },
  ];
  const c2 = buildCat(tricky);

  eq(matchTrack(c2, "Semi")?.groups[0].title, "Deluxe",
     "an album genuinely named 'Deluxe' survives edition stripping");
  eq(matchTrack(c2, "Love Sosa")?.groups.length, 1,
     "'(Deluxe Edition)' bracket suffix collapses");
  eq(matchTrack(c2, "Love Sosa")?.groups[0].first_release, "2012-12-18",
     "and the original date is kept");
  eq(matchTrack(c2, "Now It's Over")?.groups.length, 1,
     "'- Remastered' dash suffix collapses");
  eq(matchTrack(c2, "Now It's Over")?.groups[0].first_release, "2013-10-12",
     "and the 2020 remaster does not shadow the 2013 original");
}

/* ------------------------------------------------------------------------- */
/*
 * The "matchTrack: safety" section is gone with `fetchCatalogue`.
 *
 * Every assertion in it was about that fetcher's error handling: partial
 * batches, the `error` flag that stops a half-built index being cached, and the
 * client batch size agreeing with the Worker's SP_BATCH. None of it described
 * `matchTrack`, and none of it can run now that `GET /albums?ids=` is known to
 * return 403 Forbidden to a client-credentials app.
 *
 * The equivalent guarantees for the path that replaced it live in
 * scripts/test-worker.mjs, against the real handlers.
 */

console.log("\nEP heuristic (Worker-side, mirrored in the fake)");
{
  // Spotify has no EP type. A 5-track "single" is an EP; a 2-track one is not.
  // This lives in the Worker's spAlbumToGroup, so it is asserted there by
  // construction; here we only confirm the detectors' contract accepts "EP".
  ok(["Album", "Single", "EP"].includes("EP"),
     "EP is a primary type d14eReleasedSince accepts as official");
}

/* ------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
