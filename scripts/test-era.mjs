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
  d14cTrackInTwoEras,
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
  // The reported pair is now dropped BEFORE any lookup, because 'Rolling Papers'
  // vs 'Rolling Papers 2' is a version pair and those are never typos. So the
  // Wiz Khalifa complaint is fixed twice over.
  {
    const era = []; let uts = 1600000000;
    era.push({ uts: uts++, artist: "Wiz Khalifa",
               album: "Unreleased (Rolling Papers Era)", track: "T" });
    for (let i = 0; i < 9; i++)
      era.push({ uts: uts++, artist: "Wiz Khalifa",
                 album: "Unreleased (Rolling Papers 2 Era)", track: `U${i}` });
    eq(d14aFormatVariants(era).filter((i) => /typo|Similar era/.test(i.title)).length,
       0, "'Rolling Papers' vs 'Rolling Papers 2' never reaches a lookup at all");
  }

  // The three-state logic still matters for genuine typos, which DO get checked.
  const era = []; let uts = 1600000000;
  const add = (album, n) => {
    for (let i = 0; i < n; i++)
      era.push({ uts: uts++, artist: "Kanye West", album, track: `T${i}` });
  };
  add("Unreleased (Yhandi Era)", 1);
  add("Unreleased (Yandhi Era)", 9);

  const found = d14aFormatVariants(era)
    .filter((i) => i.detector === "D14a" && i.verify);
  eq(found.length, 1, "a real typo is produced and flagged for checking");

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
  const half = verifyEraNames(found, (a, t) => t === "Yandhi" ? true : null);
  ok(/Could not check/.test(half[0].suggest),
     "one failed lookup is enough to withhold the claim");

  // Both verified present: not a typo, dropped entirely. This is the truth for
  // Wiz Khalifa, and what should have happened.
  eq(verifyEraNames(found, () => true).length, 0,
     "two real releases produce no finding at all");

  // A genuine verified asymmetry still gets the confident message.
  const real = verifyEraNames(found, (a, t) => t === "Yandhi");
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
console.log("\na track in two eras must be linkable");

{
  // The finding is about ONE specific song, but it offered only a link to the
  // artist's whole library: the issue carried no `track`, and the members held
  // era NAMES, which are not linkable to anything.
  const era = []; let uts = 1600000000;
  const add = (album, n) => {
    for (let i = 0; i < n; i++)
      era.push({ uts: uts++, artist: "Kanye West", album, track: "All The Love" });
  };
  add("Unreleased (BULLY Era)", 7);
  add("Unreleased (Cuck Era)", 4);

  const f = d14cTrackInTwoEras(era)[0];
  ok(f, "the finding is produced");
  eq(f.track, "All The Love",
     "the issue names the track, so a track link can be built");

  const albums = f.members.filter((m) => m.album).map((m) => m.album);
  eq(albums.length, 2, "both album strings are members");
  ok(albums.includes("Unreleased (BULLY Era)") &&
     albums.includes("Unreleased (Cuck Era)"),
     "naming the strings as they appear in the library");
  ok(f.members.some((m) => m.era),
     "and the era names are still there for context");
  eq(f.plays_affected, 11, "play count unchanged");
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
}

