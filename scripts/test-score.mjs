/**
 * Tests for hygieneScore.
 *
 * The bug these exist to prevent: a score of 100 shown directly above a list of
 * ten problems. That shipped, because the old formula was play-share against an
 * enormous denominator and because one detector was omitted from the buckets
 * entirely. Both are asserted here.
 *
 * Run: node scripts/test-score.mjs
 */

import { hygieneScore, SCORED_DETECTORS, UNSCORED_BY_DESIGN, analyse }
  from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
};
const eq = (a, b, msg) =>
  ok(Object.is(a, b), `${msg}  (got ${JSON.stringify(a)})`);

const issue = (detector, cls, plays) =>
  ({ detector, class: cls, plays_affected: plays, title: `${detector} ${plays}` });

/* ------------------------------------------------------------------------- */
console.log("\nthe invariant: 100 means nothing to fix");

{
  const h = hygieneScore(2000, [], 786);
  eq(h.score, 100, "a clean library scores exactly 100");
  eq(h.actionable, 0, "and reports zero actionable findings");
}

{
  // The exact shipped bug: 10 findings over 2,000 plays and 786 album strings
  // rendered as 100/100.
  const issues = [
    issue("D4", "split", 4), issue("D4", "split", 2), issue("D8", "split", 6),
    issue("D14a", "split", 3), issue("D14c", "review", 2),
    issue("D5", "review", 8), issue("D6", "error", 2), issue("D1", "split", 5),
    issue("D14e", "split", 12), issue("D11", "review", 3),
  ];
  const h = hygieneScore(2000, issues, 786);
  ok(h.score < 100, `10 findings can never score 100 (got ${h.score})`);
  /*
   * SEVEN, not ten. Three of the fixture's findings are `review` (D14c, D5, D11),
   * and a review is no longer a task: see "a review is not a task" below. This
   * assertion originally read 10 because at the time every class counted, which
   * is what produced "3 things you can fix" on a library whose three findings all
   * said "probably nothing to fix".
   *
   * What this block was actually written to pin down is unchanged and still
   * asserted directly above: ten findings can never render as 100/100.
   */
  eq(h.actionable, 7, "the seven error/split findings count as actionable");
  eq(issues.filter((i) => i.class === "review").length, 3,
     "and the other three are reviews, which are reported but not counted");
  console.log(`       score ${h.score}, subscores ` +
              JSON.stringify(h.subscores));
}

{
  // A single trivial finding must still break 100, or the headline lies.
  const h = hygieneScore(139000, [issue("D4", "split", 1)], 15013);
  ok(h.score < 100, `one finding in a 139k library still caps below 100 (got ${h.score})`);
  eq(h.score, 99, "and lands at 99, not 0: it is one small thing");
}

{
  // Unfixable findings are not actionable, so they must NOT break 100.
  const h = hygieneScore(2000, [issue("D7", "unfixable", 500)], 786);
  eq(h.score, 100, "an unfixable finding leaves the score at 100");
  eq(h.actionable, 0, "because there is nothing the user can do about it");
}

/* ------------------------------------------------------------------------- */
console.log("\nD14e is scored (the omission that caused the bug)");

{
  ok(SCORED_DETECTORS.has("D14e"), "D14e is in a bucket");
  const h = hygieneScore(2000, [issue("D14e", "split", 40)], 786);
  ok(h.score < 100, "and a D14e-only report does not score 100");
  ok(h.subscores.era_consistency < 100, "it lands in era_consistency");
  eq(h.issue_counts.era_consistency, 1, "and is counted there");
}

{
  // Every detector analyse() can emit must score somewhere. This is the guard
  // against the same class of bug recurring when a detector is added.
  const scrobbles = [];
  let uts = 1600000000;
  const add = (artist, album, track, n) => {
    for (let i = 0; i < n; i++) scrobbles.push({ uts: uts += 300, artist, album, track });
  };
  add("A", "Single Version", "Song", 5);
  add("A", "The Album", "Song", 5);
  add("A", "", "No Album Song", 4);
  add("B", "Unreleased (X Era)", "Leak", 3);
  add("B", "UNRELEASED (X ERA)", "Leak", 2);
  add("C", "Various Artists", "Comp Track", 2);
  add("D", "Rec", "Feat Song", 3);
  add("D", "Rec", "Feat Song (feat. E)", 2);

  const report = analyse(scrobbles);
  /*
   * `style_choice` and `UNSCORED_BY_DESIGN` are excluded, and the distinction
   * matters: the bug this guards against was D14e scoring nothing by ACCIDENT.
   * A deliberate exclusion has to be declared in drift.js, so a detector cannot
   * quietly slip out of the score by being forgotten.
   */
  const emitted = new Set(report.issues
    .filter((i) => i.class !== "unfixable" && !i.style_choice)
    .map((i) => i.detector));
  const unscored = [...emitted]
    .filter((d) => !SCORED_DETECTORS.has(d) && !UNSCORED_BY_DESIGN.has(d));
  eq(unscored.length, 0,
     `every actionable detector analyse() emits is scored${
       unscored.length ? " — MISSING: " + unscored.join(", ") : ""}`);
  console.log(`       detectors emitted: ${[...emitted].sort().join(", ")}`);
  ok(report.hygiene.score < 100,
     `a report with ${report.issues_total} issues scores ${report.hygiene.score}`);
}

