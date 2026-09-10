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
         applyRecordingVerdict, variantTiming } from "../docs/drift.js";

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
  eq(same.evidence, "same recording", "and names the evidence");
  /*
   * The answer lives in `verdict`, not appended to `suggest`.
   *
   * It used to be concatenated onto the end of the suggestion, which is why a
   * working lookup was reported as "nothing happens when I press the button": a
   * fetched fact arrived as a third sentence in the same paragraph and the same
   * colour as the guess it had just settled.
   */
  eq(same.verdict?.state, "same", "the answer is a field, not trailing text");
  ok(/provably correct/.test(same.verdict.text), "and says the merge is proven");

  /*
   * Asymmetric on purpose. Two recordings does not merely lower confidence: it
   * makes the suggestion WRONG, so the finding must stop recommending a merge.
   */
  const diff = applyRecordingVerdict(issue, "different");
  eq(diff.class, "review", "proof of two recordings stops it being an error");
  ok(diff.confidence < 0.2, `and drops confidence hard  (${diff.confidence})`);
  eq(diff.verdict?.state, "different", "and the verdict says so plainly");
  ok(/remix, a re-cut, or a guest verse/.test(diff.verdict.text),
     "the verdict explains what it actually found");
  ok(/Do not merge/.test(diff.verdict.text),
     "and withdraws the recommendation rather than softening it");
  ok(diff.suggest === null && diff.superseded === "Merge them.",
     "the original merge advice is RETIRED, not left printed above the verdict");
  ok(diff.resolved === true, "and it is marked checked, so no button reappears");

  /*
   * Unknown is an ANSWER and has to look like one.
   *
   * This used to return the issue untouched, so "checked, nobody knows" and
   * "never checked" were the same object. That is this codebase's most repeated
   * bug wearing a new hat: absence of an answer treated as no answer at all.
   */
  const unk = applyRecordingVerdict(issue, "unknown");
  ok(unk !== issue, "an unknown verdict still marks the finding as checked");
  eq(unk.verdict?.state, "unclear", "and says the databases could not settle it");
  eq(unk.class, issue.class, "without inventing a downgrade it cannot justify");
  eq(unk.confidence, issue.confidence, "or moving the confidence");
  ok(applyRecordingVerdict(null, "same") === null, "and nothing stays nothing");

  /*
   * The case that prompted all of this: Ye's 'I CAN'T WAIT'.
   *
   * The plain title ran March to June, the version credited to Ms. Lauryn Hill
   * June to August, both on the album BULLY. The album was revised after release
   * and the track was replaced, so these are two masters and merging them would
   * be wrong. The report looked up one title, said "Release data: 'BULLY'
   * (Album)", and went on recommending the merge.
   *
   * Sequential non-overlapping plays are the signal, and on their own they are
   * suggestive rather than conclusive: a change of music player produces the same
   * shape and IS an ordinary tagging inconsistency. So this must lower
   * confidence and explain itself, never assert.
   */
  const ye = {
    class: "split", confidence: 0.8, artist: "Kanye West",
    suggest: "standardise on 'I CAN'T WAIT'.",
    members: [
      { track: "I CAN'T WAIT", plays: 8, first: 1000, last: 2000 },
      { track: "I CAN'T WAIT (feat. Ms. Lauryn Hill)", plays: 5,
        first: 3000, last: 4000 },
    ],
  };
  const timing = variantTiming(ye);
  ok(timing, "non-overlapping variant plays are recognised");
  eq(timing.later, "I CAN'T WAIT (feat. Ms. Lauryn Hill)",
     "and the credited version is identified as the later one");
  ok(timing.gained_credit === true,
     "which is the direction a revised release produces");

  const revised = applyRecordingVerdict(ye, "unknown", timing);
  eq(revised.class, "review", "unconfirmed plus sequential is not an error");
  ok(revised.confidence < 0.5, `and confidence drops  (${revised.confidence})`);
  ok(/revised release/.test(revised.verdict.text),
     "the verdict names what this pattern usually is");
  ok(revised.suggest === null,
     "and stops telling the user to merge two probable masters");

  // Overlapping plays are concurrent, which is ordinary tagging drift.
  ok(variantTiming({ members: [
       { track: "a", first: 1000, last: 3000 },
       { track: "b", first: 2000, last: 4000 }] }) === null,
     "overlapping plays are not a revision signal");
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
  ok(/Release data: 'Rodeo' \(Album, 2015-09-04\)/.test(out.verdict?.text || ""),
     "and the verdict states what was found, with type and date");
  ok(/Two spellings\./.test(out.suggest),
     "leaving the original wording intact rather than appending to it");
  ok(/1 other release\./.test(out.verdict.text), "and counts the alternatives");

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

