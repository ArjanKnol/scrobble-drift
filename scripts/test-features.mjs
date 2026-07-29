/**
 * D8 feature-credit tests.
 *
 * The false positive this exists for: baseTitle() strips the whole credit
 * clause, so two DIFFERENT recordings of a song collapse into one group.
 *
 *   'Roll in Peace (feat. XXXTENTACION)'   41 plays
 *   'Roll In Peace (feat. Travis Scott)'    2 plays
 *
 * Both reduce to 'roll in peace', so the tool advised standardising on the
 * first, which would have merged two distinct tracks. D8's premise is the same
 * RECORDING scrobbled with and without its credit, not merely the same base
 * title.
 *
 * Run: node scripts/test-features.mjs
 */
import { d8FeatureCredits, featCredits, baseTitle } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const lib = (spec) => {
  const out = []; let uts = 1600000000;
  for (const [artist, track, n] of spec)
    for (let i = 0; i < n; i++) out.push({ uts: uts++, artist, album: "A", track });
  return out;
};
const d8 = (spec) => d8FeatureCredits(lib(spec))
  .filter((i) => i.detector === "D8" && i.title.includes("title variants"));

/* ------------------------------------------------------------------------- */
console.log("\nfeatCredits extraction");

const set = (t) => [...featCredits(t)].sort().join("|");
eq(set("Roll in Peace (feat. XXXTENTACION)"), "xxxtentacion", "feat.");
eq(set("Knife Talk (with 21 Savage & Project Pat)"), "21 savage|project pat",
   "'with' plus an ampersand list");
eq(set("Song (ft. A, B, C)"), "a|b|c", "'ft.' plus a comma list");
eq(set("Song [feat. Drake]"), "drake", "square brackets");
eq(set("Roll in Peace"), "", "a bare title yields no credits");
eq(set("Dancing With Myself"), "",
   "an unbracketed 'with' is not a credit clause (real title)");
eq(set("Song (feat. A) (with B)"), "a|b", "multiple clauses are both collected");

/* ------------------------------------------------------------------------- */
console.log("\nthe reported false positive");

{
  const found = d8([
    ["Kodak Black", "Roll in Peace (feat. XXXTENTACION)", 41],
    ["Kodak Black", "Roll In Peace (feat. Travis Scott)", 2],
  ]);
  eq(found.length, 0,
     "two different featured artists are NOT reported as title variants");

  // Sanity: they really do share a base title, so the guard is what saved it.
  eq(baseTitle("Roll in Peace (feat. XXXTENTACION)").toLowerCase(),
     baseTitle("Roll In Peace (feat. Travis Scott)").toLowerCase(),
     "  (both do reduce to the same base title, so the group did form)");
}

/* ------------------------------------------------------------------------- */
console.log("\nthe intended case still works");

{
  // The GoldLink 'Crew' shape: one bare title, one credited version listing two
  // artists. This is the finding D8 exists for and must stay confident.
  const found = d8([
    ["GoldLink", "Crew", 27],
    ["GoldLink", "Crew (feat. Brent Faiyaz & Shy Glizzy)", 11],
  ]);
  eq(found.length, 1, "bare + one multi-artist feature is still reported");
  eq(found[0].class, "split", "as a split");
  ok(found[0].confidence >= 0.7, `at high confidence (${found[0].confidence})`);
  eq(found[0].plays_affected, 38, "with the full play count");
}

{
  const found = d8([
    ["Drake", "Knife Talk", 30],
    ["Drake", "Knife Talk (feat. 21 Savage)", 8],
  ]);
  eq(found.length, 1, "bare title vs credited title IS reported");
  eq(found[0].plays_affected, 38, "with both play counts");
}

{
  const found = d8([
    ["Drake", "Knife Talk (feat. 21 Savage)", 30],
    ["Drake", "Knife Talk (with 21 Savage)", 5],
  ]);
  eq(found.length, 1,
     "same artist credited with 'feat.' vs 'with' is still a variant");
}

{
  // Credit completeness: a subset is plausibly the same recording.
  const found = d8([
    ["Drake", "Knife Talk (feat. 21 Savage)", 20],
    ["Drake", "Knife Talk (feat. 21 Savage & Project Pat)", 9],
  ]);
  eq(found.length, 1, "a subset line-up is treated as the same recording");
}

/* ------------------------------------------------------------------------- */
console.log("\nconservative when a bare title is ambiguous");