/* ------------------------------------------------------------------------- */
console.log("\nseverity and play weighting");

{
  const err = hygieneScore(2000, [issue("D6", "error", 10)], 786).score;
  const spl = hygieneScore(2000, [issue("D6", "split", 10)], 786).score;
  const rev = hygieneScore(2000, [issue("D6", "review", 10)], 786).score;
  ok(err <= spl && spl <= rev,
     `error hurts at least as much as split, split as much as review (${err} <= ${spl} <= ${rev})`);
}

{
  const few = hygieneScore(2000, [issue("D4", "split", 2)], 786).score;
  const many = hygieneScore(2000, [issue("D4", "split", 400)], 786).score;
  ok(many <= few,
     `a 400-play split scores no better than a 2-play one (${many} <= ${few})`);
  // Sub-linear on purpose: 200x the plays must not be 200x the penalty, or one
  // heavily played album would sink the whole score by itself.
  ok(100 - many < (100 - few) * 8,
     "but the penalty grows sub-linearly, so one album cannot dominate");
}

{
  const one = hygieneScore(2000, [issue("D4", "split", 5)], 786).score;
  const twenty = hygieneScore(
    2000, Array.from({ length: 20 }, () => issue("D4", "split", 5)), 786).score;
  ok(twenty < one, `20 findings score worse than 1 (${twenty} < ${one})`);
}

/* ------------------------------------------------------------------------- */
console.log("\nsize independence: the core fix");

{
  // The old formula rewarded listening more. Same number of problems in a small
  // and a large library must now score comparably, because the denominator is
  // album strings and both have proportionally similar curation debt.
  const ten = Array.from({ length: 10 }, (_, i) => issue("D4", "split", 5 + i));
  const small = hygieneScore(2000, ten, 786).score;
  const large = hygieneScore(139000, ten, 786).score;
  eq(small, large, "score does not change with play count at equal album strings");

  // And a bigger library with the same absolute debt scores better, which is
  // correct: 10 problems across 15,000 albums IS tidier than across 786.
  const wide = hygieneScore(139000, ten, 15013).score;
  ok(wide > small, `10 issues across 15k strings beats 10 across 786 (${wide} > ${small})`);
  ok(wide < 100, "but still not perfect");
}

/* ------------------------------------------------------------------------- */
console.log("\nbounds and degenerate input");

{
  eq(hygieneScore(0, [], 0).score, 100, "empty library scores 100");
  const flood = Array.from({ length: 5000 }, () => issue("D4", "error", 500));
  const h = hygieneScore(2000, flood, 786);
  ok(h.score >= 0, "a flood of findings cannot go negative");
  /*
   * 1, not 0, and never 0.
   *
   * The curve is hyperbolic now, so it approaches zero without arriving. That is
   * deliberate twice over. It means the score keeps discriminating at the bad end
   * instead of clamping — the old linear form bottomed out at about 48 findings,
   * so fixing 165 of 220 problems moved the overall score not at all. And the
   * overall score is a geometric mean, which multiplies the buckets, so a single
   * zero would drag the whole thing to zero however clean everything else was.
   */
  eq(h.subscores.album_integrity, 1,
     "a flood floors the bucket at 1, never 0, so the geometric mean survives");
  ok(h.score > 0, "and the overall score stays above zero");

  // The property that matters more than any single value: it never stops moving.
  const at = (n) => hygieneScore(10000,
    Array.from({ length: n }, () => issue("D4", "split", 6)), 1500).score;
  const steps = [220, 165, 110, 55, 20, 5, 1, 0].map(at);
  ok(steps.every((v, i) => i === 0 || v > steps[i - 1]),
     `every fix raises the score: ${steps.join(" -> ")}`);
  eq(steps.at(-1), 100, "and a fully cleaned library reaches 100");
}

{
  // Callers that predate the albumStrings argument must still work.
  const h = hygieneScore(2000, [issue("D4", "split", 5)]);
  ok(h.score < 100 && h.score >= 0, "omitting albumStrings still yields a sane score");
  eq(h.album_strings, null, "and reports it as unknown rather than inventing one");
}

