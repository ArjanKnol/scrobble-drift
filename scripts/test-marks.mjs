/**
 * Fixed / Ignore marks, remembered per username.
 *
 * Run: node scripts/test-marks.mjs
 */
import { markKey, loadMarks, saveMarks, setMark, markState } from "../docs/marks.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const mem = () => { const m = new Map(); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

const split = (plays) => ({ detector: "D4", artist: "Travis Scott", track: "goosebumps",
  plays_affected: plays,
  members: [{ album: "Birds in the Trap Sing McKnight", plays: plays - 1 },
            { album: "Goosebumps", plays: 1 }] });

console.log("\nidentity");
eq(markKey(split(10)), markKey(split(40)), "the key ignores play counts");
ok(markKey(split(10)) !== markKey({ ...split(10), detector: "D8" }), "the detector is part of it");
eq(markKey({ ...split(10), artist: "TRAVIS SCOTT" }), markKey(split(10)), "case does not matter");
ok(markKey({ ...split(10), members: [...split(10).members].reverse() }) === markKey(split(10)),
   "member order does not matter");
eq(markKey(null), "", "nothing in, nothing out");

console.log("\nstates");
let marks = {};
eq(markState(marks, split(10), 100).state, null, "unmarked by default");
marks = setMark(marks, split(10), "ignored", 100);
ok(markState(marks, split(10), 100).hidden, "ignored is hidden");
ok(markState(marks, split(10), 200).hidden, "and stays hidden in later scans");
marks = setMark(marks, split(10), "fixed", 100);
ok(markState(marks, split(10), 100).hidden, "fixed is hidden in the scan it was marked in");
const later = markState(marks, split(25), 200);
ok(later.back && !later.hidden, "and comes back, flagged, when a later scan still finds it");
marks = setMark(marks, split(10), null, 100);
eq(markState(marks, split(10), 100).state, null, "undo clears it");

console.log("\nstorage");
const st = mem();
ok(saveMarks("ArjanKnol", setMark({}, split(5), "fixed", 1), st), "saves");
eq(Object.keys(loadMarks("arjanknol", st)).length, 1, "loads for the same user, any case");
eq(Object.keys(loadMarks("someoneelse", st)).length, 0, "another user sees nothing");
eq(Object.keys(loadMarks("", st)).length, 0, "no user, no marks");
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
eq(Object.keys(loadMarks("x", broken)).length, 0, "unavailable storage loads as empty");
eq(saveMarks("x", {}, broken), false, "and a failed save says so instead of throwing");
const junk = mem(); junk.setItem("drift_marks:x", "{not json");
eq(Object.keys(loadMarks("x", junk)).length, 0, "corrupt storage loads as empty");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
