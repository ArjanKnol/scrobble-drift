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
  d14aFormatVariants, analyse, weakEraCandidates, officialKey, verifyEraNames,
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
  ok(isEraTagged(a), `${JSON.stringify(a)} looks like unreleased material`);
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
console.log("\nweak markers are real album titles too");

{
  // Lil Baby's 'The Leaks' is an officially released project. Classifying it as
  // unreleased did more than mislabel it: the era guard PROTECTS what it
  // matches, so the album stopped being checked for splits with no error
  // anywhere. Silently losing findings is worse than the visible mistake.
  const mk = (artist, album, track, n) => {
    const o = [];
    for (let i = 0; i < n; i++) o.push({ uts: 1600000000 + i, artist, album, track });
    return o;
  };

  let sc = [];
  for (let i = 0; i < 15; i++) sc = sc.concat(mk("Lil Baby", "The Leaks", `T${i}`, 1));
  sc = sc.concat(mk("Lil Baby", "My Turn", "Emotionally Scarred", 20));

  const p = partitionEra(sc);
  eq(p.era.length, 0,
     "'The Leaks' alone is NOT treated as unreleased material");
  ok(p.rest.some((x) => x.album === "The Leaks"),
     "so it stays analysable by the split detectors");
  eq(d14fSingleBucket(p.era).length, 0, "and D14f says nothing about it");

  // Corroborated: the same artist tags unreleased material explicitly, so now
  // the weak marker is evidence rather than a guess.
  const backed = partitionEra(
    sc.concat(mk("Lil Baby", "Unreleased (4PF Era)", "Some Leak", 5)));
  ok(backed.era.some((x) => x.album === "The Leaks"),
     "with explicit era tagging by the same artist, 'The Leaks' IS included");
  eq(d14fSingleBucket(backed.era).length, 1, "and D14f reports the bucket");
}

{
  /*
   * The case the heuristic CANNOT fix, and the reason a lookup is worth doing.
   *
   * Lil Baby has a real album called 'The Leaks' AND tags leaks with era names,
   * so corroboration is satisfied and the real album still gets swallowed.
   * Whether a release exists is a fact; "does this artist tag leaks elsewhere"
   * is only a correlation, and here the correlation is misleading.
   */
  const mk = (artist, album, track, n) => {
    const o = [];
    for (let i = 0; i < n; i++) o.push({ uts: 1600000000 + i, artist, album, track });
    return o;
  };
  let sc = [];
  for (let i = 0; i < 15; i++) sc = sc.concat(mk("Lil Baby", "The Leaks", `T${i}`, 1));
  sc = sc.concat(mk("Lil Baby", "Unreleased (4PF Era)", "Some Leak", 5));
  sc = sc.concat(mk("Lil Baby", "My Turn", "Emotionally Scarred", 20));

  const cands = weakEraCandidates(sc);
  eq(cands.length, 1, "exactly one album name needs a release lookup");
  eq(cands[0].album, "The Leaks", "namely 'The Leaks'");
  ok(!cands.some((c) => c.album === "Unreleased (4PF Era)"),
     "explicit markers are never looked up, so no budget is wasted");
  ok(!cands.some((c) => c.album === "My Turn"),
     "and ordinary albums are not either");

  ok(partitionEra(sc).era.some((x) => x.album === "The Leaks"),
     "without verification the heuristic still swallows it");

  const official = new Set([officialKey("Lil Baby", "The Leaks")]);
  const v = partitionEra(sc, { official });
  ok(!v.era.some((x) => x.album === "The Leaks"),
     "a verified real release is released from the protected partition");
  ok(v.rest.some((x) => x.album === "The Leaks"),
     "so split detection can see it");
  ok(v.era.some((x) => x.album === "Unreleased (4PF Era)"),
     "while the genuine leak bucket stays protected");
  eq(d14fSingleBucket(v.era).length, 0,
     "and it is no longer reported as an unreleased bucket");

  // analyse() must honour it too, not just partitionEra.
  const r = analyse(sc, { official });
  eq(r.issues.filter((i) => i.detector === "D14f" &&
                            i.album === "The Leaks").length, 0,
     "analyse() passes the verified set through");
}