/* ---------------------------------------------------------------------------
 * D8 covers TWO different findings, and conflating them broke the button.
 *
 * A joint artist credit carries `verify_artist`; a track scrobbled under two
 * title variants does not. Every D8 took the joint-credit branch, where
 * d8VerifyJointCredits passed a title variant straight back untouched because it
 * had nothing to verify. The finding returned with no `resolved` flag, so the
 * button stayed, no note appeared, and pressing it did visibly nothing.
 *
 * Reported as "nothing happens when I press the button".
 * ------------------------------------------------------------------------- */
{
  const variant = {
    detector: "D8", class: "split", artist: "Fetty Wap",
    suggest: "standardise on the fuller spelling.",
    members: [{ track: "Trap Queen (feat. Azealia Banks)", plays: 1 },
              { track: "Trap Queen", plays: 1 }],
  };
  const found = { groups: [{ title: "Trap Queen", primary: "Single",
                             first_release: "2014-04-21" }] };

  const out = resolveOne(variant, () => found);
  ok(out.resolved === true,
     "a title variant comes back marked resolved, so the button clears");
  ok(!out.unresolved, "and not as unresolved, since data was found");
  eq(out.verdict?.state, "unclear",
     "no identifiers in the answer means the question is honestly unsettled");

  /*
   * ONE lookup, on the BARE title.
   *
   * This asserted two lookups, one per spelling, which was the design and was
   * wrong. No database has a track called `Trap Queen (feat. Azealia Banks,
   * Quavo & Gucci Mane)`: the guests are an artist credit, not part of the
   * title. Asking for it verbatim returns nothing from Spotify AND MusicBrainz,
   * verified live, so one side of every comparison was always empty.
   *
   * Searching the bare title returns every recording of the song, credits
   * included, and the matching happens locally. Correct and half the calls.
   */
  const asked = [];
  resolveOne(variant, (artist, track) => { asked.push([artist, track]); return found; });
  eq(asked.length, 1, "a two-variant finding costs ONE lookup, not two");
  eq(asked[0][0], "Fetty Wap", "the artist is passed through");
  eq(asked[0][1], "Trap Queen",
     "and the bare title is what gets looked up, not the decorated one");

  /*
   * Proof of two recordings, arriving from two different sources, must NOT be
   * read as proof. Spotify answers with an ISRC and MusicBrainz with a recording
   * ID, and the client falls back from one to the other, so a naive comparison
   * finds two disjoint sets and declares "different" on no evidence at all.
   */
  const byIsrc = { groups: [{ title: "T", isrc: "USUM71418036" }] };
  const byMbid = { groups: [{ title: "T", recording_id: "abc-123" }] };
  eq(sameRecording(byIsrc, byMbid), "unknown",
     "two identifier systems that never overlap cannot prove a difference");
  eq(sameRecording(byIsrc, { groups: [{ isrc: "usum71418036" }] }), "same",
     "and an ISRC match is case-insensitive");

  // A joint credit must still take its own branch.
  const joint = { detector: "D8", class: "review", confidence: 0.6,
                  verify_artist: "Future & Young Thug", suggest: "Both solo." };
  ok(resolveOne(joint, null, { artistExists: () => true }).dropped === true,
     "a joint credit still resolves via artist verification");

  // And a finding with nothing lookupable is still marked, never left blank.
  const bare = { detector: "D8", class: "split", artist: "X", members: [] };
  const b = resolveOne(bare, () => ({ groups: [] }));
  ok(b.resolved === true && b.unresolved === true,
     "no track to look up still counts as checked, so the button does not linger");
}