{
  // A tiny library must not be savaged. With no denominator floor, 11 album
  // strings bottomed out a whole bucket on ONE split, which is noise rather
  // than information.
  const h = hygieneScore(60, [issue("D4", "split", 16)], 11);
  ok(h.subscores.album_integrity > 50,
     `one split in an 11-string library stays well above 0 (got ${h.subscores.album_integrity})`);
  ok(h.score < 100, "but still is not perfect");

  // And the floor must not flatten everything: more findings still score worse.
  const worse = hygieneScore(
    60, Array.from({ length: 12 }, () => issue("D4", "split", 16)), 11);
  ok(worse.score < h.score,
     `12 findings in the same small library still scores worse (${worse.score} < ${h.score})`);
}

/* ---------------------------------------------------------------------------
 * A `review` is not a task.
 *
 * `review` used to weigh 0.75, so a library whose only findings were
 * low-confidence reviews — every one of them saying "this is probably nothing to
 * fix" — was capped below 100 and told it had "3 things you can fix". Found on a
 * real 329-scrobble library: three D4 reviews, two of them MusicBrainz-DISPROVEN
 * at 15% confidence, and the report still claimed three actionable items.
 *
 * That breaks the one rule the whole score rests on, stated in the README:
 * 100 is reserved for a library with nothing left to fix.
 * ------------------------------------------------------------------------- */
{
  const review = (n, conf = 0.15) =>
    Array.from({ length: n }, () => ({
      detector: "D4", class: "review", confidence: conf, plays_affected: 3,
    }));

  const only = hygieneScore(329, review(3), 101);
  ok(only.score === 100,
     `three "probably nothing" reviews leave a perfect score (got ${only.score})`);
  ok(only.actionable === 0,
     `and count as nothing to fix (got ${only.actionable})`);

  // Not even a lot of them, because quantity does not turn a maybe into a task.
  const many = hygieneScore(329, review(25), 101);
  ok(many.score === 100 && many.actionable === 0,
     `25 reviews still leave 100/0 (got ${many.score}/${many.actionable})`);

  // Confidence must not smuggle one back in either.
  const confident = hygieneScore(329, review(3, 0.95), 101);
  ok(confident.score === 100 && confident.actionable === 0,
     "a high-confidence review is still only a review");

  // But a real finding alongside them must still register, and must be counted
  // ONCE: the reviews neither add to nor mask it.
  const mixed = hygieneScore(
    329, [...review(3), { detector: "D4", class: "split", confidence: 0.9, plays_affected: 16 }], 101);
  ok(mixed.actionable === 1,
     `one split among three reviews is exactly one thing to fix (got ${mixed.actionable})`);
  ok(mixed.score < 100, `and caps the score (got ${mixed.score})`);

  const alone = hygieneScore(
    329, [{ detector: "D4", class: "split", confidence: 0.9, plays_affected: 16 }], 101);
  ok(mixed.score === alone.score,
     `adding reviews does not move the score at all (${mixed.score} === ${alone.score})`);

  // `review` now sits with the other two free classes. Stated as one assertion so
  // that reintroducing a weight for any of them fails here rather than in the UI.
  for (const cls of ["review", "unfixable"]) {
    const free = hygieneScore(329, Array.from({ length: 4 }, () => ({
      detector: "D4", class: cls, confidence: 0.5, plays_affected: 5 })), 101);
    ok(free.score === 100 && free.actionable === 0,
       `class "${cls}" costs nothing (got ${free.score}/${free.actionable})`);
  }

  // A style choice was already free; confirm it did not regress on the way past.
  const style = hygieneScore(329, [{
    detector: "D14f", class: "review", confidence: 0.3,
    plays_affected: 111, style_choice: true }], 101);
  ok(style.score === 100 && style.actionable === 0,
     "a style choice costs nothing");
}

/* ---- a deliberate exclusion must be declared, not inferred -------------- */
{
  ok(UNSCORED_BY_DESIGN.has("D16"),
     "D16 is declared unscored, rather than silently missing from every bucket");
  ok(![...UNSCORED_BY_DESIGN].some((d) => SCORED_DETECTORS.has(d)),
     "nothing is both scored and declared unscored");

  // The reason it is allowed out: it can never emit a class that costs anything.
  const asError = hygieneScore(500, [{
    detector: "D16", class: "review", style_choice: true,
    confidence: 0.7, plays_affected: 40 }], 120);
  ok(asError.score === 100 && asError.actionable === 0,
     `a D16 finding costs nothing (${asError.score}/${asError.actionable})`);
}

/* ------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
