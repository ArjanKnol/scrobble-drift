/**
 * Library-shape robustness.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Every threshold in drift.js was tuned against ONE library: 139,000 scrobbles,
 * hip-hop heavy, 16% unreleased, meticulously curated. The 0.82 similarity floor,
 * the 80-string score denominator, the three-shared-track gate, the two-stray
 * cutoff — all of them were set by looking at what that data does.
 *
 * The library most likely to arrive from a Reddit link is nothing like it: a
 * few-hundred-scrobble account a few months old with no unreleased material.
 * These tests do not TUNE against other shapes; they assert the tuning does not
 * produce nonsense or hang when the shape changes.
 *
 * Run: node scripts/test-shapes.mjs
 */
import { analyse, editDistance, norm } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

/**
 * Plausible artist names.
 *
 * The first fixture used `Artist 0` .. `Artist 400`, which is pathological in a
 * way that mattered: sequential numbering makes every pair one edit apart, and
 * generic track titles satisfy D1's shared-title gate trivially. That produced 27
 * D1 findings on a library with zero injected flaws.
 *
 * It did expose a real gap — D1 had no rule against digit-only differences, which
 * is now `digitsOnlyDiffer` — but a fixture messier than reality tests nothing,
 * and would have had us loosening a detector that was behaving correctly.
 */
const SYL_A = ["Bl", "Dr", "Kn", "Vex", "Mor", "Sal", "Trem", "Quил", "Ash", "Pol",
               "Wren", "Cast", "Hol", "Jun", "Fen", "Gild", "Mar", "Nol", "Orb",
               "Perr", "Rue", "Sten", "Thal", "Umb", "Vald", "Wyn", "Yar", "Zeph"];
const SYL_B = ["ako", "ester", "ova", "ynn", "arde", "iso", "undi", "eth", "orra",
               "ika", "usk", "ay", "ero", "immer", "olt", "une", "ythe", "azar"];

/*
 * Names guaranteed to be FAR APART from each other.
 *
 * The syllable version produced `Morako` and `Marako`, one edit apart and sharing
 * track titles — a textbook typo pair. D1 flagged it and was entirely right to;
 * the fixture was the thing lying, by claiming to be a clean library while
 * containing a plausible misspelling.
 *
 * So every generated name is rejected unless it is at least 3 edits from every
 * name already issued. A fixture asserting "zero findings" has to actually be
 * clean, or the assertion tests the generator rather than the detector.
 */
const NAMES = [];
function buildNames(want) {
  for (let i = 0; NAMES.length < want && i < want * 40; i++) {
    const a = SYL_A[i % SYL_A.length];
    const b = SYL_B[Math.floor(i / SYL_A.length) % SYL_B.length];
    const c = Math.floor(i / (SYL_A.length * SYL_B.length));
    const name = c
      ? `${a}${b} ${SYL_A[(c * 7) % SYL_A.length]}${SYL_B[(c * 5) % SYL_B.length]}`
      : `${a}${b}`;
    if (NAMES.some((n) => editDistance(norm(n), norm(name), 2) <= 2)) continue;
    NAMES.push(name);
  }
}

function artistName(i) {
  if (NAMES.length <= i) buildNames(i + 200);
  // Fall back to a wide numeric suffix if the syllable space runs out. Digit-only
  // differences are excluded from D1 by design, so these cannot collide either.
  return NAMES[i] ?? `Act ${i * 1000}`;
}

