/**
 * Tests for unreleased/era tagging conventions.
 *
 * There is no standard for how people tag unreleased music, and the first
 * version of this only understood one form. Worse, it failed silently: a string
 * could be classified as era-tagged (so protected from every other detector) and
 * simultaneously yield no era name (so invisible to every era check). Tagged,
 * protected, and unexamined.
 *
 * Run: node scripts/test-era.mjs
 */

import {
  isEraTagged, eraName, isUndifferentiated, partitionEra, d14fSingleBucket,
  d14aFormatVariants, analyse,
} from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};
const eq = (a, b, msg) =>
  ok(Object.is(a, b), `${msg}  (got ${JSON.stringify(a)})`);

/* ------------------------------------------------------------------------- */
console.log("\nera name extraction, every observed convention");

const NAMED = [
  ["Unreleased (Rodeo Era)", "Rodeo"],
  ["UNRELEASED (SlHoL Era)", "SlHoL"],
  ["Unreleased [Rodeo Era]", "Rodeo"],          // brackets: was broken
  ["Unreleased (Rodeo Sessions)", "Rodeo"],     // sessions: was broken
  ["Unreleased [Donda Sessions]", "Donda"],
  ["Rodeo Sessions", "Rodeo"],                  // bare: was undetected
  ["Rodeo sessions", "Rodeo"],
  ["Rodeo Era", "Rodeo"],
  ["Unreleased (Rodeo)", "Rodeo"],              // bare parenthetical
  ["Unreleased (Yandhi V2 Era)", "Yandhi V2"],  // version is part of the name
  ["Unreleased (Eternal Atake OG Era)", "Eternal Atake OG"],
];
for (const [album, want] of NAMED) {
  eq(eraName(album), want, `${JSON.stringify(album)}`);
  ok(isEraTagged(album), `  ...and is recognised as era-tagged`);
}

{
  // The exact silent failure: tagged but nameless. Must not happen for any
  // string that carries a qualifier.
  const broken = NAMED.filter(([a]) => isEraTagged(a) && !eraName(a));
  eq(broken.length, 0, "no qualifier form is tagged-but-nameless");
}

/* ------------------------------------------------------------------------- */
console.log("\nundifferentiated buckets: tagged, but deliberately nameless");

for (const a of ["Unreleased", "unreleased", "Unreleased Songs",
                 "Unreleased Tracks", "Leaks", "Snippets", "Outtakes"]) {
  ok(isEraTagged(a), `${JSON.stringify(a)} is era-tagged`);
  eq(eraName(a), null, `  ...with no era name`);
  ok(isUndifferentiated(a), `  ...and is flagged as a single bucket`);
}

{
  // "Snippets" and "Leaks" used to fail: \bsnippet\b cannot match the plural,
  // because the trailing s consumes the word boundary.
  ok(isEraTagged("Snippets"), "plural 'Snippets' matches (the \\b bug)");
  ok(isEraTagged("Leaks"), "plural 'Leaks' matches");
}

ok(!isUndifferentiated("Unreleased (Rodeo Era)"),
   "a named era is NOT an undifferentiated bucket");

/* ------------------------------------------------------------------------- */
console.log("\nreal albums must not be swept up");

// These are commercial releases. Misclassifying them protects them from split
// detection, which loses real findings.
for (const a of ["Rodeo", "ASTROWORLD", "Abbey Road", "Views", "Scorpion"]) {
  ok(!isEraTagged(a), `${JSON.stringify(a)} is not era-tagged`);
}

{
  // The interesting case. "Spotify Sessions" is a real release, so a bare
  // qualifier only counts when the same artist tags explicitly elsewhere.
  const s = (artist, album, track) => ({ uts: 1, artist, album, track });

  const noContext = partitionEra([
    s("Coldplay", "Spotify Sessions", "Yellow"),
    s("Coldplay", "Parachutes", "Shiver"),
  ]);
  eq(noContext.era.length, 0,
     "'Spotify Sessions' stays out of the era partition with no other evidence");
  eq(noContext.rest.length, 2, "so both scrobbles remain analysable");

  const withContext = partitionEra([
    s("Travis Scott", "Unreleased (Days Before Rodeo Era)", "Leak"),
    s("Travis Scott", "Rodeo Sessions", "Another Leak"),
    s("Coldplay", "Spotify Sessions", "Yellow"),
  ]);
  eq(withContext.era.length, 2,
     "'Rodeo Sessions' IS era-tagged for an artist who tags explicitly");
  eq(withContext.rest.length, 1, "and Coldplay is untouched by that inference");
}

