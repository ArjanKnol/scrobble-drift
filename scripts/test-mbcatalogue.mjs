/**
 * MusicBrainz catalogue browsing.
 *
 * The Spotify catalogue trick was never applied to MusicBrainz, which is where
 * it is worth most: MusicBrainz allows ONE request per second, so a residual of
 * 300 tracks costs five minutes, while the same tracks belong to a few dozen
 * artists.
 *
 * NOTE: the response SHAPE is built from the documented contract, not from a live
 * response. MusicBrainz refuses requests without a meaningful User-Agent, so it
 * could not be probed from the sandbox. These tests pin the parsing against the
 * documented format; a live deploy is what confirms the format itself.
 *
 * Run: node scripts/test-mbcatalogue.mjs
 */
import {
  fetchMbCatalogue, splitByStrategy, estimateMb,
} from "../docs/mbcatalogue.js";
import { matchTrack } from "../docs/spotify.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

/* A fake Worker mirroring the documented response shape. */
function fakeApi(catalogue, opts = {}) {
  const calls = [];
  return {
    calls,
    api: async (path) => {
      calls.push(path);
      if (path.startsWith("/api/mb/artist-id")) {
        const name = decodeURIComponent(
          new URL(path, "http://x").searchParams.get("artist"));
        const rec = catalogue[name];
        return rec
          ? { found: true, mbid: rec.mbid, name }
          : { found: false, mbid: null, near: [] };
      }
      if (path.startsWith("/api/mb/artist-catalogue")) {
        if (opts.pageFails) return null;
        const u = new URL(path, "http://x");
        const mbid = u.searchParams.get("mbid");
        const offset = Number(u.searchParams.get("offset") || 0);
        const rec = Object.values(catalogue).find((c) => c.mbid === mbid);
        if (!rec) return { releases: [], next_offset: null, total: 0 };
        // Paged in twos, to exercise the offset handling.
        const slice = rec.releases.slice(offset, offset + 2);
        return {
          releases: slice,
          next_offset: offset + slice.length < rec.releases.length
            ? offset + slice.length : null,
          total: rec.releases.length,
        };
      }
      throw new Error("unstubbed " + path);
    },
  };
}

const rel = (title, tracks, over = {}) => ({
  rg_id: `mb:${title.toLowerCase().replace(/\W/g, "")}`,
  title, primary: "Album", secondary: [], first_release: "2015-09-04",
  status: "Official", source: "musicbrainz", tracks, ...over,
});

const CAT = {
  "Travis Scott": {
    mbid: "e4a0d0d3-0000-4000-8000-000000000001",
    releases: [
      rel("Rodeo", ["Pornography", "Antidote", "3500"]),
      rel("ASTROWORLD", ["SICKO MODE", "STARGAZING"], { first_release: "2018-08-03" }),
      rel("Days Before Rodeo", ["Mamacita"], { first_release: "2014-08-18" }),
      rel("Birds in the Trap", ["goosebumps"], { first_release: "2016-09-02" }),
      rel("JACKBOYS", ["OUT WEST"], { first_release: "2019-12-27" }),
    ],
  },
};

/* ------------------------------------------------------------------------- */
console.log("\ncatalogue build and paging");

{
  const { api, calls } = fakeApi(CAT);
  const cat = await fetchMbCatalogue(
    "Travis Scott", "e4a0d0d3-0000-4000-8000-000000000001", api);

  ok(cat.found, "the catalogue resolves");
  eq(cat.releases, 5, "all five releases across three pages");
  eq(calls.filter((c) => c.includes("artist-id")).length, 0,
     "no name lookup when the MBID was supplied");

  // Paging must advance by releases RETURNED, not by the limit. Advancing by the
  // limit silently skips releases, which the docs warn about explicitly.
  const offsets = calls
    .filter((c) => c.includes("artist-catalogue"))
    .map((c) => Number(new URL(c, "http://x").searchParams.get("offset")));
  eq(JSON.stringify(offsets), JSON.stringify([0, 2, 4]),
     "offsets advance by the count returned");
}

{
  // No MBID: resolve the name first, then browse.
  const { api, calls } = fakeApi(CAT);
  const cat = await fetchMbCatalogue("Travis Scott", null, api);
  ok(cat.found, "resolves without a supplied MBID");
  eq(cat.mbid, "e4a0d0d3-0000-4000-8000-000000000001", "and finds the right one");
  eq(calls.filter((c) => c.includes("artist-id")).length, 1,
     "at the cost of exactly one extra call");
}

{
  const cat = await fetchMbCatalogue("Nobody At All", null, fakeApi(CAT).api);
  ok(!cat.found, "an unknown artist reports found:false");
  ok(!cat.error, "and NOT error, because that is a real answer");
  eq(cat.albums.length, 0, "with an empty album list");
}

/* ------------------------------------------------------------------------- */
console.log("\nfailures must not be cached as answers");

{
  const cat = await fetchMbCatalogue("Travis Scott", null, async () => null);
  ok(cat.error, "a failed name lookup sets error");
  ok(!cat.found, "and reports not found");
}

