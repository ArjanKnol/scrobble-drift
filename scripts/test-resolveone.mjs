/**
 * Per-finding resolution: the foundation of the on-demand redesign.
 *
 * The scan resolves everything up front, and measurement killed that: a
 * 2,000-scrobble library produced 312 lookups and took twenty minutes to deliver
 * detail on findings nobody had opened. Attention is demand-driven, so resolution
 * should be too.
 *
 * What makes this safe is the split between ENRICHMENT and DISCOVERY. Enrichment
 * adds detail to a finding that already exists and is already correct, so nothing
 * disappears if it never runs. Discovery creates the finding, so it can never be
 * on demand: you cannot click something that is not on screen. Only enrichment
 * goes through resolveOne.
 *
 *     node scripts/test-resolveone.mjs
 */
import { resolveOne, isResolvable, RESOLVABLE } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const album = (title, date) =>
  ({ title, primary: "Album", secondary: [], first_release: date });
const split = () => ({
  detector: "D4", class: "split", artist: "Travis Scott", track: "Antidote",
  title: "'Antidote' is split across 2 albums", confidence: 0.7,
  members: [{ album: "Rodeo", plays: 10 }, { album: "Rodeo (Deluxe)", plays: 4 }],
});

/* ------------------------------------------------------------------------- */
console.log("\nwhich findings can be enriched at all");

ok(isResolvable({ detector: "D4" }), "D4, a split, has a consolidation target to find");
ok(isResolvable({ detector: "D5" }), "D5, a blank album, has an album name to find");
ok(isResolvable({ detector: "D8", verify_artist: "A & B" }),
   "D8 with a joint credit has an artist to verify");

/*
 * Discovery detectors must NOT offer a button. The finding only exists because a
 * lookup already ran, so there is nothing left to ask, and a button implying
 * otherwise would be a lie about what the tool knows.
 */
ok(!isResolvable({ detector: "D14e" }), "D14e is discovery, not enrichment");
ok(!isResolvable({ detector: "D16" }), "D16 is discovery too");
ok(!isResolvable({ detector: "D8" }),
   "a D8 feature credit with no joint name has nothing to look up");
ok(!isResolvable({ detector: "D6" }), "duplicates are decided locally");
ok(!isResolvable(null) && !isResolvable(undefined), "and nothing is not resolvable");

for (const d of RESOLVABLE) ok(typeof d === "string", `RESOLVABLE lists ${d}`);

/* ------------------------------------------------------------------------- */
console.log("\nresolving one split");
{
  const out = resolveOne(split(), () => ({ groups: [album("Rodeo", "2015-09-04")] }));
  eq(out.detector, "D0", "a resolved split becomes D0, which IS a resolved D4");
  ok(/consolidate to 'Rodeo'/.test(out.suggest), "and names the target");
  ok(/2015-09-04/.test(out.suggest), "with its release date");
  ok(out.resolved === true, "flagged resolved, so the UI can stop offering the button");
  ok(!out.unresolved, "and not flagged unresolved");
}

/* ---- the state that matters most: asked, and nothing came back ---------- */
{
  const out = resolveOne(split(), () => null);
  eq(out.detector, "D4", "with no answer the finding is unchanged");
  ok(out.resolved === true, "but marked as having been checked");
  ok(out.unresolved === true,
     "AND marked unresolved, so 'we asked and got nothing' is distinguishable " +
     "from 'we never asked'");

  const empty = resolveOne(split(), () => ({ groups: [] }));
  ok(empty.unresolved === true, "an empty answer is the same case");
}

/* ------------------------------------------------------------------------- */
console.log("\nresolving a blank album and a joint credit");
{
  const blank = { detector: "D5", artist: "Yeat", track: "Rich Minion",
                  class: "split", members: [] };
  const out = resolveOne(blank, () => ({ groups: [album("Lyfestyle", "2022")] }));
  ok(out.resolved === true, "D5 is marked resolved");
  eq(out.detector, "D5", "and stays a D5");

  const joint = { detector: "D8", class: "review", artist: "Future & Young Thug",
                  verify_artist: "Future & Young Thug", confidence: 0.6,
                  suggest: "Both exist solo.", title: "may be a collaboration" };

  // A real artist page settles it: the finding should go, not linger demoted.
  const real = resolveOne(joint, null, { artistExists: () => true });
  ok(real.dropped === true,
     "a joint credit that turns out to be a real act is marked dropped");

  const denied = resolveOne(joint, null, { artistExists: () => false });
  ok(denied.confidence > joint.confidence,
     `no artist page raises confidence  (${joint.confidence} -> ${denied.confidence})`);
  ok(!denied.dropped, "and it stays in the report");

  /*
   * The three-state rule, which this codebase has broken four times. An unknown
   * answer must leave the finding exactly as it was: neither promoted nor removed.
   */
  const unknown = resolveOne(joint, null, { artistExists: () => null });
  eq(unknown.confidence, joint.confidence, "an unknown answer changes nothing");
  ok(!unknown.dropped, "  and certainly does not drop the finding");
}

/* ------------------------------------------------------------------------- */
console.log("\nnothing is mutated");
{
  const original = split();
  const snapshot = JSON.stringify(original);
  resolveOne(original, () => ({ groups: [album("Rodeo", "2015")] }));
  eq(JSON.stringify(original), snapshot,
     "the input issue is untouched, so a half-updated finding can never render");

  // A detector with no resolver passes straight through, same object.
  const other = { detector: "D6", class: "error" };
  ok(resolveOne(other, () => ({ groups: [] })) === other,
     "an unresolvable finding is returned as-is, not copied or altered");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
