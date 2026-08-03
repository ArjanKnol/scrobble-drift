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
console.log("\na single stray play is not a systematic split");

{
  // 14 tagged plays against 1 bare one. Reported, because the scrobble really
  // does exist, but as a one-off rather than a tagging habit, and WITH a date so
  // it can actually be found. Without the date the reader knows they never
  // scrobbled it that way, cannot locate the one that says otherwise, and
  // reasonably concludes the tool is wrong.
  const day = 86400;
  const mk = (track, n, start) => {
    const o = [];
    for (let i = 0; i < n; i++)
      o.push({ uts: start + i * day * 20, artist: "Drake",
               album: "For All The Dogs", track });
    return o;
  };
  const found = d8FeatureCredits(
    mk("IMY2 (with Kid Cudi)", 14, 1698000000).concat(mk("IMY2", 1, 1712000000)),
  ).filter((i) => i.title.includes("title variants"));

  eq(found.length, 1, "the finding is still produced");
  const i = found[0];
  ok(i.confidence < 0.8, `at reduced confidence (${i.confidence})`);
  ok(/One scrobble used a different spelling/.test(i.suggest),
     "described as one stray scrobble, not a habit");
  ok(/Barely worth fixing/.test(i.suggest),
     "and says plainly it is barely worth fixing");
  ok(!/standardise on/.test(i.suggest),
     "so it does not imply a chore");

  const bare = i.members.find((m) => m.track === "IMY2");
  ok(bare.first, "the stray member carries a timestamp");
  ok(bare.looks_like && /\d{4}/.test(bare.looks_like),
     `and a readable date (${bare.looks_like})`);
  eq(bare.plays, 1, "with its play count");

  const main = i.members.find((m) => m.track === "IMY2 (with Kid Cudi)");
  ok(/ to /.test(main.looks_like),
     `a multi-month variant shows a range (${main.looks_like})`);
}

{
  // An even split keeps full confidence and the original wording.
  const mk = (track, n, start) => {
    const o = [];
    for (let i = 0; i < n; i++)
      o.push({ uts: start + i * 86400, artist: "GoldLink", album: "At What Cost", track });
    return o;
  };
  const i = d8FeatureCredits(
    mk("Crew", 27, 1600000000)
      .concat(mk("Crew (feat. Brent Faiyaz & Shy Glizzy)", 11, 1620000000)),
  ).filter((x) => x.title.includes("title variants"))[0];

  eq(i.confidence, 0.8, "a genuine split stays at full confidence");
  ok(/standardise on/.test(i.suggest), "and still says standardise");
}

