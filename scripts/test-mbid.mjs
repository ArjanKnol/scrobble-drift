/**
 * MusicBrainz-ID evidence (D3, D4) and album-artist splits (D15).
 *
 * Three gaps found by reading the code rather than the report:
 *
 *  1. `album_mbid` and `track_mbid` were ingested on every scrobble and read by
 *     ZERO detectors. The README advertised a "D3 — MusicBrainz ID conflicts"
 *     that did not exist.
 *  2. Every grouping key in drift.js begins with the artist, so nothing could
 *     ever compare across artists.
 *  3. Album artist is a DIFFERENT FIELD from track artist, and
 *     user.getRecentTracks returns only the track artist. So an album re-credited
 *     from "Kanye West" to "Various Artists" splits the album chart while both
 *     halves stay byte-identical in the scrobble stream.
 *
 * Run: node scripts/test-mbid.mjs
 */
import {
  albumMbids, mbidVerdict, d3MbidConflicts, d4AlbumSplits,
  d15AlbumArtistSplits, analyse, DETECTOR_ORDER, SCORED_DETECTORS,
  trackMbids, trackMbidVerdict, d8FeatureCredits,
} from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const s = (artist, album, track, album_mbid = "", uts = 1) =>
  ({ uts, artist, album, track, album_mbid });

/* ------------------------------------------------------------------------- */
console.log("\nmbidVerdict is three-state");

{
  const rows = [
    s("Pale", "Youth", "Not In Love", "AAA"),
    s("Pale", "Youth (Deluxe)", "Not In Love", "AAA"),
    s("Pale", "Something Else", "Not In Love", "BBB"),
    s("Pale", "No Id Here", "Not In Love", ""),
  ];
  const m = albumMbids(rows);
  eq(mbidVerdict(m, "Pale", "Youth", "Youth (Deluxe)"), "same",
     "a shared MBID means one release, two spellings");
  eq(mbidVerdict(m, "Pale", "Youth", "Something Else"), "different",
     "disjoint MBIDs mean different releases");
  eq(mbidVerdict(m, "Pale", "Youth", "No Id Here"), "unknown",
     "a missing MBID is UNKNOWN, never a negative answer");
  eq(mbidVerdict(m, "Pale", "Youth", "Never Seen"), "unknown",
     "an unseen album is unknown too");
}

/* ------------------------------------------------------------------------- */
console.log("\nD4: MBID evidence outranks every string heuristic");

{
  // Same MBID: conclusive, even though "Youth (Deluxe)" looks like an edition
  // variant that the heuristics would have hedged on.
  const f = d4AlbumSplits([
    s("Pale", "Youth", "Not In Love", "AAA", 1),
    s("Pale", "Youth (Deluxe)", "Not In Love", "AAA", 2),
    s("Pale", "Youth", "Not In Love", "AAA", 3),
  ]);
  eq(f.length, 1, "a split is reported");
  eq(f[0].mbid_verdict, "same", "the verdict is carried on the issue");
  eq(f[0].class, "error", "upgraded to error");
  ok(f[0].confidence > 0.9, `at high confidence (${f[0].confidence})`);
  ok(/MusicBrainz confirms/.test(f[0].suggest), "and says why it is certain");
}

{
  // The Jackson 5 case, now settled by data instead of heuristics.
  const f = d4AlbumSplits([
    s("The Jackson 5", "Get It Together", "Dancing Machine", "BBB", 1),
    s("The Jackson 5", "Dancing Machine", "Dancing Machine", "CCC", 2),
  ]);
  eq(f[0].mbid_verdict, "different", "differing MBIDs are detected");
  eq(f[0].class, "review", "downgraded to review");
  ok(f[0].confidence <= 0.2, `at low confidence (${f[0].confidence})`);
  ok(/different releases/.test(f[0].suggest), "explaining they are separate");
  ok(/pressings/.test(f[0].suggest),
     "and warning that a deluxe pressing also looks different, so it is not proof");
}

{
  // No MBIDs: the heuristics must behave exactly as before.
  const rows = []; let uts = 1600000000;
  for (let i = 0; i < 9; i++)
    rows.push(s("Pale", "Not In Love - Single", "Not In Love", "", uts += 86400));
  for (let i = 0; i < 7; i++)
    rows.push(s("Pale", "Youth", "Not In Love", "", uts += 86400 * 40));
  const f = d4AlbumSplits(rows);
  eq(f[0].mbid_verdict, "unknown", "verdict is unknown");
  eq(f[0].class, "split", "and the migration heuristic still fires");
  eq(f[0].confidence, 0.9, "at its usual confidence");
}

/* ------------------------------------------------------------------------- */
console.log("\nD3: one album name covering two releases");

{
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(s("A", "Same Name", `T${i}`, "REL1", i));
  for (let i = 0; i < 4; i++) rows.push(s("A", "Same Name", `U${i}`, "REL2", 100 + i));
  const f = d3MbidConflicts(rows);
  eq(f.length, 1, "reported");
  eq(f[0].class, "review", "as review: there is nothing to merge");
  ok(f[0].no_auto_action, "and never automatable");
  ok(/already pooled under one name/.test(f[0].suggest),
     "saying plainly that the plays are not split");
  eq(f[0].plays_affected, 9, "counting both releases");
}