{
  // A bare title alongside two different features IS a real finding: some of
  // those bare plays probably belong to one of them. Which one is unresolvable
  // from the data, so it is reported at the lowest confidence in the report and
  // must never recommend a merge.
  const all = d8FeatureCredits(lib([
    ["Kodak Black", "Roll in Peace", 10],
    ["Kodak Black", "Roll in Peace (feat. XXXTENTACION)", 41],
    ["Kodak Black", "Roll In Peace (feat. Travis Scott)", 2],
  ])).filter((i) => !i.title.includes("Artist field"));

  eq(all.length, 1, "the ambiguous case is surfaced rather than dropped");
  const i = all[0];
  eq(i.class, "review", "as a review, not a split");
  ok(i.confidence <= 0.25, `at very low confidence (${i.confidence})`);
  ok(i.no_auto_action, "flagged as never automatable");
  ok(/Do NOT merge/.test(i.suggest), "and says explicitly not to merge");
  ok(/different recordings/.test(i.suggest), "explaining why");
  eq(i.plays_affected, 10,
     "plays_affected counts only the ambiguous untagged plays");
  ok(i.members.some((m) => m.looks_like === "no credit stated"),
     "members mark which variant has no credit");
  ok(i.members.some((m) => /feat\. xxxtentacion/.test(m.looks_like || "")),
     "and which artists each variant credits");
}

{
  // Two conflicting features with NO bare title: nothing to say at all.
  const found = d8([
    ["Kodak Black", "Roll in Peace (feat. XXXTENTACION)", 41],
    ["Kodak Black", "Roll In Peace (feat. Travis Scott)", 2],
  ]);
  eq(found.length, 0, "no bare title means no ambiguity, so no finding");
}

/* ------------------------------------------------------------------------- */
console.log("\nunrelated D8 behaviour is untouched");

{
  // The artist-field-pollution half of D8 must still fire.
  const all = d8FeatureCredits(lib([
    ["Drake", "Song", 50],
    ["Drake feat. Future", "Song", 6],
  ]));
  const pollution = all.filter((i) => i.title.includes("Artist field"));
  eq(pollution.length, 1, "artist field containing a feature is still an error");
  eq(pollution[0].class, "error", "and still classed as an error");
}

{
  // Three genuinely different features: no finding, no crash.
  const found = d8FeatureCredits(lib([
    ["X", "Song (feat. A)", 10],
    ["X", "Song (feat. B)", 9],
    ["X", "Song (feat. C)", 8],
  ])).filter((i) => !i.title.includes("Artist field"));
  eq(found.length, 0, "three distinct features with no bare title say nothing");
}

/* ------------------------------------------------------------------------- */
console.log("\ntrack identity preserves symbols");

{
  const { trackIdentity, d4AlbumSplits } = await import("../docs/drift.js");

  ok(trackIdentity("@ MEH") !== trackIdentity("Meh"),
     "'@ MEH' and 'Meh' are different tracks");
  eq(trackIdentity("@ MEH"), trackIdentity("@MEH"),
     "but spacing around the symbol is normalised");
  ok(trackIdentity("$ELF TITLED") !== trackIdentity("ELF TITLED"),
     "'$ELF TITLED' and 'ELF TITLED' are different tracks");
  eq(trackIdentity("Don't"), trackIdentity("Don\u2019t"),
     "apostrophe styles still agree");
  ok(trackIdentity("Back Home") !== trackIdentity("Back Hom\u00eb"),
     "diacritics are still preserved");

  // The reported case, end to end.
  const rest = []; let uts = 1600000000;
  const add = (album, track, n) => {
    for (let i = 0; i < n; i++)
      rest.push({ uts: uts++, artist: "Playboi Carti", album, track });
  };
  add("@ MEH", "@ MEH", 21);
  add("Whole Lotta Red", "Meh", 18);
  eq(d4AlbumSplits(rest).length, 0,
     "'@ MEH' is no longer reported as a split of 'Meh'");

  // And a genuine split is still caught.
  const rest2 = []; uts = 1600000000;
  const add2 = (album, track, n) => {
    for (let i = 0; i < n; i++)
      rest2.push({ uts: uts++, artist: "Pale", album, track });
  };
  add2("Not In Love - Single", "Not In Love", 9);
  add2("Youth", "Not In Love", 7);
  eq(d4AlbumSplits(rest2).length, 1, "a real split is still detected");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
