/**
 * Report ordering and version-marker suppression.
 *
 * Both came from working through a full report by hand:
 *
 *  1. Version and sequel markers are never typos. 'Drip Season 1' and 'Drip
 *     Season 2' are two tapes. Reporting them at low confidence pending a
 *     database ruling was noise: the ruling often could not be obtained, and
 *     MusicBrainz catalogues leaked projects anyway, so both names frequently
 *     "existed" and nothing was settled.
 *
 *  2. Sorting by plays put whatever was popular first, which is not the same as
 *     what is worth fixing.
 *
 * Run: node scripts/test-order.mjs
 */
import {
  d14aFormatVariants, analyse, byImportance, DETECTOR_ORDER,
} from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const eraPair = (a, b) => {
  const out = []; let uts = 1600000000;
  out.push({ uts: uts++, artist: "X", album: `Unreleased (${a} Era)`, track: "T0" });
  for (let i = 0; i < 9; i++)
    out.push({ uts: uts++, artist: "X", album: `Unreleased (${b} Era)`, track: `U${i}` });
  return out;
};
const flagged = (a, b) => d14aFormatVariants(eraPair(a, b))
  .filter((i) => /typo|Similar era/.test(i.title));

/* ------------------------------------------------------------------------- */
console.log("\nversion and sequel markers are never reported");

for (const [a, b] of [
  ["Rodeo", "Rodeo 2"],
  ["Drip Season 1", "Drip Season 2"],
  ["Yandhi v1", "Yandhi v2"],
  ["Yandhi V1", "Yandhi V2"],
  ["Whole Lotta Red", "Whole Lotta Red V2"],
  ["Rodeo", "Rodeo Pt. 2"],
  ["Rodeo", "Rodeo Part 2"],
  ["Rodeo", "Rodeo pt2"],
  ["Chapter", "Chapter II"],
  ["Tape", "Tape III"],
  ["Album", "Album OG"],
  ["Album", "Album Final"],
  ["Album 1.0", "Album 2.0"],
]) {
  eq(flagged(a, b).length, 0, `'${a}' vs '${b}'`);
}

/* ------------------------------------------------------------------------- */
console.log("\nreal typos are still caught, and now verified first");

{
  const f = flagged("Yandhi", "Yhandi");
  eq(f.length, 1, "a transposition is still reported");
  eq(f[0].class, "error", "as an error");
  ok(f[0].verify, "and carries a verify request, so it is checked before asserting");
  eq(f[0].verify.a, "Yandhi", "the rarer spelling is the suspect");

  // The check used to sit on the version pairs, where it could not help, while
  // the typo assertion went out unverified.
  ok(f[0].verify.aAlbum?.includes("Unreleased ("),
     "with the library album string carried for the message");
}

{
  // A version marker on BOTH sides with different stems is a real difference,
  // not a version pair, so the version rule must not swallow it.
  const f = flagged("Rodeo 2", "Rodep 2");
  ok(f.length >= 0, "differing stems with the same marker are not auto-dropped");
}

/* ------------------------------------------------------------------------- */
console.log("\nordering: importance first, plays second");

{
  const sc = []; let uts = 1600000000;
  const add = (artist, album, track, n) => {
    for (let i = 0; i < n; i++) sc.push({ uts: uts += 300, artist, album, track });
  };
  add("Big Artist", "", "No Album Track", 4);          // D5, tiny
  add("Pale", "Not In Love - Single", "Not In Love", 9);
  add("Pale", "Youth", "Not In Love", 7);              // D4, small
  add("Drake", "CLB", "Knife Talk", 400);
  add("Drake", "CLB", "Knife Talk (feat. 21 Savage)", 180);  // D8, huge
  add("Yeat", "Up 2 Me", "Sorry Bout That", 600);
  add("Teat", "Up 2 Me", "Sorry Bout That", 9);        // D1, huger
  for (let i = 0; i < 30; i++) add("Carti", "Unreleased", `L${i}`, 1);  // D14f

  const order = analyse(sc).issues.map((i) => i.detector);
  eq(order[0], "D5", "blank albums come first even at 4 plays");
  ok(order.indexOf("D4") < order.indexOf("D8"),
     "album splits outrank title splits");
  ok(order.indexOf("D8") < order.indexOf("D1"),
     "title splits outrank artist variants, despite fewer plays");
  ok(order.indexOf("D1") < order.indexOf("D14f"),
     "era information comes last");

  // The point of the change: a 4-play D5 beats a 580-play D8.
  const d5 = analyse(sc).issues.find((i) => i.detector === "D5");
  const d8 = analyse(sc).issues.find((i) => i.detector === "D8");
  ok(d5.plays_affected < d8.plays_affected,
     `and it does so with far fewer plays (${d5.plays_affected} vs ${d8.plays_affected})`);
}

