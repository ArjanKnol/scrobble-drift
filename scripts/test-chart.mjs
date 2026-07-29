/**
 * Tests for chartImpact, the "your chart if splits were counted as one" view.
 *
 * Two bugs shipped here, both of which made the section actively misleading
 * rather than merely unclear:
 *
 *  1. The merge target came from MusicBrainz's release-group title, which is
 *     frequently NOT a string the user has. Plays moved out of a real album into
 *     a phantom entry, so an album appeared to lose 159 plays to nowhere.
 *  2. When MusicBrainz gave no answer, the target was the most-played variant,
 *     which is often the single. That consolidated albums INTO singles, exactly
 *     backwards from what the tool is for.
 *
 * Run: node scripts/test-chart.mjs
 */
import { chartImpact } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const lib = (spec) => {
  const out = [];
  let uts = 1600000000;
  for (const [artist, album, track, n] of spec) {
    for (let i = 0; i < n; i++) out.push({ uts: uts++, artist, album, track });
  }
  return out;
};
const playsOf = (im, key) =>
  im.corrected_top.find((a) => a.album === key)?.plays ?? 0;

/* ------------------------------------------------------------------------- */
console.log("\nbug 1: the merge target must be a string the user has");

{
  const rest = lib([
    ["Kanye West", "Graduation", "Stronger", 409],
    ["Kanye West", "Graduation - Single", "Stronger", 12],
    ["Other", "Filler", "T", 500],
  ]);
  const splits = [{
    artist: "Kanye West", track: "Stronger",
    members: [{ album: "Graduation", plays: 409 },
              { album: "Graduation - Single", plays: 12 }],
    // MusicBrainz names an edition the user does not have.
    external: { title: "Graduation (Deluxe Edition)" },
  }];
  const im = chartImpact(rest, splits);

  ok(!im.corrected_top.some((a) => a.album.includes("Deluxe")),
     "no phantom album is invented");
  eq(playsOf(im, "Kanye West␟Graduation"), 421,
     "the real album absorbs the single instead of losing plays");
  eq(playsOf(im, "Kanye West␟Graduation - Single"), 0,
     "and the single is emptied");
  ok(!im.corrected_top.some((a) => a.plays === 0),
     "emptied strings are not listed at 0 plays");
}

/* ------------------------------------------------------------------------- */
console.log("\nbug 2: with no MusicBrainz answer, prefer the album over the single");

{
  // The single is played MORE than the album for this track. Most-played would
  // pick the single and drain the album.
  const rest = lib([
    ["Drake", "Scorpion", "God's Plan", 5],
    ["Drake", "God's Plan - Single", "God's Plan", 20],
    ["Other", "Filler", "T", 500],
  ]);
  const splits = [{
    artist: "Drake", track: "God's Plan",
    members: [{ album: "God's Plan - Single", plays: 20 },
              { album: "Scorpion", plays: 5 }],
    // no `external`: MusicBrainz failed or was skipped
  }];
  const im = chartImpact(rest, splits);

  eq(playsOf(im, "Drake␟Scorpion"), 25,
     "the album absorbs the single even though the single had more plays");
  eq(playsOf(im, "Drake␟God's Plan - Single"), 0, "and the single is emptied");
}

{
  // A deluxe edition is still the album, and should beat a single.
  const rest = lib([
    ["Young Thug", "So Much Fun (Deluxe)", "Hot", 30],
    ["Young Thug", "Hot - Single", "Hot", 40],
    ["Other", "Filler", "T", 500],
  ]);
  const im = chartImpact(rest, [{
    artist: "Young Thug", track: "Hot",
    members: [{ album: "Hot - Single", plays: 40 },
              { album: "So Much Fun (Deluxe)", plays: 30 }],
  }]);
  eq(playsOf(im, "Young Thug␟So Much Fun (Deluxe)"), 70,
     "an edition variant outranks a single");
}

{
  // A compilation should NOT win over a studio album.
  const rest = lib([
    ["Artist", "Real Album", "Song", 10],
    ["Artist", "Greatest Hits", "Song", 90],
    ["Other", "Filler", "T", 500],
  ]);
  const im = chartImpact(rest, [{
    artist: "Artist", track: "Song",
    members: [{ album: "Greatest Hits", plays: 90 },
              { album: "Real Album", plays: 10 }],
  }]);
  eq(playsOf(im, "Artist␟Real Album"), 100,
     "the studio album wins over a greatest-hits compilation");
}