{
  // A verified release must NOT override a strong marker: un-protecting a real
  // leak bucket is the more damaging error, and some artists do release records
  // literally titled 'Unreleased'.
  const sc = [
    { uts: 1, artist: "X", album: "Unreleased", track: "A" },
    { uts: 2, artist: "X", album: "Unreleased", track: "B" },
  ];
  const official = new Set([officialKey("X", "Unreleased")]);
  eq(partitionEra(sc, { official }).era.length, 2,
     "a strong marker stays protected even when the name exists as a release");
}

{
  // Callers that pass nothing must behave exactly as before.
  const sc = [{ uts: 1, artist: "Y", album: "The Leaks", track: "A" }];
  eq(partitionEra(sc).era.length, partitionEra(sc, {}).era.length,
     "omitting the option set changes nothing");
  eq(partitionEra(sc, { official: null }).era.length, 0,
     "and a null set is tolerated");
}

{
  // A strong marker needs no corroboration, ever.
  const one = partitionEra([
    { uts: 1, artist: "Nobody", album: "Unreleased (X Era)", track: "T" },
  ]);
  eq(one.era.length, 1, "a strong marker stands alone");

  const two = partitionEra([
    { uts: 1, artist: "Nobody", album: "Unreleased Leaks", track: "T" },
  ]);
  eq(two.era.length, 1,
     "and a weak word alongside a strong one is settled by the strong one");
}

{
  // Other real albums that would have been swallowed by weak markers.
  for (const album of ["The Leaks", "Outtakes", "Demos & Leftovers",
                       "Snippets"]) {
    const p = partitionEra([
      { uts: 1, artist: "Some Band", album, track: "A" },
      { uts: 2, artist: "Some Band", album: "Real Album", track: "B" },
    ]);
    eq(p.era.length, 0, `'${album}' alone is not swept into the era partition`);
  }
}

/* ------------------------------------------------------------------------- */
console.log("\na failed lookup is not a negative answer");

{
  /*
   * The reported bug. 'Rolling Papers 2' is a real 2018 Wiz Khalifa album, but
   * the tool announced it was not a real release. The lookup had failed, and
   * `Boolean(undefined)` made "no answer" indistinguishable from "no".
   *
   * Third occurrence of this exact shape, after the Spotify catalogue cache and
   * fetchCatalogue's error flag. Absence of an answer is not a negative answer.
   */
  const era = []; let uts = 1600000000;
  const add = (album, n) => {
    for (let i = 0; i < n; i++)
      era.push({ uts: uts++, artist: "Wiz Khalifa", album, track: `T${i}` });
  };
  add("Unreleased (Rolling Papers Era)", 1);
  add("Unreleased (Rolling Papers 2 Era)", 9);

  const found = d14aFormatVariants(era)
    .filter((i) => i.detector === "D14a" && i.verify);
  eq(found.length, 1, "the sequel-vs-typo finding is produced and needs checking");

  // Both lookups failed: must make NO claim either way.
  const unknown = verifyEraNames(found, () => null);
  eq(unknown.length, 1, "the finding survives");
  ok(/Could not check/.test(unknown[0].suggest),
     "and says the check did not happen");
  ok(!/does not/.test(unknown[0].suggest),
     "never claiming the album is not a real release");
  ok(unknown[0].confidence <= 0.25,
     `at minimal confidence (${unknown[0].confidence})`);

  // Half-known is still unknown: an asymmetry claim needs both sides.
  const half = verifyEraNames(found, (a, t) => t === "Rolling Papers" ? true : null);
  ok(/Could not check/.test(half[0].suggest),
     "one failed lookup is enough to withhold the claim");

  // Both verified present: not a typo, dropped entirely. This is the truth for
  // Wiz Khalifa, and what should have happened.
  eq(verifyEraNames(found, () => true).length, 0,
     "two real releases produce no finding at all");

  // A genuine verified asymmetry still gets the confident message.
  const real = verifyEraNames(found, (a, t) => t === "Rolling Papers");
  eq(real.length, 1, "a verified asymmetry is still reported");
  ok(/does not/.test(real[0].suggest),
     "and does state that the other one is absent");
  ok(real[0].confidence > 0.25, "at higher confidence than the unknown case");
}