{
  /*
   * The chart-inflation argument, which is the persuasive one.
   *
   * "You cannot see which project each track came from" is true but abstract.
   * The concrete consequence is that one bucket becomes a single enormous album
   * that can outrank every real record in the chart, and that is measurable.
   *
   * The examples also have to come from the artist's OWN catalogue. It used to
   * suggest "e.g. 'Unreleased (Rodeo Era)'" to everyone, which is useless to
   * anyone who does not listen to Travis Scott.
   */
  const sc = []; let uts = 1600000000;
  const add = (artist, album, track, n) => {
    for (let i = 0; i < n; i++) sc.push({ uts: uts += 300, artist, album, track });
  };
  for (let i = 0; i < 40; i++) add("Playboi Carti", "Unreleased", `Leak ${i}`, 9);
  add("Playboi Carti", "Whole Lotta Red", "Rockstar Made", 120);
  add("Playboi Carti", "Die Lit", "Shoota", 95);
  add("Drake", "Certified Lover Boy", "Knife Talk", 200);

  const f = analyse(sc).issues.filter((i) => i.detector === "D14f");
  eq(f.length, 1, "the bucket is reported");
  const i = f[0];

  eq(i.chart_rank, 1, "its chart rank is computed");
  ok(/#1 album/.test(i.title), "and named in the title");
  ok(/outranks every real album/.test(i.suggest),
     "the inflation is stated concretely, not as information loss");
  ok(/360 plays across 40 tracks/.test(i.suggest),
     "with the actual numbers");

  // Examples from this artist, not a hardcoded one.
  ok(i.suggest.includes("Unreleased (Whole Lotta Red Era)"),
     "examples use the artist's own most-played album");
  ok(i.suggest.includes("Unreleased (Die Lit Era)"),
     "and their second");
  ok(!/Rodeo/.test(i.suggest),
     "and never someone else's albums");
  ok(i.members.some((m) => m.looks_like?.includes("for comparison")),
     "their real albums are listed alongside for scale");

  // Still not scored: it remains a valid convention.
  eq(analyse(sc).hygiene.actionable, 0, "and it is still not actionable");
}

{
  // An artist with no released albums in the library must not borrow anyone
  // else's names for the example.
  const sc = []; let uts = 1600000000;
  for (let i = 0; i < 12; i++)
    for (let k = 0; k < 3; k++)
      sc.push({ uts: uts += 300, artist: "Obscure Act", album: "Unreleased",
                track: `Leak ${i}` });
  const f = d14fSingleBucket(
    sc, { rest: [{ uts: 1, artist: "Someone Else", album: "Their Album",
                   track: "T" }] });
  eq(f.length, 1, "still reported");
  ok(!/Their Album/.test(f[0].suggest),
     "another artist's album is never used as the example");
  ok(/Era name|whichever period/.test(f[0].suggest),
     "falling back to generic phrasing instead");
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
  // 'Eternal Atake' vs 'Eternal Atake OG' is a VERSION pair now, so it is
  // dropped before this point. Use a genuine typo to exercise the message.
  add("Lil Uzi Vert", "Unreleased (Eternl Atake Era)", "Leak A", 5);
  add("Lil Uzi Vert", "Unreleased (Eternal Atake Era)", "Leak B", 92);

  const found = d14a(era).filter((i) => i.detector === "D14a");
  eq(found.length, 1, "one era-name finding");
  const i = found[0];

  ok(i.title.includes("Unreleased (Eternl Atake Era)"),
     "the title shows the full album string");
  ok(i.title.includes("Unreleased (Eternal Atake Era)"),
     "for both entries");
  ok(!/: 'Eternl Atake' vs/.test(i.title),
     "and not the bare extracted era name");
  ok(i.suggest.includes("Unreleased (Eternal Atake Era)"),
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
  ok(ruled.length === 0 ||
     ruled[0].suggest.includes("Unreleased (Eternal Atake Era)"),
     "the post-lookup message names the library entry as well");
}

/* ---------------------------------------------------------------------------
 * The era name on the OUTSIDE of the bracket.
 *
 * "Eternal Atake (Sessions)". Real libraries use this heavily, and it was the
 * third instance of the same silent failure: BRACKETED_QUAL matched "(Sessions)"
 * with an EMPTY capture group, so the string counted as unreleased and was
 * protected from every other detector, while yielding no era name at all.
 *
 * The visible damage was D14f telling someone with 111 carefully named
 * Lil Uzi Vert tracks to "split them by era". He had. The name was just on the
 * other side of the bracket.
 * ------------------------------------------------------------------------- */
{
  const cases = [
    ["Eternal Atake (Sessions)",            "Eternal Atake"],
    ["Luv Is Rage (Sessions)",              "Luv Is Rage"],
    ["Eternal Atake [Sessions]",            "Eternal Atake"],
    ["Rodeo (Sesh)",                        "Rodeo"],
    ["Donda (Era)",                         "Donda"],
    ["Donda ( era )",                       "Donda"],
    ["DONDA (SESSIONS)",                    "DONDA"],
    // The marker may also lead. The era is still just Rodeo.
    ["Unreleased Rodeo (Sessions)",         "Rodeo"],
    // Inside-the-bracket form must keep working unchanged.
    ["Unreleased (Eternal Atake Sessions)", "Eternal Atake"],
    ["Unreleased (Rodeo Era)",              "Rodeo"],
  ];
  for (const [album, want] of cases) {
    ok(eraName(album) === want,
       `${JSON.stringify(album)} -> era ${JSON.stringify(want)} (got ${JSON.stringify(eraName(album))})`);
    ok(!isUndifferentiated(album),
       `${JSON.stringify(album)} counts as differentiated, so D14f leaves it alone`);
  }

  // The genuinely undifferentiated forms must still be caught, or the fix has
  // simply disabled the detector it was meant to correct.
  for (const album of ["Unreleased", "unreleased", "Leaks", "Snippets", "OG Files"]) {
    ok(eraName(album) === null, `${JSON.stringify(album)} still yields no era name`);
    ok(isUndifferentiated(album), `${JSON.stringify(album)} is still undifferentiated`);
  }

  // A bracket containing only the qualifier and NOTHING before it has no name to
  // extract, so it must not invent one out of the empty string.
  for (const album of ["(Sessions)", "  (Era) ", "[sesh]"])
    ok(eraName(album) === null,
       `${JSON.stringify(album)} has no name to take (got ${JSON.stringify(eraName(album))})`);

  // The end-to-end consequence: D14f must go quiet on a library that has already
  // named its eras this way.
  const named = [];
  for (const [alb, n] of [["Eternal Atake (Sessions)", 40],
                          ["Luv Is Rage (Sessions)", 35],
                          ["Lil Uzi Vert vs. The World (Sessions)", 36]])
    for (let i = 0; i < n; i++)
      named.push({ artist: "Lil Uzi Vert", album: alb, track: `t${i}`, uts: 1e9 + i });
  const era = partitionEra(named).era;
  ok(d14fSingleBucket(era).length === 0,
     "D14f says nothing to a library whose eras are named outside the bracket");
}

console.log(`\n${pass} passed, ${fail} failed (including appended block)\n`);
process.exit(fail ? 1 : 0);