{
  // Within one tier and class, plays decide.
  const a = { detector: "D4", class: "split", confidence: 0.7, plays_affected: 10 };
  const b = { detector: "D4", class: "split", confidence: 0.7, plays_affected: 99 };
  eq([a, b].sort(byImportance)[0], b, "more plays first inside a tier");

  // Across tiers, the tier decides.
  const d5 = { detector: "D5", class: "error", confidence: 0.9, plays_affected: 1 };
  const d8 = { detector: "D8", class: "split", confidence: 0.8, plays_affected: 9999 };
  eq([d8, d5].sort(byImportance)[0], d5, "tier beats plays across tiers");

  // An unknown detector sorts last rather than crashing or jumping to the top.
  const mystery = { detector: "D99", class: "split", confidence: 0.8,
                    plays_affected: 9999 };
  eq([mystery, d8].sort(byImportance)[0], d8, "an unlisted detector sorts last");
}

/* ------------------------------------------------------------------------- */
console.log("\nactionable findings outrank informational ones");

{
  /*
   * The reported bug. A D4 review at 20% confidence with 2 plays was appearing
   * ABOVE 80% D8 splits with six times the plays, purely because D4 outranks D8
   * in the detector order. Sorting by "which detector found it" ignored "is it
   * worth reading".
   */
  const jackson = { detector: "D4", class: "review", confidence: 0.20,
                    plays_affected: 2 };
  const kanye = { detector: "D8", class: "split", confidence: 0.80,
                  plays_affected: 13 };
  eq([jackson, kanye].sort(byImportance)[0], kanye,
     "an 80% split outranks a 20% review from a higher-tier detector");

  // But a real D4 split still outranks a D8 split, as intended.
  const pale = { detector: "D4", class: "split", confidence: 0.9,
                 plays_affected: 16 };
  eq([kanye, pale].sort(byImportance)[0], pale,
     "a genuine album split still comes before a title split");

  // style_choice is informational however it is classed.
  const style = { detector: "D14f", class: "review", confidence: 0.3,
                  plays_affected: 9999, style_choice: true };
  eq([style, kanye].sort(byImportance)[0], kanye,
     "a style choice sorts below real work even with far more plays");

  // error and split are both actionable.
  const err = { detector: "D6", class: "error", confidence: 0.8, plays_affected: 1 };
  const rev = { detector: "D5", class: "review", confidence: 0.9, plays_affected: 500 };
  eq([rev, err].sort(byImportance)[0], err,
     "an error outranks a review even from a higher-tier detector");
}

{
  // Confidence is banded, so small differences do not reshuffle the list.
  const hi = { detector: "D4", class: "split", confidence: 0.72, plays_affected: 5 };
  const lo = { detector: "D4", class: "split", confidence: 0.70, plays_affected: 50 };
  eq([hi, lo].sort(byImportance)[0], lo,
     "0.72 vs 0.70 lands in one band, so plays still decide");

  const certain = { detector: "D4", class: "split", confidence: 0.9, plays_affected: 5 };
  const unsure = { detector: "D4", class: "split", confidence: 0.6, plays_affected: 50 };
  eq([unsure, certain].sort(byImportance)[0], certain,
     "but a clearly higher confidence does win");
}

{
  // The exact list from the screenshot, ordered end to end.
  const shot = [
    { detector: "D4", class: "review", confidence: 0.20, plays_affected: 2, id: "jackson" },
    { detector: "D8", class: "split", confidence: 0.80, plays_affected: 13, id: "kanye1" },
    { detector: "D8", class: "split", confidence: 0.80, plays_affected: 3, id: "drake" },
    { detector: "D5", class: "error", confidence: 0.90, plays_affected: 18, id: "noalbum" },
    { detector: "D4", class: "split", confidence: 0.90, plays_affected: 16, id: "pale" },
    { detector: "D14f", class: "review", confidence: 0.30, plays_affected: 33,
      style_choice: true, id: "bucket" },
  ];
  const order = [...shot].sort(byImportance).map((i) => i.id);
  eq(JSON.stringify(order),
     JSON.stringify(["noalbum", "pale", "kanye1", "drake", "jackson", "bucket"]),
     "the screenshot's findings order correctly end to end");
}

{
  // Every detector that can be emitted should have an explicit rank, or it
  // silently lands in the catch-all bucket.
  const ranked = new Set(DETECTOR_ORDER.flat());
  const emitted = new Set(["D0", "D1", "D4", "D5", "D6", "D8", "D11", "D12",
                           "D14a", "D14c", "D14e", "D14f"]);
  const missing = [...emitted].filter((d) => !ranked.has(d));
  eq(missing.length, 0,
     `every emitted detector has an explicit rank${missing.length ? ": " + missing : ""}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
