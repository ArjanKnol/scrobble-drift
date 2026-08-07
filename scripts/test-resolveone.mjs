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
import { resolveOne, isResolvable, RESOLVABLE, sameRecording,
         applyRecordingVerdict } from "../docs/drift.js";

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
ok(isResolvable({ detector: "D8" }),
   "a D8 feature credit can still be asked about: one recording, or two versions");
ok(!isResolvable({ detector: "D6" }), "duplicates are decided locally");
ok(!isResolvable({ detector: "D12" }), "and so are impossible timestamps");

/*
 * The set was three detectors, which answered the wrong question. The right one
 * is "could a lookup settle this?", and for nearly every finding it could: which
 * spelling the databases use (D1), whether a release is really a compilation
 * (D11), what artist it is credited to (D15). Only timestamp arithmetic is purely
 * local.
 */
for (const d of ["D1", "D11", "D15", "D14a", "D14c"])
  ok(isResolvable({ detector: d }), `${d} has a question a database can answer`);

// A finding already checked must not offer the button again.
ok(!isResolvable({ detector: "D4", resolved: true }),
   "an already-resolved finding offers no button");
ok(!isResolvable({ detector: "D4", dropped: true }),
   "nor does a dropped one");
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

/* ---------------------------------------------------------------------------
 * Same recording, or genuinely two versions?
 *
 * The question the report currently guesses at. "Sicko Mode" and "Sicko Mode
 * (feat. Drake)" might be one recording with the credit in the title, or two
 * different recordings where the featured version is a remix. String similarity
 * cannot tell them apart, and the consequences are asymmetric: merging two
 * distinct recordings destroys information and cannot be undone, while leaving a
 * real split alone merely leaves a report item.
 *
 * MusicBrainz gives every recording an ID, so this is answerable.
 * ------------------------------------------------------------------------- */
{
  const g = (...ids) => ({ groups: ids.map((id) => ({ recording_id: id })) });

  eq(sameRecording(g("r1", "r2"), g("r2")), "same",
     "a shared recording id proves one track under two names");
  eq(sameRecording(g("r1"), g("r9")), "different",
     "no shared id means two distinct recordings");

  /*
   * The third state, and the one this codebase has broken more than any other.
   * An absent id means nobody told us. Collapsing that into "different" would
   * silently stop recommending correct merges.
   */
  eq(sameRecording(g("r1"), { groups: [{ title: "no id here" }] }), "unknown",
     "an unlabelled release is unknown, not different");
  eq(sameRecording(null, null), "unknown", "no data at all is unknown");
  eq(sameRecording(g(), g("r1")), "unknown", "an empty side is unknown");

  /* ---- what the verdict does to a finding ------------------------------ */
  const issue = { class: "error", confidence: 0.9, suggest: "Merge them." };

  const same = applyRecordingVerdict(issue, "same");
  eq(same.confidence, 0.97, "proof of one recording justifies real confidence");
  eq(same.evidence, "same MusicBrainz recording", "and names the evidence");
  ok(/provably correct/.test(same.suggest), "and says the merge is proven");

  /*
   * Asymmetric on purpose. Two recordings does not merely lower confidence: it
   * makes the suggestion WRONG, so the finding must stop recommending a merge.
   */
  const diff = applyRecordingVerdict(issue, "different");
  eq(diff.class, "review", "proof of two recordings stops it being an error");
  ok(diff.confidence < 0.2, `and drops confidence hard  (${diff.confidence})`);
  ok(/likely a remix or a rework/.test(diff.suggest),
     "the suggestion explains what it actually found");
  ok(/Nothing to fix here/.test(diff.suggest),
     "and withdraws the recommendation rather than softening it");
  ok(!/Merge them/.test(diff.suggest),
     "the original merge advice is REPLACED, not appended to");
  ok(diff.resolved === true, "and it is marked checked, so no button reappears");

  ok(applyRecordingVerdict(issue, "unknown") === issue,
     "an unknown verdict returns the very same object, unchanged");
  ok(applyRecordingVerdict(null, "same") === null, "and nothing stays nothing");
}

/* ---------------------------------------------------------------------------
 * The generic resolver: what the databases actually hold.
 *
 * D1, D11, D15 and the era variants have no bespoke resolver yet, and waiting for
 * four of those before showing any button was the wrong trade. The raw answer is
 * useful on its own, and attaching it beats refusing to look.
 * ------------------------------------------------------------------------- */
{
  const groups = {
    groups: [
      { title: "Rodeo", primary: "Album", first_release: "2015-09-04" },
      { title: "Rodeo (Deluxe)", primary: "Album", first_release: "2016" },
    ],
  };
  const out = resolveOne(
    { detector: "D1", artist: "Kanye West", track: "Runaway", suggest: "Two spellings." },
    () => groups);

  ok(out.resolved === true, "a generic finding is marked resolved");
  eq(out.external?.title, "Rodeo", "the best match is attached for the UI");
  eq(out.candidates?.length, 2, "with the alternatives kept");
  ok(/Release data: 'Rodeo' \(Album, 2015-09-04\)/.test(out.suggest),
     "and the suggestion states what was found, with type and date");
  ok(/Two spellings\./.test(out.suggest),
     "appended to the original wording rather than replacing it");
  ok(/1 other release\./.test(out.suggest), "and counts the alternatives");

  // The distinction that must survive: asked and got nothing.
  const nothing = resolveOne({ detector: "D11", artist: "A", track: "B" },
                             () => ({ groups: [] }));
  ok(nothing.resolved === true && nothing.unresolved === true,
     "no data means checked AND unresolved, never silently blank");

  // Detectors with real resolvers must not fall through to the generic path.
  const split = resolveOne(
    { detector: "D4", artist: "Travis Scott", track: "Antidote",
      class: "split", members: [{ album: "Rodeo", plays: 9 }] },
    () => groups);
  eq(split.detector, "D0", "D4 still uses its own resolver, not the generic one");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