{
  // Two strays is still stray; three is a pattern.
  const mk = (track, n) => {
    const o = [];
    for (let i = 0; i < n; i++)
      o.push({ uts: 1600000000 + o.length * 86400, artist: "A", album: "B", track });
    return o;
  };
  const two = d8FeatureCredits(mk("Song (feat. X)", 40).concat(mk("Song", 2)))
    .filter((i) => i.title.includes("title variants"))[0];
  ok(two.confidence < 0.8, "two strays out of 42 is still a stray");

  const many = d8FeatureCredits(mk("Song (feat. X)", 20).concat(mk("Song", 8)))
    .filter((i) => i.title.includes("title variants"))[0];
  eq(many.confidence, 0.8, "8 out of 28 is a real split, not a stray");
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

/* ---------------------------------------------------------------------------
 * `&` and `,` are band-name separators, not feature markers.
 *
 * They used to sit in the same set as `feat.`, gated only on the text before the
 * separator also existing in the library. That is true for every duo whose
 * frontman has solo work, so D8 reported "Macklemore & Ryan Lewis" as an ERROR at
 * 90% confidence and told the owner to strip it to "Macklemore". Macklemore &
 * Ryan Lewis is an artist on Spotify, MusicBrainz and Last.fm; acting on that
 * advice would have damaged a correct library.
 *
 * Reported as "this is one of the few times an & is correct". It is not few, and
 * that is the point: the false-positive class here is enormous.
 * ------------------------------------------------------------------------- */
{
  const play = (artist, track, n, mbid = "") =>
    Array.from({ length: n }, (_, i) =>
      ({ artist, track, album: "Album", uts: 1e9 + i, artist_mbid: mbid }));
  const run = (combined, head, mbid = "") => {
    const rest = [...play(combined, "Track", 11, mbid), ...play(head, "Solo", 29)];
    return d8FeatureCredits(rest).find((i) => i.artist === combined) || null;
  };

  // Real acts that must never be flagged, all with the frontman present solo.
  for (const [combined, head] of [
    ["Macklemore & Ryan Lewis", "Macklemore"],
    ["Bob Marley & The Wailers", "Bob Marley"],
    ["Tom Petty & The Heartbreakers", "Tom Petty"],
    ["Nick Cave & The Bad Seeds", "Nick Cave"],
    ["Simon & Garfunkel", "Simon"],
    ["Angus & Julia Stone", "Angus"],
    ["Tyler, The Creator", "Tyler"],
    ["Earth, Wind & Fire", "Earth"],
  ]) {
    ok(run(combined, head) === null, `'${combined}' is not a feature credit`);
  }

  // Unambiguous markers must still be caught, and still as errors.
  for (const [combined, head] of [
    ["Drake feat. Future", "Drake"],
    ["Travis Scott ft. Drake", "Travis Scott"],
    ["Kanye West featuring Jay-Z", "Kanye West"],
    ["Future w/ Metro Boomin", "Future"],
  ]) {
    const f = run(combined, head);
    ok(f !== null, `'${combined}' is still caught`);
    eq(f?.class, "error", `  and is an error`);
    eq(f?.confidence, 0.9, `  at full confidence`);
  }

  // Genuinely ambiguous separators are reported as a question, not a defect.
  const x = run("Jack U x Skrillex", "Jack U");
  ok(x !== null, "' x ' is still reported");
  eq(x?.class, "review", "  but only as a review");
  ok(x?.confidence < 0.5, `  at low confidence  (${x?.confidence})`);
  ok(/If it IS the band's name, leave it/.test(x?.suggest || ""),
     "  and it says outright that leaving it alone may be correct");

  /*
   * The MBID gate. A name with its own MusicBrainz artist ID is a real artist and
   * no pattern may overrule that. Free evidence: the ID is already on the scrobble.
   */
  ok(run("Drake feat. Future", "Drake", "b4f7-mbid") === null,
     "an artist MBID silences even an unambiguous marker, because it proves the " +
     "name is a real MusicBrainz entity");
  ok(run("Jack U x Skrillex", "Jack U", "abc-mbid") === null,
     "and the same for a weak marker");

  // The head must still exist in the library, or there is no phantom to report.
  const orphan = d8FeatureCredits(play("Drake feat. Future", "Track", 11));
  eq(orphan.length, 0,
     "no finding when the bare artist is absent: nothing is competing with it");
}

/* ---------------------------------------------------------------------------
 * Duo versus one-off collaboration.
 *
 * Removing `&` from the marker set stopped D8 damaging real duos, but it also went
 * blind to a case that IS worth raising: "Future & Young Thug" made one album
 * together, both are major solo artists, and that joint credit is a third artist
 * taking plays from two real ones. "Macklemore & Ryan Lewis" looks identical as a
 * string and is completely different, because Ryan Lewis has no solo catalogue.
 *
 * The signal that separates them is free and comes from the library: does the part
 * AFTER the separator also stand on its own with real plays? Always `review`,
 * because keeping collaboration albums under a joint credit is a defensible choice
 * rather than a defect.
 * ------------------------------------------------------------------------- */
{
  const P = (artist, album, track, n) =>
    Array.from({ length: n }, (_, i) =>
      ({ artist, album, track: track + i, uts: 1e9 + i }));
  const joint = (rest) =>
    d8FeatureCredits(rest).find((i) => /may be a collaboration/.test(i.title)) || null;

  // The case that must fire: both halves substantial, one shared album.
  const collab = joint([
    ...P("Future & Young Thug", "Super Slimey", "t", 11),
    ...P("Future", "DS2", "s", 40),
    ...P("Young Thug", "Punk", "u", 35),
  ]);
  ok(collab !== null, "a joint credit whose halves both stand alone is reported");
  eq(collab?.class, "review", "  as a review, never an error");
  ok(collab?.confidence === 0.6, `  at 0.6 for a single shared album  (${collab?.confidence})`);
  ok(/Future.*40 plays/.test(collab?.suggest || "") &&
     /Young Thug.*35 plays/.test(collab?.suggest || ""),
     "  and names both solo play counts as the evidence");
  ok(/reasonable choice and nothing is broken/.test(collab?.suggest || ""),
     "  while saying plainly that keeping it is legitimate");
  eq(collab?.members.length, 3,
     "  three members: the joint credit and both artists it competes with");

  // The case that must stay silent: a duo where only one half has solo work.
  ok(joint([...P("Macklemore & Ryan Lewis", "The Heist", "t", 11),
            ...P("Macklemore", "Gemini", "s", 29)]) === null,
     "a duo stays silent when the second name has no solo plays");

  // Several joint albums reads more like a duo, so confidence drops.
  const many = joint([
    ...P("A & B", "R1", "t", 6), ...P("A & B", "R2", "u", 6), ...P("A & B", "R3", "v", 6),
    ...P("A", "Solo", "s", 40), ...P("B", "Solo", "w", 35),
  ]);
  ok(many !== null && many.confidence < 0.5,
     `three shared albums lowers confidence  (${many?.confidence})`);
  ok(/more like a/.test(many?.suggest || ""),
     "  and the wording says it looks like an established duo");

  // Three-part names must not be split into a false pair.
  for (const [name, head] of [["Earth, Wind & Fire", "Earth"],
                              ["Tyler, The Creator", "Tyler"]]) {
    ok(joint([...P(name, "Album", "t", 11), ...P(head, "X", "s", 29)]) === null,
       `'${name}' is not treated as a two-artist join`);
  }

  // A trivial number of solo plays is not evidence of a solo career.
  ok(joint([...P("A & B", "R", "t", 11), ...P("A", "X", "s", 40), ...P("B", "Y", "u", 2)]) === null,
     "two solo plays does not make the second name a real artist");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
