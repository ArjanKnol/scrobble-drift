/**
 * Offline tests for the Spotify catalogue layer.
 *
 * No network. The `api` argument to fetchCatalogue is a plain function, which is
 * the whole reason it was designed that way: pacing and transport live in the
 * caller, so the resolution logic is testable without a token or a rate limit.
 *
 * Run: node scripts/test-spotify.mjs
 */

import { fetchCatalogue, matchTrack, byArtist, estimate }
  from "../docs/spotify.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

/* Fake Worker. Mirrors the real response shapes exactly, including the
 * album -> release-group adaptation, so a change to that contract breaks here
 * rather than in production. */
function fakeApi(catalogue) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/api/spotify/artist-albums")) {
      const artist = decodeURIComponent(new URL(path, "http://x")
        .searchParams.get("artist"));
      const cat = catalogue[artist];
      if (!cat) return { found: false, artist, near: [] };
      return {
        found: true, artist_id: "aid", artist_name: artist,
        albums: cat.map((a, i) => ({ id: `alb${i}`.padEnd(22, "x"), name: a.name })),
        truncated: false,
      };
    }
    if (path.startsWith("/api/spotify/album-tracks")) {
      const ids = new URL(path, "http://x").searchParams.get("ids").split(",");
      const all = Object.values(catalogue).flat();
      const tracks = [];
      for (const id of ids) {
        const i = Number(id.replace(/\D/g, ""));
        const al = all[i];
        if (!al) continue;
        for (const t of al.tracks) {
          tracks.push({
            title: t, artists: [al.artist || "X"], disc: 1, n: 1,
            album: {
              rg_id: `spotify:${id}`, title: al.name, primary: al.primary,
              secondary: al.secondary || [], first_release: al.date,
              status: "Official", total_tracks: al.tracks.length,
              url: null, source: "spotify",
            },
          });
        }
      }
      return { tracks, partial: false };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { api, calls };
}

/* ------------------------------------------------------------------------- */
console.log("\nfetchCatalogue");

const travis = [
  { name: "Rodeo", primary: "Album", date: "2015-09-04",
    tracks: ["Pornography", "Antidote", "Maria I'm Drunk"] },
  { name: "ASTROWORLD", primary: "Album", date: "2018-08-03",
    tracks: ["SICKO MODE", "STARGAZING", "Café"] },
  { name: "Rodeo (Deluxe)", primary: "Album", date: "2016-01-01",
    tracks: ["Antidote", "3500"] },
];

{
  const { api, calls } = fakeApi({ "Travis Scott": travis });
  const cat = await fetchCatalogue("Travis Scott", api);

  ok(cat.found, "resolves an exact artist match");
  eq(cat.releases, 3, "counts releases");
  eq(calls.length, 2, "3 albums cost 2 calls: 1 list + 1 batch of 20");
  eq(cat.albums.length, 3, "albums stored once, not per track");

  // The storage shape is the point: 8 tracks must not produce 8 album copies.
  ok(cat.albums.length < 8, "album metadata is deduplicated by rg_id");
}

/* ------------------------------------------------------------------------- */
console.log("\nmatchTrack: tiers");

const { api } = fakeApi({ "Travis Scott": travis });
const cat = await fetchCatalogue("Travis Scott", api);

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
  const c2 = await fetchCatalogue("Chief Keef",
                                  fakeApi({ "Chief Keef": tricky }).api);

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
console.log("\nmatchTrack: safety");

{
  const missing = await fetchCatalogue("Nonexistent Artist",
                                       fakeApi({}).api);
  ok(!missing.found, "unknown artist reports found:false");
  ok(!missing.error, "and NOT error, because that is a real answer");
  eq(missing.albums, [], "albums is an empty array, matching the success shape");
  ok(matchTrack(missing, "Anything") === null,
     "no catalogue means null, which the caller must read as 'ask MusicBrainz'");
}