{
  const { api } = fakeApi(CAT, { pageFails: true });
  const cat = await fetchMbCatalogue(
    "Travis Scott", "e4a0d0d3-0000-4000-8000-000000000001", api);
  ok(cat.error, "a failed catalogue page sets error");
  eq(cat.failed_pages, 1, "counting the lost page");
  eq(cat.titles.size, 0, "with no titles indexed");
}

/* ------------------------------------------------------------------------- */
console.log("\nshape is interchangeable with the Spotify catalogue");

{
  const cat = await fetchMbCatalogue(
    "Travis Scott", "e4a0d0d3-0000-4000-8000-000000000001", fakeApi(CAT).api);

  // matchTrack lives in spotify.js and must work unchanged. That is the whole
  // point of building the same shape rather than a parallel matcher.
  const m = matchTrack(cat, "Antidote");
  ok(m, "matchTrack from spotify.js accepts a MusicBrainz catalogue");
  eq(m.groups[0].title, "Rodeo", "and resolves the right release");
  eq(m.groups[0].source, "musicbrainz", "with the source recorded");

  const base = matchTrack(cat, "SICKO MODE (feat. Drake)");
  ok(base, "feature-credited titles match via the base title");
  eq(base.tier, "base", "reported as the base tier");

  eq(matchTrack(cat, "Some Leak Nobody Has"), null,
     "an unknown title returns null, not a false positive");
}

/* ------------------------------------------------------------------------- */
console.log("\nstrategy split: catalogue vs per-track");

{
  const jobs = [
    // 6 tracks, MBID known -> catalogue is clearly cheaper
    ...Array.from({ length: 6 }, (_, i) =>
      ({ artist: "Travis Scott", track: `T${i}`, plays: 10,
         artist_mbid: "e4a0d0d3-0000-4000-8000-000000000001" })),
    // 1 track -> a browse would be pure overhead
    { artist: "One Hit Wonder", track: "Only Song", plays: 3 },
    // 2 tracks, no MBID -> still cheaper per-track
    { artist: "Small Fry", track: "A", plays: 2 },
    { artist: "Small Fry", track: "B", plays: 2 },
  ];
  const split = splitByStrategy(jobs);

  eq(split.catalogue.length, 1, "one artist warrants a catalogue browse");
  eq(split.catalogue[0].artist, "Travis Scott", "the one with six tracks");
  eq(split.catalogue[0].mbid, "e4a0d0d3-0000-4000-8000-000000000001",
     "carrying the MBID from the scrobble, saving a lookup");
  eq(split.perTrack.length, 3, "the thin artists go per-track");

  const est = estimateMb(split);
  // 1 catalogue page (MBID known, so no name lookup) + 3 per-track searches.
  eq(est.calls, 4, "4 calls: one catalogue page plus three searches");
  ok(est.calls < jobs.length,
     `fewer calls than one-per-track (${est.calls} < ${jobs.length})`);
}

{
  // The threshold itself, since it moved once the real cost was measured. With a
  // known MBID a browse is ONE call, so two tracks already beat two searches.
  const two = splitByStrategy([
    { artist: "A", track: "X", plays: 1, artist_mbid: "m-1" },
    { artist: "A", track: "Y", plays: 1, artist_mbid: "m-1" },
  ]);
  eq(two.catalogue.length, 1, "two tracks with a known MBID warrant a browse");

  const one = splitByStrategy([
    { artist: "A", track: "X", plays: 1, artist_mbid: "m-1" },
  ]);
  eq(one.catalogue.length, 0, "one track never does");

  // Without an MBID a browse costs a name lookup too, so the bar is higher.
  const twoNoId = splitByStrategy([
    { artist: "B", track: "X", plays: 1 },
    { artist: "B", track: "Y", plays: 1 },
  ]);
  eq(twoNoId.catalogue.length, 0,
     "two tracks with no MBID stay per-track, since the browse costs an extra call");
  const three = splitByStrategy([
    { artist: "B", track: "X", plays: 1 },
    { artist: "B", track: "Y", plays: 1 },
    { artist: "B", track: "Z", plays: 1 },
  ]);
  eq(three.catalogue.length, 1, "three without an MBID does");
}

{
  // The degenerate case that motivated the split: many artists, one track each.
  const jobs = Array.from({ length: 40 }, (_, i) =>
    ({ artist: `Artist ${i}`, track: "Song", plays: 1 }));
  const split = splitByStrategy(jobs);
  eq(split.catalogue.length, 0, "no browses for 40 single-track artists");
  eq(split.perTrack.length, 40, "all 40 go per-track");
  eq(estimateMb(split).calls, 40, "so the cost is exactly 40, not 120");
}

{
  // And the case it is built for: few artists, many tracks each.
  const jobs = [];
  for (let a = 0; a < 8; a++)
    for (let t = 0; t < 40; t++)
      jobs.push({ artist: `Artist ${a}`, track: `T${t}`, plays: 1,
                  artist_mbid: `0000000${a}-0000-4000-8000-000000000000` });
  const split = splitByStrategy(jobs);
  eq(split.catalogue.length, 8, "all eight artists get a browse");
  eq(split.perTrack.length, 0, "nothing goes per-track");
  const est = estimateMb(split);
  eq(est.calls, 8, "8 calls instead of 320");
  console.log(`       320 per-track lookups -> ${est.calls} calls (${est.seconds}s at 1/s)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