{
  // false must still mean false: verified-absent is a real answer.
  const era = [{ uts: 1, artist: "A", album: "Unreleased (Foo Era)", track: "T" }];
  for (let i = 0; i < 9; i++)
    era.push({ uts: 2 + i, artist: "A", album: "Unreleased (Foo 2 Era)", track: `T${i}` });
  const found = d14aFormatVariants(era)
    .filter((i) => i.detector === "D14a" && i.verify);
  if (found.length) {
    const both = verifyEraNames(found, () => false);
    eq(both.length, 1, "neither existing is still a finding");
    ok(/normal for unreleased projects/.test(both[0].suggest),
       "described as normal for unreleased projects, not as an error");
  } else {
    ok(true, "(no verify-flagged pair in this fixture, skipped)");
  }
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
/* ------------------------------------------------------------------------- */
/* Appended: era findings must name the album string in the library, not the  */
/* extracted era name. Reporting 'Eternal Atake OG' when the library says    */
/* 'Unreleased (Eternal Atake OG Era)' forces the reader to work out which    */
/* entry is meant before they can act on it.                                 */
console.log("\nera findings name the library's album string");

{
  const { d14aFormatVariants: d14a, verifyEraNames: verify,
          eraVerificationPlan: plan } = await import("../docs/drift.js");
  const era = []; let uts = 1600000000;
  const add = (artist, album, track, n) => {
    for (let i = 0; i < n; i++) era.push({ uts: uts++, artist, album, track });
  };
  add("Lil Uzi Vert", "Unreleased (Eternal Atake Era)", "Leak A", 5);
  add("Lil Uzi Vert", "Unreleased (Eternal Atake OG Era)", "Leak B", 92);

  const found = d14a(era).filter((i) => i.detector === "D14a");
  eq(found.length, 1, "one similar-era finding");
  const i = found[0];

  ok(i.title.includes("Unreleased (Eternal Atake Era)"),
     "the title shows the full album string");
  ok(i.title.includes("Unreleased (Eternal Atake OG Era)"),
     "for both entries");
  ok(!/: 'Eternal Atake' vs/.test(i.title),
     "and not the bare extracted era name");
  ok(i.suggest.includes("Unreleased (Eternal Atake OG Era)"),
     "the suggestion names the album string too");

  eq(i.members.length, 2, "two members");
  ok(i.members.every((m) => m.album?.startsWith("Unreleased (")),
     "members carry album strings, so the UI can deep-link to them");
  ok(i.members.every((m) => m.era), "and keep the era name for context");

  // MusicBrainz must still be asked about the ERA NAME, not the album string:
  // 'Unreleased (Eternal Atake Era)' is not a release anyone has ever put out.
  const jobs = plan(found);
  ok(jobs.some((j) => j.title === "Eternal Atake"),
     "MusicBrainz is queried for the era name, not the album string");
  ok(!jobs.some((j) => j.title.includes("Unreleased")),
     "no lookup is wasted on an album string that cannot exist as a release");

  // And after the ruling the rewritten message still names the library entry.
  const ruled = verify(found, (a, t) => t === "Eternal Atake");
  ok(ruled[0].suggest.includes("Unreleased (Eternal Atake Era)"),
     "the post-MusicBrainz message names the library entry as well");
}

console.log(`\n${pass} passed, ${fail} failed (including appended block)\n`);
process.exit(fail ? 1 : 0);
