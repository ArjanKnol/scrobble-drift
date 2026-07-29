/**
 * D5 (no album) tests.
 *
 * The complaint this fixes: the finding listed the MONTHS the blanks fell in.
 * That explained the cause but gave the reader nothing to do. "18 scrobbles have
 * no album, concentrated in 2017-07" cannot be acted on without hunting through
 * a year of history by hand.
 *
 * Run: node scripts/test-missing.mjs
 */
import { d5MissingAlbum, d5Resolve, resolutionPlan } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const lib = (spec) => {
  const out = []; let uts = 1600000000;
  for (const [artist, album, track, n] of spec)
    for (let i = 0; i < n; i++) out.push({ uts: uts += 90000, artist, album, track });
  return out;
};
const SAMPLE = lib([
  ["Travis Scott", "", "SICKO MODE", 4],
  ["Drake", "", "God's Plan", 4],
  ["Pale", "", "Not In Love", 2],
  ["Future", "", "Mask Off", 1],
  ["Someone", "Real Album", "Fine", 50],
]);

/* ------------------------------------------------------------------------- */
console.log("\nmembers are tracks, not months");

{
  const i = d5MissingAlbum(SAMPLE)[0];
  ok(i, "a finding is produced");
  eq(i.plays_affected, 11, "counts the blank plays only");
  ok(/across 4 tracks/.test(i.title), "the title names the track count");

  ok(i.members.every((m) => m.track), "every member is a track");
  ok(!i.members.some((m) => m.month), "no member is a bare month");
  ok(i.members.every((m) => m.artist),
     "each member carries its own artist, so links resolve per track");
  eq(i.members[0].track, "SICKO MODE", "busiest track first");
  eq(i.members[0].plays, 4, "with its play count");

  // The month clustering is still available, just not as the actionable list.
  ok(i.months?.length, "month clustering is kept for context");
  ok(/misbehaving scrobbler/.test(i.suggest),
     "and the cause is still explained in prose");
  ok(/links straight to it in your library/.test(i.suggest),
     "the suggestion tells the reader the tracks are clickable");
}

{
  const clean = d5MissingAlbum(lib([["A", "Album", "T", 5]]));
  eq(clean.length, 0, "nothing is reported when every scrobble has an album");
}

{
  // Repeated plays of one track are one member, not one per play.
  const i = d5MissingAlbum(lib([["A", "", "T", 9]]))[0];
  eq(i.members.length, 1, "plays of the same track collapse to one member");
  eq(i.members[0].plays, 9, "with the total");
}

/* ------------------------------------------------------------------------- */
console.log("\nblank tracks join the resolution plan");

{
  const plan = resolutionPlan(SAMPLE);
  const missing = plan.filter((j) => j.kind === "missing");
  eq(missing.length, 4, "all four blank-album tracks are queued for lookup");
  ok(missing.some((j) => j.track === "SICKO MODE"), "including the busiest");
  ok(!plan.some((j) => j.track === "Fine"),
     "a track that already has an album is not queued as missing");
}

/* ------------------------------------------------------------------------- */
console.log("\nd5Resolve names the album each track should carry");

{
  const before = d5MissingAlbum(SAMPLE)[0];
  const lookup = (a, t) => t === "SICKO MODE"
    ? { groups: [{ title: "ASTROWORLD", primary: "Album", secondary: [],
                   first_release: "2018-08-03" }] }
    : t === "God's Plan"
    ? { groups: [{ title: "Scorpion", primary: "Album", secondary: [],
                   first_release: "2018-06-29" }] }
    : null;

  const after = d5Resolve(before, lookup);
  const sicko = after.members.find((m) => m.track === "SICKO MODE");
  eq(sicko.looks_like, "should be: ASTROWORLD", "the album is named per track");
  const pale = after.members.find((m) => m.track === "Not In Love");
  eq(pale.looks_like, "no album found for this title",
     "and an unmatched track says so rather than guessing");
  ok(/2 of 4 have been matched/.test(after.suggest),
     "the suggestion reports how many were matched");
  eq(after.plays_affected, before.plays_affected,
     "resolving does not change the play count");
}

{
  // A compilation must not win over the studio album, same rule as d0Resolve.
  const before = d5MissingAlbum(lib([["A", "", "Song", 3]]))[0];
  const after = d5Resolve(before, () => ({ groups: [
    { title: "Greatest Hits", primary: "Album", secondary: ["Compilation"],
      first_release: "2005-01-01" },
    { title: "Real Album", primary: "Album", secondary: [],
      first_release: "1999-01-01" },
  ] }));
  eq(after.members[0].looks_like, "should be: Real Album",
     "the studio album is preferred over a compilation");
}

{
  // No lookup data at all: must not throw, must not invent.
  const before = d5MissingAlbum(SAMPLE)[0];
  const after = d5Resolve(before, () => null);
  eq(after.members.length, 4, "all members survive");
  ok(after.members.every((m) => m.looks_like === "no album found for this title"),
     "and none claims an album");
  eq(after.suggest, before.suggest,
     "the wording is unchanged when nothing was matched");
}

{
  // d5Resolve on an issue with no tracks (an older cached report) is a no-op.
  const out = d5Resolve({ detector: "D5", members: [] }, () => null);
  ok(out, "an issue without tracks is returned untouched rather than throwing");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
