/**
 * D1 artist-variant tests, focused on the unfixable-casing problem.
 *
 * Last.fm cannot change only the capitalisation of a name, so those findings are
 * work nobody can do. The group-level skip handled groups where EVERY name was
 * casing-equal, but did nothing for a MIXED group, which is the common shape:
 *
 *   'Jaÿ-Z' 142   correct
 *   'JAŸ-Z'  99   casing-only, impossible
 *   'JAY Z'   4   genuinely fixable
 *
 * That reported "245 plays" and implied all three could be merged.
 *
 * Run: node scripts/test-variants.mjs
 */
import { d1ArtistVariants, caseOnly } from "../docs/drift.js";

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

/* ------------------------------------------------------------------------- */
console.log("\ncaseOnly is narrow on purpose");

ok(caseOnly("Jaÿ-Z", "JAŸ-Z"), "'Jaÿ-Z' / 'JAŸ-Z' is casing only");
ok(!caseOnly("Jaÿ-Z", "Jaÿ Z"), "hyphen vs space is NOT casing (it is fixable)");
ok(!caseOnly("Jaÿ-Z", "JAY Z"), "missing diaeresis is NOT casing");
ok(caseOnly("MØ", "mø"), "works on non-ASCII letters");
ok(caseOnly("Jaÿ-Z", "Jaÿ-Z".normalize("NFC")) === false ||
   caseOnly("Jaÿ-Z", "Jaÿ-Z"),
   "precomposed and decomposed diaereses compare equal");

/* ------------------------------------------------------------------------- */
console.log("\nthe reported case: mixed fixable and unfixable");

{
  const scrobbles = lib([
    ["Jaÿ-Z", "Dead Presidents II", 142],
    ["JAŸ-Z", "Dead Presidents II", 99],
    ["JAY Z", "Dead Presidents II", 4],
  ]);
  const found = d1ArtistVariants(scrobbles).filter((i) => i.detector === "D1");
  eq(found.length, 1, "one finding is produced");

  const i = found[0];
  const named = i.members.map((m) => m.artist);
  ok(!named.includes("JAŸ-Z"),
     "the casing-only variant is NOT listed as a member");
  ok(named.includes("Jaÿ-Z") && named.includes("JAY Z"),
     "the target and the fixable variant both are");
  ok(!i.title.includes("JAŸ-Z"), "and it does not appear in the title");
  eq(i.plays_affected, 146,
     "plays_affected excludes the 99 unfixable plays (was 245)");
  ok(/moves 4 plays/.test(i.suggest),
     `the suggestion states how many plays actually move: "${i.suggest}"`);
  ok(/rename 'JAY Z' to 'Jaÿ-Z'/.test(i.suggest),
     "and names exactly what to rename to what");
}

/* ------------------------------------------------------------------------- */
console.log("\ngroups with nothing fixable are dropped entirely");

{
  const scrobbles = lib([
    ["Jaÿ-Z", "Song", 142],
    ["JAŸ-Z", "Song", 99],
    ["jaÿ-z", "Song", 12],
  ]);
  const found = d1ArtistVariants(scrobbles).filter((i) => i.detector === "D1");
  eq(found.length, 0, "an all-casing group produces no finding at all");
}

/* ------------------------------------------------------------------------- */
console.log("\nordinary variants are unaffected");

{
  const scrobbles = lib([
    ["Melody's Echo Chamber", "Song", 40],
    ["Melody’s Echo Chamber", "Song", 8],
  ]);
  const found = d1ArtistVariants(scrobbles).filter((i) => i.detector === "D1");
  eq(found.length, 1, "an apostrophe-style difference is still reported");
  eq(found[0].plays_affected, 48, "with the full play count");
}

{
  const scrobbles = lib([
    ["Yeat", "Sorry Bout That", 200],
    ["Teat", "Sorry Bout That", 3],
  ]);
  const found = d1ArtistVariants(scrobbles).filter((i) => i.detector === "D1");
  eq(found.length, 1, "a short-name typo is still caught");
  ok(found[0].suggest.includes("'Yeat'"), "and consolidates to the right name");
}

{
  // Three genuinely different spellings, none casing-only: all should survive.
  const scrobbles = lib([
    ["Tyler, The Creator", "Song", 100],
    ["Tyler The Creator", "Song", 20],
    ["Tyler, the Creator!", "Song", 5],
  ]);
  const found = d1ArtistVariants(scrobbles).filter((i) => i.detector === "D1");
  ok(found.length >= 1, "punctuation variants are reported");
  const m = found[0].members.map((x) => x.artist);
  ok(m.length >= 2, `at least two members survive (${m.join(" / ")})`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