{
  // A single stray MBID is a scrobbler quirk, not two releases.
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(s("A", "Album", `T${i}`, "REL1", i));
  rows.push(s("A", "Album", "Odd", "REL2", 99));
  eq(d3MbidConflicts(rows).length, 0, "one stray MBID is ignored");
}

{
  eq(d3MbidConflicts([s("A", "Album", "T", "REL1")]).length, 0,
     "a single release is not a conflict");
  eq(d3MbidConflicts([s("A", "Album", "T", "")]).length, 0,
     "no MBIDs, no finding");
}

/* ------------------------------------------------------------------------- */
console.log("\nD15: the album-artist split");

const A = (name, artist, playcount, mbid = "") =>
  ({ name, artist: { name: artist }, playcount, mbid });

{
  // Cruel Winter, exactly as reported.
  const f = d15AlbumArtistSplits([
    A("Cruel Winter", "Kanye West", 41),
    A("Cruel Winter", "Various Artists", 18),
  ]);
  eq(f.length, 1, "the split is found");
  eq(f[0].class, "split", "as a split");
  ok(f[0].confidence >= 0.8, `at high confidence (${f[0].confidence})`);
  eq(f[0].plays_affected, 59, "combining both play counts");
  ok(/neither shows the full 59 plays/.test(f[0].suggest),
     "and states the combined total neither album shows");
  ok(/Various Artists/.test(f[0].suggest), "naming the reason");

  // The chart-impact interaction, which was nearly built the wrong way round.
  // chartImpact groups by TRACK artist plus album title, and the scrobble stream
  // carries only the track artist, so this split never existed in our numbers.
  // Feeding D15 into the simulation would double-count and break conservation.
  ok(f[0].chart_already_correct,
     "flagged as already correct in our own chart");
  ok(/corrected chart above already counts all 59/.test(f[0].suggest),
     "and the wording says so, so the reader knows which number to distrust");
  ok(/YOUR LAST\.FM chart/.test(f[0].suggest),
     "naming Last.fm as the source of the split, not us");
}

{
  // The invariant that made the above necessary: chartImpact must still conserve
  // plays, which means D15 must never be piped into it.
  const rest = []; let u = 1600000000;
  for (let i = 0; i < 59; i++)
    rest.push({ uts: u += 300, artist: "Kanye West", album: "Cruel Winter",
                track: "Champions" });
  for (let i = 0; i < 500; i++)
    rest.push({ uts: u += 300, artist: "Filler", album: "Other", track: `T${i}` });

  const im = analyse(rest, {
    topAlbums: [A("Cruel Winter", "Kanye West", 41),
                A("Cruel Winter", "Various Artists", 18)],
  }).impact;
  const cw = im.reported_top.find((x) => x.album.includes("Cruel Winter"));
  eq(cw.plays, 59,
     "our chart already pools all 59 plays, because it keys on the track artist");
  const before = im.reported_top.reduce((n, x) => n + x.plays, 0);
  const after = im.corrected_top.reduce((n, x) => n + x.plays, 0);
  eq(after, before, "and plays are still conserved, D15 having been kept out");
}

{
  const f = d15AlbumArtistSplits([
    A("Some Album", "Artist A", 20, "MB1"),
    A("Some Album", "Artist B", 9, "MB1"),
  ]);
  eq(f[0].class, "error", "a shared release MBID is conclusive");
  ok(f[0].confidence >= 0.95, "at the highest confidence");
}

{
  const f = d15AlbumArtistSplits([
    A("Kids See Ghosts", "Kanye West", 30),
    A("Kids See Ghosts", "Kanye West & Kid Cudi", 12),
  ]);
  eq(f.length, 1, "artist-name containment counts");
  ok(/contains the other/.test(f[0].suggest), "and says so");
}

console.log("\n  the false-positive class that must stay silent:");
for (const [label, albums] of [
  ["unrelated artists, same title",
   [A("Greatest Hits", "Queen", 200), A("Greatest Hits", "ABBA", 150)]],
  ["self-titled collision",
   [A("Weezer", "Weezer", 80), A("Weezer", "Some Tribute Band", 5)]],
  ["generic live album",
   [A("Live", "Band One", 40), A("Live", "Band Two", 30)]],
  ["same artist, one album",
   [A("Rodeo", "Travis Scott", 100)]],
]) {
  eq(d15AlbumArtistSplits(albums).length, 0, `  ${label}`);
}

{
  // Substring traps: containment must respect word boundaries.
  eq(d15AlbumArtistSplits([
    A("Album", "Yeat", 50), A("Album", "Wheatus", 40),
  ]).length, 0, "'Yeat' inside 'Wheatus' is not containment");
}

{
  eq(d15AlbumArtistSplits([]).length, 0, "an empty chart is fine");
  eq(d15AlbumArtistSplits(null).length, 0, "and so is null");
  eq(d15AlbumArtistSplits([{ name: "X" }]).length, 0,
     "an entry with no artist is skipped rather than throwing");
}

