/**
 * D14e ("has this leak been released since") tests.
 *
 * The false positive this exists for: MusicBrainz documents music, not commerce,
 * so it catalogues leaked and bootlegged projects as release groups. Kanye's
 * `Yandhi` was never released, yet it is in there. The detector reported
 *
 *   "An official Album 'Yandhi' (date unknown) contains a recording with this
 *    title"
 *
 * for a track filed under `Unreleased (Yandhi v2 Era)` — circular reasoning. It
 * found the leak it was asked about and called it a release.
 *
 * Run: node scripts/test-released.mjs
 */
import { d14eReleasedSince } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const eraFor = (album, track = "Spread Your Wings", n = 16) => {
  const out = []; let uts = 1570000000;
  for (let i = 0; i < n; i++)
    out.push({ uts: uts += 900000, artist: "Kanye West", album, track });
  return out;
};
const g = (over) => ({ title: "Donda", primary: "Album", secondary: [],
                       status: "Official", first_release: "2021-08-29", ...over });
const run = (era, groups) => d14eReleasedSince(era, () => ({ groups }));

/* ------------------------------------------------------------------------- */
console.log("\nguard 1: no release date means no claim");

{
  const out = run(eraFor("Unreleased (Some Era)"),
                  [g({ title: "Mystery", first_release: null })]);
  eq(out.length, 0, "a release group with no date is not evidence");
}
{
  const out = run(eraFor("Unreleased (Some Era)"),
                  [g({ title: "Mystery", first_release: "2020-01-01" })]);
  eq(out.length, 1, "the same group WITH a date is reported");
}

/* ------------------------------------------------------------------------- */
console.log("\nguard 2: the match must not be the era itself");

{
  // The reported case, exactly.
  const out = run(eraFor("Unreleased (Yandhi v2 Era)"),
                  [g({ title: "Yandhi", first_release: null })]);
  eq(out.length, 0, "'Yandhi' matched against the Yandhi era is suppressed");
}
{
  const out = run(eraFor("Unreleased (Yandhi v2 Era)"),
                  [g({ title: "Yandhi", first_release: "2018-09-29" })]);
  eq(out.length, 0, "even with a plausible date, it is still the same project");
}
{
  const out = run(eraFor("Unreleased (Yandhi Era)"),
                  [g({ title: "Yandhi v2", first_release: "2018-09-29" })]);
  eq(out.length, 0, "matching works in both directions (era inside title)");
}
{
  // A genuine release under a DIFFERENT name must survive the guard.
  const out = run(eraFor("Unreleased (Yandhi v2 Era)"), [g({ title: "Donda" })]);
  eq(out.length, 1,
     "a track that surfaced on a different album IS still reported");
  ok(/Donda/.test(out[0].suggest), "and names that album");
}

/* ------------------------------------------------------------------------- */
console.log("\nbootlegs and demos are excluded");

for (const t of ["Bootleg", "Demo"]) {
  const out = run(eraFor("Unreleased (X Era)"), [g({ secondary: [t] })]);
  eq(out.length, 0, `secondary type '${t}' is not an official release`);
}
{
  const out = run(eraFor("Unreleased (X Era)"), [g({ status: "Promotion" })]);
  eq(out.length, 0, "a non-Official status is rejected");
}
{
  const out = run(eraFor("Unreleased (X Era)"),
                  [g({ secondary: ["Compilation"] })]);
  eq(out.length, 1,
     "a compilation still counts: it means the track did come out");
}

/* ------------------------------------------------------------------------- */
console.log("\nguard 3: Spotify outranks MusicBrainz, and says so");

{
  const mbOnly = run(eraFor("Unreleased (X Era)"), [g()])[0];
  const spotify = run(eraFor("Unreleased (X Era)"),
                      [g({ source: "spotify" })])[0];

  ok(spotify.confidence > mbOnly.confidence,
     `Spotify evidence scores higher (${spotify.confidence} > ${mbOnly.confidence})`);
  ok(/on Spotify now/.test(spotify.suggest),
     "the Spotify case says it is actually available");
  ok(/also documents leaked and bootlegged/.test(mbOnly.suggest),
     "the MusicBrainz case warns that MB catalogues leaks");
  ok(!/date unknown/.test(mbOnly.suggest),
     "'date unknown' can no longer appear, since a date is now required");
}

{
  // With both available, Spotify must be the one reported.
  const out = run(eraFor("Unreleased (X Era)"), [
    g({ title: "MB Version" }),
    g({ title: "Spotify Version", source: "spotify" }),
  ]);
  ok(/Spotify Version/.test(out[0].suggest),
     "the Spotify group is chosen over the MusicBrainz one");
}

/* ------------------------------------------------------------------------- */
console.log("\nunchanged behaviour");

{
  const out = run(eraFor("Unreleased (X Era)"), [g()]);
  eq(out[0].no_auto_action, true, "still never automatable");
  eq(out[0].plays_affected, 16, "counts the era plays");
  ok(/Verify it is the same version/.test(out[0].suggest),
     "still tells the reader to verify the version");
  ok(out[0].members.some((m) => m.era === "X"), "and lists the era");
}

{
  eq(run(eraFor("Unreleased (X Era)"), []).length, 0, "no groups, no finding");
  eq(d14eReleasedSince(eraFor("Unreleased (X Era)"), () => null).length, 0,
     "a null lookup does not throw");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