/** Deterministic pseudo-random, so a failure is always reproducible. */
function rng(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

/**
 * Build a library of a given shape.
 *
 * `flaws` injects a fixed number of real problems so the score has something to
 * find; without it every shape would score 100 and prove nothing.
 */
function library({ scrobbles, artists, unreleasedShare = 0, flaws = 0, seed = 1 }) {
  const r = rng(seed);
  const out = [];
  let uts = 1500000000;
  const nEra = Math.floor(scrobbles * unreleasedShare);

  /*
   * A track belongs to exactly ONE album, always.
   *
   * The first version of this picked the album at random per scrobble, which
   * manufactured D4 splits by construction: "Track 3" by "Artist 5" landed on
   * both "Album 5-0" and "Album 5-2", which IS the pattern D4 exists to flag. A
   * library generated with zero injected flaws produced 97 findings and scored
   * 50, and the fault was the generator rather than the detector.
   *
   * Real listeners do not do that: a track lives on one album in their library.
   * A fixture that is messier than reality tests nothing useful, and would have
   * had us "fixing" a detector that was behaving correctly.
   */
  const albumOf = (a, t) => `Album ${a}-${t % 4}`;

  for (let i = 0; i < scrobbles - nEra; i++) {
    const a = Math.floor(r() * artists);
    const t = Math.floor(r() * 12);
    out.push({
      uts: uts += 120 + Math.floor(r() * 600),
      artist: artistName(a),
      album: albumOf(a, t),
      track: `Track ${t}`,
      artist_mbid: "", album_mbid: "", track_mbid: "",
    });
  }
  // Same rule for the unreleased half: one leak belongs to one era, or D14c
  // would report every track as spanning several eras.
  for (let i = 0; i < nEra; i++) {
    const a = Math.floor(r() * Math.max(1, Math.floor(artists / 10)));
    const leak = Math.floor(r() * 40);
    out.push({
      uts: uts += 120 + Math.floor(r() * 600),
      artist: artistName(a),
      album: `Unreleased (Era ${leak % 5})`,
      track: `Leak ${leak}`,
      artist_mbid: "", album_mbid: "", track_mbid: "",
    });
  }
  // Injected flaws: one track split across two album strings, each time.
  for (let i = 0; i < flaws; i++) {
    for (let k = 0; k < 5; k++) {
      out.push({ uts: uts += 300, artist: `Flawed Act ${artistName(900 + i)}`,
                 album: `Real Album ${i}`, track: `Song ${i}` });
    }
    for (let k = 0; k < 4; k++) {
      out.push({ uts: uts += 300, artist: `Flawed Act ${artistName(900 + i)}`,
                 album: `Song ${i} - Single`, track: `Song ${i}` });
    }
  }
  return out;
}

const SHAPES = [
  { name: "brand new account",   scrobbles: 400,    artists: 60,   flaws: 1 },
  { name: "casual listener",     scrobbles: 5000,   artists: 400,  flaws: 4 },
  { name: "no unreleased at all", scrobbles: 20000, artists: 1200, flaws: 10,
    unreleasedShare: 0 },
  { name: "all unreleased",      scrobbles: 3000,   artists: 40,   flaws: 2,
    unreleasedShare: 0.95 },
  { name: "heavy, era-tagged",   scrobbles: 40000,  artists: 2000, flaws: 25,
    unreleasedShare: 0.16 },
];

/* ------------------------------------------------------------------------- */
console.log("\nevery shape produces a sane report without throwing");

const results = [];
for (const shape of SHAPES) {
  const lib = library(shape);
  const t0 = Date.now();
  let r = null, threw = null;
  try { r = analyse(lib); } catch (e) { threw = e; }
  const ms = Date.now() - t0;

  ok(!threw, `${shape.name.padEnd(22)} does not throw${threw ? ": " + threw.message : ""}`);
  if (!r) continue;

  results.push({ shape, r, ms });
  const h = r.hygiene;
  console.log(`       ${String(shape.scrobbles).padStart(6)} scrobbles, ` +
    `${String(r.profile.distinct_albums).padStart(5)} strings, ` +
    `score ${String(h.score).padStart(3)}, ` +
    `${String(r.issues_total).padStart(3)} issues, ${ms}ms`);

  ok(h.score >= 0 && h.score <= 100, `  score is in range`);
  ok(Number.isFinite(h.score), `  score is a finite number`);
  ok(r.issues.every((i) => Number.isFinite(i.plays_affected)),
     `  every finding has a finite play count`);
  ok(r.issues.every((i) => i.confidence > 0 && i.confidence <= 1),
     `  every confidence is a probability`);
  ok(r.issues.every((i) => i.title && i.suggest),
     `  every finding has a title and a suggestion`);
}

/* ------------------------------------------------------------------------- */
console.log("\nthe small-library score must not be alarmist");

{
  // The worry: with an 80-string denominator floor, a single split in a tiny
  // library could score in the 70s and read as a verdict on the user's tagging
  // when it is really an artefact of the floor.
  const tiny = results.find((x) => x.shape.name === "brand new account");
  ok(tiny.r.hygiene.score >= 85,
     `one flaw in a 400-scrobble library scores ${tiny.r.hygiene.score}, not the 70s`);
  ok(tiny.r.hygiene.actionable <= 3,
     `and reports few actionable findings (${tiny.r.hygiene.actionable})`);
}

{
  // A genuinely clean small library must score 100, not "small so penalised".
  const clean = analyse(library({ scrobbles: 300, artists: 50, flaws: 0 }));
  eq(clean.hygiene.score, 100, "a clean 300-scrobble library scores exactly 100");
  eq(clean.hygiene.actionable, 0, "with nothing actionable");
}

{
  // And the score must still be able to fall when a small library is genuinely
  // messy, or the floor has simply disabled scoring for small accounts.
  const messy = analyse(library({ scrobbles: 400, artists: 20, flaws: 25 }));
  ok(messy.hygiene.score < 85,
     `a genuinely messy small library still drops (${messy.hygiene.score})`);
}

/* ------------------------------------------------------------------------- */
console.log("\nzero and all unreleased are both handled");

{
  const none = results.find((x) => x.shape.name === "no unreleased at all");
  eq(none.r.era.plays, 0, "no era-tagged plays are found when there are none");
  eq(none.r.issues.filter((i) => i.detector.startsWith("D14")).length, 0,
     "and no era findings are invented");
  ok(none.r.hygiene.score > 0, "the score is still meaningful");

  const all = results.find((x) => x.shape.name === "all unreleased");
  ok(all.r.era.plays > 0, "an all-unreleased library is recognised");
  ok(all.r.hygiene.score >= 0, "and still scores");
}

/* ------------------------------------------------------------------------- */
console.log("\nperformance: the O(n^2) artist comparison in D1");

{
  // D1 compares every pair of artist keys. The concern is a long-lived library
  // with tens of thousands of artists.
  //
  // The 5,000-artist case takes ~20 seconds on its own, so the big sizes are
  // opt-in: PERF=1 node scripts/test-shapes.mjs. A test suite nobody runs
  // because it is slow protects nothing.
  const sizes = process.env.PERF ? [500, 2000, 5000] : [500, 1500];
  for (const artists of sizes) {
    const lib = library({ scrobbles: artists * 8, artists, flaws: 2, seed: 7 });
    const t0 = Date.now();
    analyse(lib);
    const ms = Date.now() - t0;
    console.log(`       ${String(artists).padStart(5)} artists -> ${ms}ms`);
    ok(ms < 30000, `  ${artists} artists completes under 30s (${ms}ms)`);
  }
}

/* ------------------------------------------------------------------------- */
console.log("\ndegenerate inputs");

for (const [label, lib] of [
  ["empty library", []],
  ["one scrobble", [{ uts: 1, artist: "A", album: "B", track: "C" }]],
  ["no albums at all", Array.from({ length: 50 }, (_, i) =>
    ({ uts: i, artist: "A", album: "", track: `T${i}` }))],
  ["one artist, one track, many plays", Array.from({ length: 500 }, (_, i) =>
    ({ uts: i * 300, artist: "A", album: "B", track: "C" }))],
  ["identical timestamps", Array.from({ length: 100 }, () =>
    ({ uts: 1600000000, artist: "A", album: "B", track: "C" }))],
]) {
  let threw = null, r = null;
  try { r = analyse(lib); } catch (e) { threw = e; }
  ok(!threw, `${label} does not throw${threw ? ": " + threw.message : ""}`);
  if (r) ok(r.hygiene.score >= 0 && r.hygiene.score <= 100,
            `  and scores in range (${r.hygiene.score})`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