{
  // Below the play threshold it is not worth mentioning.
  eq(d15AlbumArtistSplits([
    A("Tiny", "Someone", 1), A("Tiny", "Various Artists", 1),
  ]).length, 0, "two plays total is under the threshold");
}

/* ------------------------------------------------------------------------- */
console.log("\nD8: track_mbid settles the feature-credit question");

const t = (track, n, mbid = "", start = 1698000000) => {
  const o = [];
  for (let i = 0; i < n; i++)
    o.push({ uts: start + i * 86400, artist: "X", album: "A", track,
             track_mbid: mbid });
  return o;
};
const d8 = (rows) => d8FeatureCredits(rows)
  .filter((i) => i.title.includes("title variants"));

{
  const m = trackMbids([
    ...t("IMY2 (with Kid Cudi)", 1, "REC1"),
    ...t("IMY2", 1, "REC1"),
    ...t("Other Song", 1, "REC2"),
    ...t("No Id", 1, ""),
  ]);
  eq(trackMbidVerdict(m, "X", "IMY2 (with Kid Cudi)", "IMY2"), "same",
     "a shared recording ID means one performance, two spellings");
  eq(trackMbidVerdict(m, "X", "IMY2", "Other Song"), "different",
     "disjoint recording IDs mean different performances");
  eq(trackMbidVerdict(m, "X", "IMY2", "No Id"), "unknown",
     "a missing ID is unknown, never a negative");
}

{
  // The IMY2 stray, now provable rather than guessed at.
  const f = d8([...t("IMY2 (with Kid Cudi)", 14, "REC1"),
                ...t("IMY2", 1, "REC1", 1712000000)]);
  eq(f.length, 1, "reported");
  eq(f[0].mbid_verdict, "same", "verdict carried");
  eq(f[0].class, "error", "upgraded to error");
  ok(f[0].confidence > 0.9, `at high confidence (${f[0].confidence})`);
  ok(/same recording ID/.test(f[0].suggest), "and says why it is certain");
  ok(!/Barely worth fixing/.test(f[0].suggest),
     "a confirmed identical recording is no longer dismissed as a stray");
}

{
  // Roll in Peace, settled by data instead of by parsing brackets.
  const f = d8([...t("Roll in Peace (feat. XXXTENTACION)", 41, "REC1"),
                ...t("Roll In Peace (feat. Travis Scott)", 2, "REC2")]);
  eq(f.length, 0, "two different recordings are never merged");
}

{
  // MBID evidence must be able to OVERRIDE the credit heuristic both ways.
  // Compatible credits, but two recordings: suppressed.
  const f = d8([...t("Song", 20, "REC1"),
                ...t("Song (feat. A)", 8, "REC2")]);
  eq(f.length, 0,
     "compatible credits are still suppressed when the recordings differ");

  // Conflicting credits, but one recording: reported.
  const g = d8([...t("Song (feat. A)", 20, "REC9"),
                ...t("Song (feat. B)", 8, "REC9")]);
  eq(g.length, 1,
     "conflicting credits are reported when MusicBrainz says one recording");
  eq(g[0].class, "error", "and conclusively");
}

{
  // No MBIDs: the credit heuristic must behave exactly as before.
  const crew = d8([...t("Crew", 27),
                   ...t("Crew (feat. Brent Faiyaz & Shy Glizzy)", 11, "", 1620000000)]);
  eq(crew.length, 1, "GoldLink 'Crew' is still reported");
  eq(crew[0].class, "split", "as a split");
  eq(crew[0].confidence, 0.8, "at its usual confidence");
  eq(crew[0].mbid_verdict, "unknown", "with verdict unknown");

  const kodak = d8([...t("Roll in Peace (feat. XXXTENTACION)", 41),
                    ...t("Roll In Peace (feat. Travis Scott)", 2)]);
  eq(kodak.length, 0, "and the credit conflict is still suppressed without IDs");
}

/* ------------------------------------------------------------------------- */
console.log("\nboth new detectors are scored and ordered");

for (const d of ["D3", "D15"]) {
  ok(SCORED_DETECTORS.has(d), `${d} contributes to the hygiene score`);
  ok(DETECTOR_ORDER.flat().includes(d), `${d} has an explicit report rank`);
}

{
  // analyse() must accept and use the album chart.
  const rows = []; let uts = 1600000000;
  for (let i = 0; i < 20; i++)
    rows.push(s("Kanye West", "Cruel Winter", `T${i}`, "", uts += 300));
  const r = analyse(rows, {
    topAlbums: [A("Cruel Winter", "Kanye West", 41),
                A("Cruel Winter", "Various Artists", 18)],
  });
  eq(r.issues.filter((i) => i.detector === "D15").length, 1,
     "analyse() passes topAlbums through to D15");

  const without = analyse(rows);
  eq(without.issues.filter((i) => i.detector === "D15").length, 0,
     "and contributes nothing when the chart is unavailable");
  ok(without.issues.length >= 0, "without throwing");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