/* ---------------------------------------------------------------------------
 * The four cards that all said "Not confirmed", and why they had to.
 *
 * Last.fm scrobbles carry the feature credit in the TITLE. MusicBrainz and
 * Spotify put it in the ARTIST CREDIT and title the track bare, so looking up
 * `Love Never Felt So Good (feat. Justin Timberlake)` verbatim returns nothing
 * from either. Verified live against both upstreams. One half of every
 * comparison resolved, the other came back empty, and the check correctly
 * refused to call that a difference: honest, and useless on every single card.
 *
 * The fix searches the BARE title once and matches each spelling against the
 * recordings that come back, using the credit as the evidence.
 *
 * Payloads below are the real shapes from the live Worker, trimmed.
 * ------------------------------------------------------------------------- */
{
  const uts = (d) => Math.floor(new Date(d).getTime() / 1000);
  const issueFor = (artist, a, b) => ({
    detector: "D8", class: "split", confidence: 0.8, artist, track: a,
    suggest: `standardise on '${a}'.`,
    members: [
      { track: a, plays: 8, first: uts("2026-03-01"), last: uts("2026-06-01") },
      { track: b, plays: 5, first: uts("2026-06-20"), last: uts("2026-08-30") },
    ],
  });
  const verdictOf = (artist, a, b, answer) =>
    resolveOne(issueFor(artist, a, b), () => answer);

  // Michael Jackson: the Justin Timberlake duet is a separate recording, and
  // MusicBrainz distinguishes them only by the artist credit. Both titles are
  // the identical string.
  const mj = verdictOf("Michael Jackson", "Love Never Felt So Good",
    "Love Never Felt So Good (feat. Justin Timberlake)", { recordings: [
      { id: "bd744206", title: "Love Never Felt So Good",
        artists: ["Michael Jackson"] },
      { id: "91f73ec4", title: "Love Never Felt So Good",
        artists: ["Michael Jackson", "Justin Timberlake"] },
      { id: "dedb4931", title: "Love Never Felt So Good (Fedde Le Grand Remix)",
        artists: ["Michael Jackson"] },
    ]});
  eq(mj.verdict?.state, "different",
     "a duet credited to a guest is told apart from the solo version");

  /*
   * Fetty Wap: MusicBrainz writes the remixers into the recording TITLE rather
   * than the credit, so the bare spelling ties with the remix on credit alone.
   * Both score identically on "nobody is credited"; only exact title separates
   * them. That tie returned null and broke the two cases this was built for,
   * found by running the real payloads rather than by reading the code.
   */
  const fetty = verdictOf("Fetty Wap", "Trap Queen",
    "Trap Queen (feat. Azealia Banks, Quavo & Gucci Mane)", { recordings: [
      { id: "39fc36c2", title: "Trap Queen", artists: ["Fetty Wap"] },
      { id: "01333ea2",
        title: "Trap Queen (Azealia Banks, Quavo & Gucci Mane remix)",
        artists: ["Fetty Wap"] },
    ]});
  eq(fetty.verdict?.state, "different",
     "a remix named in the title is told apart from the original");

  // Kanye, from Spotify, where the guests are artists and the ISRCs differ.
  const ye = verdictOf("Kanye West", "I CAN’T WAIT",
    "I CAN’T WAIT (feat. Ms. Lauryn Hill)", { candidates: [
      { id: "163l4", name: "I CAN’T WAIT", artists: ["Kanye West"],
        isrc: "QZQAY2662999" },
      { id: "6ImNh", name: "I CAN’T WAIT",
        artists: ["Kanye West", "Ms. Lauryn Hill"], isrc: "QZTLA2629712" },
    ]});
  eq(ye.verdict?.state, "different", "and Spotify ISRCs settle it the same way");

  /*
   * ONE recording, two spellings: the genuine D8 this detector exists for.
   *
   * The song has always been a collaboration, so the only recording carries a
   * guest credit and the BARE spelling has to match it anyway. An earlier
   * version scored a credited candidate at zero for a title stating no credit,
   * which made a bare spelling unmatchable here and reported the pair as
   * unresolvable. Absence of a stated credit is not evidence the recording has
   * none: this codebase's oldest bug, reappearing inside the fix for it.
   */
  const same = verdictOf("Kanye West", "Runaway", "Runaway (feat. Pusha T)",
    { recordings: [{ id: "r1", title: "Runaway",
                     artists: ["Kanye West", "Pusha T"] }] });
  eq(same.verdict?.state, "same",
     "one recording under two spellings is confirmed mergeable");
  eq(same.confidence, 0.97, "with real confidence, because it is proven");

  /*
   * A credit no release has ever carried. Not silence, and not a merge
   * instruction either: the likeliest reading is that the tag is wrong.
   */
  const orphan = verdictOf("Adele", "Hello", "Hello (feat. Nobody)",
    { recordings: [{ id: "x1", title: "Hello", artists: ["Adele"] }] });
  eq(orphan.verdict?.state, "unclear", "an unknown credit is not called a version");
  ok(/No release of this song credits/.test(orphan.verdict.text),
     "and says what it actually found, rather than 'could not confirm'");
  ok(orphan.confidence > 0.3 && orphan.confidence < 0.6,
     `held at a middling confidence  (${orphan.confidence})`);

  // Nothing at all still has to stay distinguishable from all of the above.
  const silent = verdictOf("X", "A", "A (feat. B)", { recordings: [] });
  eq(silent.verdict?.state, "unclear", "an empty answer is still unclear");
  ok(!/No release of this song credits/.test(silent.verdict.text),
     "but must not claim a credit was missing when nothing was returned");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