{
  // Two real albums: no classification tiebreak, so plays decide.
  const rest = lib([
    ["Artist", "Album A", "Skit", 80],
    ["Artist", "Album B", "Skit", 5],
    ["Other", "Filler", "T", 500],
  ]);
  const im = chartImpact(rest, [{
    artist: "Artist", track: "Skit",
    members: [{ album: "Album A", plays: 80 }, { album: "Album B", plays: 5 }],
  }]);
  eq(playsOf(im, "Artist␟Album A"), 85,
     "between two albums the most-played one wins");
}

/* ------------------------------------------------------------------------- */
console.log("\nMusicBrainz answer is still honoured when it matches a member");

{
  const rest = lib([
    ["Drake", "Scorpion", "Nonstop", 5],
    ["Drake", "Nonstop - Single", "Nonstop", 40],
    ["Other", "Filler", "T", 500],
  ]);
  const im = chartImpact(rest, [{
    artist: "Drake", track: "Nonstop",
    members: [{ album: "Nonstop - Single", plays: 40 },
              { album: "Scorpion", plays: 5 }],
    external: { title: "Scorpion" },
  }]);
  eq(playsOf(im, "Drake␟Scorpion"), 45, "an exact MusicBrainz match is used");
}

{
  // Partial match, the common real shape.
  const rest = lib([
    ["Artist", "The Album (Deluxe Edition)", "Song", 50],
    ["Artist", "Song - Single", "Song", 10],
    ["Other", "Filler", "T", 500],
  ]);
  const im = chartImpact(rest, [{
    artist: "Artist", track: "Song",
    members: [{ album: "The Album (Deluxe Edition)", plays: 50 },
              { album: "Song - Single", plays: 10 }],
    external: { title: "The Album" },
  }]);
  eq(playsOf(im, "Artist␟The Album (Deluxe Edition)"), 60,
     "'The Album' matches 'The Album (Deluxe Edition)' by partial match");
}

/* ------------------------------------------------------------------------- */
console.log("\nmover rows are labelled by reason");

{
  const rest = lib([
    ["A", "Album A", "S", 100], ["A", "S - Single", "S", 60],
    ["B", "Album B", "T", 130],
    ["C", "Album C", "U", 400],
  ]);
  const im = chartImpact(rest, [{
    artist: "A", track: "S",
    members: [{ album: "S - Single", plays: 60 }, { album: "Album A", plays: 100 }],
  }]);
  const merged = im.biggest_movers.filter((m) => m.reason === "merged");
  const moved = im.biggest_movers.filter((m) => m.reason === "displaced");

  ok(merged.length >= 1, `at least one row is labelled merged (${merged.length})`);
  for (const m of merged) {
    ok(m.plays_after !== m.plays_before,
       `  merged row ${m.album.split("␟")[1]} really changed plays`);
  }
  for (const m of moved) {
    ok(m.plays_after === m.plays_before,
       `  displaced row ${m.album.split("␟")[1]} kept its play count`);
  }
  ok(im.biggest_movers.every((m) => m.reason),
     "every mover carries a reason");
  if (merged.length && moved.length) {
    ok(im.biggest_movers[0].reason === "merged",
       "merged rows sort ahead of displaced ones");
  }
}

/* ------------------------------------------------------------------------- */
console.log("\nplays are conserved, never created or destroyed");

{
  const rest = lib([
    ["A", "Album A", "S", 100], ["A", "S - Single", "S", 60],
    ["B", "Album B", "T", 130], ["B", "T - Single", "T", 5],
    ["C", "Album C", "U", 400],
  ]);
  const im = chartImpact(rest, [
    { artist: "A", track: "S",
      members: [{ album: "S - Single", plays: 60 }, { album: "Album A", plays: 100 }] },
    { artist: "B", track: "T",
      members: [{ album: "T - Single", plays: 5 }, { album: "Album B", plays: 130 }] },
  ]);
  const before = im.reported_top.reduce((n, a) => n + a.plays, 0);
  const after = im.corrected_top.reduce((n, a) => n + a.plays, 0);
  eq(after, before, "total plays are identical before and after");
  eq(after, 695, "and equal the library size");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