/* ------------------------------------------------------------------------- */
console.log("\nD14f: the single-bucket convention");

{
  const era = [];
  for (let i = 0; i < 30; i++) {
    era.push({ uts: 1000 + i, artist: "Playboi Carti", album: "Unreleased",
               track: `Leak ${i}` });
  }
  const found = d14fSingleBucket(era);
  eq(found.length, 1, "one bucket with 30 tracks is reported");
  eq(found[0].class, "review", "as review, never error");
  ok(found[0].style_choice, "flagged as a style choice");
  ok(/perfectly \s*valid|nothing here is wrong/i.test(found[0].suggest),
     "and the wording says explicitly that nothing is wrong");
  ok(found[0].suggest.includes("Sessions"),
     "offering both the Era and Sessions conventions");
}

{
  // Below the threshold the suggestion is not worth making.
  const era = Array.from({ length: 3 }, (_, i) =>
    ({ uts: 1000 + i, artist: "X", album: "Unreleased", track: `T${i}` }));
  eq(d14fSingleBucket(era).length, 0, "3 tracks is under the threshold");
}

{
  // Named eras are not single buckets, so they must not be reported.
  const era = Array.from({ length: 30 }, (_, i) =>
    ({ uts: 1000 + i, artist: "X", album: "Unreleased (Rodeo Era)", track: `T${i}` }));
  eq(d14fSingleBucket(era).length, 0, "a named era is never reported by D14f");
}

{
  // Repeated plays of few tracks are not fragmentation. Threshold is on
  // DISTINCT tracks, not plays.
  const era = Array.from({ length: 60 }, (_, i) =>
    ({ uts: 1000 + i, artist: "X", album: "Unreleased", track: `T${i % 4}` }));
  eq(d14fSingleBucket(era).length, 0,
     "60 plays of 4 tracks is not reported: the threshold is distinct tracks");
}

/* ------------------------------------------------------------------------- */
console.log("\nD14f must not cap the score");

{
  const scrobbles = Array.from({ length: 30 }, (_, i) =>
    ({ uts: 1000 + i * 300, artist: "Carti", album: "Unreleased", track: `L${i}` }));
  const r = analyse(scrobbles);
  const d14f = r.issues.filter((i) => i.detector === "D14f");
  eq(d14f.length, 1, "analyse() emits the D14f finding");
  eq(r.hygiene.actionable, 0,
     "but it is not actionable, so a deliberate convention is not punished");
  eq(r.hygiene.score, 100,
     "and the score stays at 100: this is a valid way to tag");
}

/* ------------------------------------------------------------------------- */
console.log("\nmixed conventions still group correctly");

{
  // Same era, three spellings. D14a should see them as one era written three
  // ways now that all three yield a name.
  const era = [];
  const add = (album, n) => {
    for (let i = 0; i < n; i++) {
      era.push({ uts: 1000 + era.length, artist: "Travis Scott", album,
                 track: `T${i}` });
    }
  };
  add("Unreleased (Rodeo Era)", 5);
  add("Unreleased [Rodeo Era]", 4);
  add("Rodeo Sessions", 3);

  const names = new Set(era.map((s) => eraName(s.album)));
  eq(names.size, 1, "all three spellings resolve to one era name");
  eq([...names][0], "Rodeo", "namely Rodeo");

  const variants = d14aFormatVariants(era);
  ok(variants.length >= 1,
     `the bracket/word differences are reported as format variants (${variants.length})`);
  for (const v of variants) console.log(`       ${v.title}`);
}

/* ------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
