/**
 * D16: a track played only as a single, which has since landed on an album.
 *
 * The gap: D4 finds a track under two album names and D0 picks which to
 * consolidate into, but both need BOTH halves present. Play the single on release
 * and never play the album afterwards and there is one album string, nothing to
 * compare, and silence from every detector. The play is stranded and the album
 * chart never sees it.
 *
 * The source matters more than usual here. Last.fm's own track-to-album mapping
 * would be the natural answer and is the wrong one: it is user-contributed, holds
 * plenty of invented entries, and is least reliable exactly where an unreleased-
 * heavy library is densest. Acting on it would mean moving real plays on the word
 * of an anonymous edit. So the authority is the curated lookup D0 already uses.
 *
 *     node scripts/test-stranded.mjs
 */
import { singleShaped, d16Candidates, d16StrandedSingles } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)})`);

const play = (artist, track, album, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ artist, track, album, uts: 1e9 + i }));

/** A lookup in D0's shape: artist+track -> release groups. */
const lookupFrom = (table) => (artist, track) => table[`${artist}|${track}`] || null;
const album = (title, first_release, extra = {}) =>
  ({ title, primary: "Album", secondary: [], first_release, ...extra });

/* ------------------------------------------------------------------------- */
console.log("\nsingleShaped: deciding candidates without spending a lookup");

ok(singleShaped("Octane", "Octane"), "album string equal to the track title");
ok(singleShaped("Octane - Single", "Octane"), "explicit '- Single' suffix");
ok(singleShaped("Octane (Single)", "Octane"), "bracketed Single");
ok(singleShaped("Octane – Single", "Octane"), "en dash, which Spotify uses");
ok(singleShaped("Sicko Mode", "Sicko Mode (feat. Drake)"),
   "feature credit stripped before comparing, so the single still matches");
ok(!singleShaped("Rodeo", "Octane"), "a real album is not single-shaped");
ok(!singleShaped("UTOPIA", "MY EYES"), "nor is one with an unrelated title");
ok(!singleShaped("", "Octane") && !singleShaped("Octane", ""),
   "missing values are not candidates");

/*
 * Deliberately NOT inferred from "this album string has one track in the
 * library". An album someone played exactly one track from looks identical by
 * that test, and there are far more of those than there are singles.
 */
ok(!singleShaped("Astroworld", "Stargazing"),
   "one-track-in-library is not used as a signal, so real albums stay silent");

/* ------------------------------------------------------------------------- */
console.log("\nd16Candidates: what is worth asking about");
{
  const rest = [
    ...play("Don Toliver", "Octane", "Octane", 3),
    ...play("Don Toliver", "No Idea", "Heaven or Hell", 12),
    ...play("Travis Scott", "Sicko Mode", "Sicko Mode - Single", 1),
  ];
  const c = d16Candidates(rest);
  eq(c.length, 2, "only the single-shaped strings become candidates");
  eq(c[0].track, "Octane", "ordered by plays, so a budget is spent where it counts");
  eq(c[0].plays, 3, "plays are counted per candidate");
  eq(d16Candidates(rest, { minPlays: 2 }).length, 1, "minPlays filters the tail");
  eq(d16Candidates([]).length, 0, "an empty library yields nothing");
  eq(d16Candidates(null).length, 0, "and so does no library at all");
}

/* ------------------------------------------------------------------------- */
console.log("\nd16StrandedSingles: the finding");
{
  const cands = d16Candidates(play("Don Toliver", "Octane", "Octane", 3));
  const look = lookupFrom({
    "Don Toliver|Octane": { groups: [album("Life of a DON", "2021-10-08")] },
  });

  const [f] = d16StrandedSingles(cands, look);
  ok(Boolean(f), "a single that later made an album is reported");
  eq(f.detector, "D16", "detector id");
  eq(f.class, "review", "reported as review, never as an error");
  ok(f.style_choice === true,
     "marked a style choice: playing the single was accurate history");
  eq(f.album, "Life of a DON", "the target is the album, not the single");
  eq(f.plays_affected, 3, "carries the plays that would move");
  ok(/Life of a DON/.test(f.suggest) && /2021-10-08/.test(f.suggest),
     "the suggestion names the album and its release date");
  ok(/did play the single/.test(f.suggest),
     "and says plainly that nothing here is wrong as history");
  ok(f.evidence === "From release data",
     `evidence is named so the reader can weigh it  (${f.evidence})`);
}

/* ---- silence, which is most of the work --------------------------------- */
{
  const cands = d16Candidates(play("Artist", "Song", "Song", 5));

  eq(d16StrandedSingles(cands, () => null).length, 0,
     "no lookup answer means no finding, rather than a guess");
  eq(d16StrandedSingles(cands, () => ({ groups: [] })).length, 0,
     "an empty answer is not treated as evidence of anything");

  // A single that never made an album is the common case and must be silent.
  eq(d16StrandedSingles(cands, () => ({
    groups: [{ title: "Song", primary: "Single", secondary: [] }] })).length, 0,
    "a single that stayed a single is silent");

  // A compilation contains the track, but re-tagging onto greatest hits is worse
  // than saying nothing. D0's rule, reused deliberately.
  eq(d16StrandedSingles(cands, () => ({
    groups: [{ title: "Greatest Hits", primary: "Album",
               secondary: ["Compilation"], first_release: "2020" }] })).length, 0,
    "a compilation is never offered as the target");

  // The album string already IS the album.
  const same = d16Candidates(play("Artist", "Song", "Song", 2));
  eq(d16StrandedSingles(same, () => ({
    groups: [album("Song", "2020")] })).length, 0,
    "when the canonical album shares the single's name, nothing is stranded");

  // Earliest album wins, matching D0.
  const multi = d16StrandedSingles(cands, () => ({ groups: [
    album("Deluxe Reissue", "2024"), album("The Album", "2019")] }));
  ok(multi.length === 1 && multi[0].album === "Deluxe Reissue",
     "the first Album-type group in the list is taken, as D0 does");
}

/* ---- owning the album is the confidence story --------------------------- */
{
  const cands = d16Candidates(play("Artist", "Song", "Song", 4));
  const look = () => ({ groups: [album("The Album", "2019")] });

  const [cold] = d16StrandedSingles(cands, look);
  const [warm] = d16StrandedSingles(cands, look,
                                    { owned: new Set(["the album"]) });

  ok(warm.confidence > cold.confidence,
     `already owning the album raises confidence (${cold.confidence} -> ${warm.confidence})`);
  ok(/already have plays/.test(warm.suggest),
     "and the wording says the re-tag merges into an entry you can see");
  ok(/create a new chart entry/.test(cold.suggest),
     "while not owning it says plainly that this invents an entry");

  /*
   * The phantom merge target, guarded. Adding plays to an album the library has
   * no entry for invents a chart position out of nothing, which is the bug that
   * had Graduation's 409 plays moving to a destination the user could not see.
   */
  ok(cold.chart_already_correct === true,
     "an unowned target is excluded from the chart simulation");
  ok(warm.chart_already_correct === false,
     "an owned one can be modelled, because the entry exists");
}

/* ---- grouping, without which this floods the report --------------------- */
{
  const rest = [
    ...play("Don Toliver", "Octane", "Octane", 3),
    ...play("Don Toliver", "Bus Stop", "Bus Stop", 2),
    ...play("Don Toliver", "Company", "Company - Single", 5),
    ...play("Other", "Thing", "Thing", 1),
  ];
  const look = lookupFrom({
    "Don Toliver|Octane":   { groups: [album("Life of a DON", "2021")] },
    "Don Toliver|Bus Stop": { groups: [album("Life of a DON", "2021")] },
    "Don Toliver|Company":  { groups: [album("Life of a DON", "2021")] },
    "Other|Thing":          { groups: [album("Some Record", "2020")] },
  });
  const found = d16StrandedSingles(d16Candidates(rest), look);

  eq(found.length, 2, "one card per destination album, not one per track");
  const don = found.find((f) => f.album === "Life of a DON");
  eq(don.members.length, 3, "all three tracks are listed as members");
  eq(don.plays_affected, 10, "and their plays are summed");
  ok(/3 tracks/.test(don.title), `the heading counts them  (${don.title})`);
  ok(don.members[0].plays >= don.members[1].plays,
     "members are ordered by plays");
  ok(/tagged 'Company - Single'/.test(JSON.stringify(don.members)),
     "each member says which single it is currently tagged under");
  ok(found[0].plays_affected >= found[1].plays_affected,
     "findings are ordered by plays affected");

  // Singular wording, because "1 tracks are" is the kind of thing people notice.
  const one = found.find((f) => f.album === "Some Record");
  ok(/1 track you only played as a single is on/.test(one.title),
     `singular reads correctly  (${one.title})`);
}

/* ------------------------------------------------------------------------- */
console.log("\ncombining the two sources");
/*
 * The two are good at different things. A curated release database is
 * trustworthy about the FACT that a track is on an album. Last.fm is not, being
 * user-editable, but it is the only source for the STRING a re-tag has to match
 * to merge in a Last.fm chart. So each is used for what it is good at, and
 * agreement between them raises confidence.
 */
{
  const cands = d16Candidates(play("A", "Song", "Song", 4));
  const curated = () => ({ groups: [album("The Album", "2019")] });
  const none = () => null;
  const lfm = (title) => () => ({ title });

  const one = (lookup, opts) => d16StrandedSingles(cands, lookup, opts)[0];

  const both   = one(curated, { lastfm: lfm("The Album") });
  const cur    = one(curated, {});
  const lfmOnly = one(none,   { lastfm: lfm("The Album") });

  ok(both.confidence > cur.confidence,
     `agreement beats release data alone (${cur.confidence} -> ${both.confidence})`);
  ok(cur.confidence > lfmOnly.confidence,
     `release data alone beats Last.fm alone (${lfmOnly.confidence} < ${cur.confidence})`);
  eq(both.evidence, "Release data and Last.fm agree", "agreement is stated");
  eq(lfmOnly.evidence, "From Last.fm only", "and so is the weak case");
  ok(/anyone can edit/.test(lfmOnly.suggest),
     "a Last.fm-only finding says outright that the source is user-editable");
  ok(!/anyone can edit/.test(cur.suggest),
     "and a corroborated one does not carry that warning");

  // Owning the album lifts every source, without reordering them.
  const held = { owned: new Set(["the album"]) };
  ok(one(curated, { ...held, lastfm: lfm("The Album") }).confidence >
     one(curated, held).confidence &&
     one(curated, held).confidence > one(none, { ...held, lastfm: lfm("The Album") }).confidence,
     "the ordering of sources holds whether or not the album is owned");
  ok(one(none, { ...held, lastfm: lfm("The Album") }).confidence >
     one(none, { lastfm: lfm("The Album") }).confidence,
     "Last.fm alone is stronger when your own library already holds the album");
}

/* ---- spelling differences corroborate, and change nothing else --------- */
{
  const cands = d16Candidates(play("A", "Song", "Song", 2));
  // Same record, different capitalisation. `norm` folds it, so these agree.
  const f = d16StrandedSingles(cands, () => ({ groups: [album("LIFE OF A DON", "2021")] }),
                               { lastfm: () => ({ title: "Life of a DON" }) })[0];
  eq(f.evidence, "Release data and Last.fm agree", "a case difference still agrees");
  ok(!f.disagreed, "and is not treated as a disagreement");
  /*
   * The curated title is kept. An earlier version switched to Last.fm's spelling
   * here, which could only ever change case or punctuation, since `norm` folds
   * exactly those before comparing. Capitalisation is not something a user can
   * act on, so that was a choice between two equivalent strings sold as a fix.
   */
  eq(f.album, "LIFE OF A DON",
     "the curated title is the target; a case difference is not worth switching for");
}

/* ---- genuine disagreement is surfaced, not silently resolved ----------- */
{
  const cands = d16Candidates(play("A", "Song", "Song", 2));
  const f = d16StrandedSingles(cands, () => ({ groups: [album("The Real Album", "2019")] }),
                               { lastfm: () => ({ title: "Something Else" }) })[0];
  eq(f.album, "The Real Album", "the curated title is used when they disagree");
  eq(f.evidence, "From release data", "and it does not count as corroboration");
  ok(/Something Else/.test(f.suggest),
     "the disagreement is shown, so the spelling can be checked before re-tagging");
}

/* ---- Last.fm naming the single back at us is not evidence -------------- */
{
  const cands = d16Candidates(play("A", "Song", "Song", 2));
  eq(d16StrandedSingles(cands, () => null,
       { lastfm: () => ({ title: "Song" }) }).length, 0,
     "Last.fm echoing the single's own name yields nothing");
  eq(d16StrandedSingles(cands, () => null,
       { lastfm: () => ({ title: "Song - Single" }) }).length, 0,
     "nor does it naming another single");
  eq(d16StrandedSingles(cands, () => null, {}).length, 0,
     "and with no Last.fm lookup supplied at all, nothing changes");
}

/* ---- a group takes the weakest evidence among its members -------------- */
{
  const rest = [...play("A", "One", "One", 3), ...play("A", "Two", "Two", 3)];
  const lookup = (a, t) => t === "One" ? ({ groups: [album("Rec", "2019")] }) : null;
  const lastfm = () => ({ title: "Rec" });
  const [f] = d16StrandedSingles(d16Candidates(rest), lookup, { lastfm });
  eq(f.members.length, 2, "both tracks group onto the one album");
  eq(f.evidence, "From Last.fm only",
     "one uncorroborated member drags the whole group down, rather than hiding");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