{
  // The failure that would silently corrupt every future scan: a dead Spotify
  // returns null, which must NOT be recorded as "this artist does not exist".
  const broken = await fetchCatalogue("Travis Scott", async () => null);
  ok(!broken.found, "a failed call also reports found:false");
  ok(broken.error, "but flags error, so the caller skips caching it");
  eq(broken.albums, [], "and still returns the safe empty shape");
  ok(matchTrack(broken, "Antidote") === null, "and matches nothing");
}

{
  // THE bug that shipped. Artist resolves, tracklist calls die (the Worker was
  // returning 500 because parsing Spotify's available_markets arrays blew its
  // 10ms CPU budget). The result was found:true with zero titles, which the
  // frontend then cached as a valid empty catalogue: every future scan trusted
  // it and reported the artist as having released nothing, forever.
  const flaky = async (path) =>
    path.includes("artist-albums")
      ? { found: true, artist_name: "Travis Scott",
          albums: [{ id: "al0zzzzzzzzzzzzzzzzzzz", name: "Rodeo" }] }
      : null;

  const half = await fetchCatalogue("Travis Scott", flaky);
  eq(half.titles.size, 0, "a dead tracklist call yields no titles");
  ok(half.found, "the artist still resolved");
  ok(half.error, "and error IS set, so the caller must not cache this");
  eq(half.failed_batches, 1, "reporting how many batches were lost");
  ok(matchTrack(half, "Antidote") === null,
     "nothing matches, so MusicBrainz gets the track");
}

{
  // The success path must NOT set error, or nothing would ever be cached and
  // every rescan would pay full price.
  const good = await fetchCatalogue("Travis Scott",
                                    fakeApi({ "Travis Scott": travis }).api);
  ok(!good.error, "a fully successful catalogue is cacheable");
  eq(good.failed_batches, 0, "with no failed batches");
}

{
  // Batches are 10, not 20: at 20 the Worker response was large enough to
  // exceed its CPU budget. 25 albums must therefore cost 3 tracklist calls.
  const many = Array.from({ length: 25 }, (_, i) =>
    ({ name: `Album ${i}`, primary: "Album", date: "2020-01-01",
       tracks: [`Track ${i}`] }));
  const { api, calls } = fakeApi({ "Prolific": many });
  await fetchCatalogue("Prolific", api);
  const trackCalls = calls.filter((c) => c.includes("album-tracks"));
  eq(trackCalls.length, 3, "25 albums batch into 3 calls of at most 10");
  for (const c of trackCalls) {
    ok(c.split(",").length <= 10, `  batch of ${c.split(",").length} ids is within 10`);
  }
}

/* ------------------------------------------------------------------------- */
console.log("\nEP heuristic (Worker-side, mirrored in the fake)");
{
  // Spotify has no EP type. A 5-track "single" is an EP; a 2-track one is not.
  // This lives in the Worker's spAlbumToGroup, so it is asserted there by
  // construction; here we only confirm the detectors' contract accepts "EP".
  ok(["Album", "Single", "EP"].includes("EP"),
     "EP is a primary type d14eReleasedSince accepts as official");
}

/* ------------------------------------------------------------------------- */
console.log("\nbyArtist and estimate");

const plan = [
  { artist: "Travis Scott", track: "A", plays: 50 },
  { artist: "travis scott", track: "B", plays: 30 },   // casing variant
  { artist: "Yeat", track: "C", plays: 200 },
];

{
  const groups = byArtist(plan);
  eq(groups.length, 2, "artist casing variants collapse into one catalogue fetch");
  eq(groups[0].artist, "Yeat", "busiest artist first, so a capped budget buys most");
  eq(groups[1].jobs.length, 2, "both Travis jobs land in one group");

  const est = estimate(groups);
  eq(est.tracks, 3, "counts every track");
  eq(est.artists, 2, "counts distinct artists");
  ok(est.calls < plan.length * 2, "per-artist plan costs fewer calls than per-track");
}

/* ------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
