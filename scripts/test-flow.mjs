/**
 * Structural assertions on the scan flow in docs/index.html.
 *
 * These are static checks on source text, not behaviour tests, because the flow
 * lives in an inline module against real DOM and a real network. That is a weaker
 * kind of test and worth being honest about: it can only prove the shape of the
 * code, not that it works. It exists because the same class of bug has now
 * appeared three times, and each time the symptom was the UI stating something
 * untrue about its own progress:
 *
 *   1. "Scan complete" rendered while step 2 was still running.
 *   2. A step 2 error deleted every finding from step 1.
 *   3. `stats.running` stayed true after an error, suppressing the summary
 *      permanently with no error and no way back but a rescan.
 *
 * All three were invisible to the detector test suite, which is the point: 669
 * assertions about drift.js say nothing about whether the page tells the truth.
 *
 *     node scripts/test-flow.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "docs/index.html"), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") =>
  cond ? pass++ : fails.push(name + (detail ? `\n      ${detail}` : ""));

/** Source with comments stripped, so prose about a bug never satisfies a test. */
const code = html
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/* ---- 1. step 2 may fail without failing the scan ------------------------ */
{
  // The await must sit inside a try whose catch records the error, rather than
  // inside the scan-wide try whose catch calls fail().
  const i = code.indexOf("await resolvePhase(");
  ok("resolvePhase is called", i > 0);

  const before = code.slice(Math.max(0, i - 400), i);
  ok("resolvePhase is wrapped in its own try",
     /try\s*\{\s*$/.test(before.trimEnd()) || /try\s*\{[^}]*$/.test(before),
     "A throw here reaches fail(), which overwrites #out and deletes step 1.");

  const after = code.slice(i, i + 400);
  ok("and its catch records the failure instead of rethrowing",
     /catch\s*\([^)]*\)\s*\{[^}]*resolve_error/.test(after),
     "stats.resolve_error is what lets the summary say which part is missing.");
}

/* ---- 2. fail() never destroys results already on screen ----------------- */
{
  const m = code.match(/function fail\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  ok("fail() is defined", Boolean(m));
  const body = m ? m[1] : "";

  ok("fail() does not unconditionally overwrite #out",
     !/^\s*\$\("out"\)\.innerHTML\s*=/m.test(body) ||
     /if\s*\(\s*report\s*\)/.test(body),
     "render() writes to #out too, so an unguarded assignment erases the report.");
  ok("fail() appends when a report exists",
     /insertAdjacentHTML/.test(body),
     "The findings must survive an error in a step that can run for hours.");
  ok("fail() still shows the error when there is nothing on screen",
     /\$\("out"\)\.innerHTML\s*=/.test(body),
     "An error before the first render must be visible somewhere.");
}

/* ---- 3. stats.running is always cleared --------------------------------- */
{
  ok("stats.running is cleared in a finally block",
     /finally\s*\{[\s\S]{0,600}?stats\.running\s*=\s*false/.test(code),
     "On the success path only, an error suppresses the summary forever.");

  // And it must gate the summary, which is why clearing it matters at all.
  ok("the summary is gated on stats.running",
     /stats\.running\)\s*return\s*""/.test(code) ||
     /if\s*\(!stats \|\| stats\.running\)/.test(code),
     "This gate is what makes a stale `running` flag invisible.");
}

/* ---- 4. the headline may not claim more than happened ------------------- */
{
  const m = code.match(/function scanSummary\(\)\s*\{([\s\S]*?)\n\}/);
  ok("scanSummary() is defined", Boolean(m));
  const body = m ? m[1] : "";

  ok("'Scan complete' is conditional",
     /\?[^:]*"Scan complete"|"Scan complete"\s*}/.test(body) ||
     /resolve_error[\s\S]*?"Scan complete"/.test(body),
     "A partial run must not be described as complete.");
  ok("a step 2 failure changes the headline, not only a footnote",
     /resolve_error\s*\?/.test(body),
     "Twelve lines down is where a caveat goes unread.");
  ok("and the failure is reported to the user at all",
     /resolve_error/.test(body),
     "Swallowing it leaves missing release dates unexplained.");
  ok("the error text is escaped",
     /esc\(s\.resolve_error\)/.test(body),
     "It can carry a server message, so it is untrusted string data.");
}

/* ---- 5. the promise made in the step 2 banner --------------------------- */
{
  // The banner tells the user the findings below are already readable. That is
  // only true if a step 2 failure leaves them alone, which is assertion 1 and 2.
  ok("the step 2 banner still promises readable results",
     /already below/.test(html),
     "If this wording changes, re-check that a step 2 error preserves them.");
}

/* ---- 6. both steps estimate the time remaining ------------------------- */
{
  /*
   * Step 2 showed "about N min left" from the start and step 1 showed nothing,
   * which is backwards: step 1 is the part that runs for ten minutes on a large
   * history with only a page counter to look at, and it is the first thing a new
   * visitor sees. Reported as "there is no time estimation anymore".
   */
  ok("step 1 estimates the time remaining",
     /startedAt/.test(code) && /left \+ "s"/.test(code),
     "The ingest loop must compute an ETA, not just a page number.");

  // Measured from this session's own throughput. A resumed scan begins with
  // thousands of scrobbles already on disk, and counting those against this
  // session's clock invents a rate the network never achieved.
  ok("the ingest rate excludes already-stored scrobbles",
     /startedWith/.test(code) && /all\.length - startedWith/.test(code),
     "Otherwise a resumed scan reports an estimate of nearly zero.");

  // A figure that starts at 40 min and settles at 6 reads as the scan speeding
  // up rather than as a bad first guess, so it waits for evidence.
  ok("the estimate is withheld until it is stable",
     /elapsed > \d/.test(code),
     "An estimate from the first page includes connection setup.");
}

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\n  FAILED");
  for (const f of fails) console.log("   x " + f);
  process.exit(1);
}
console.log("  The scan flow cannot claim to be finished when it is not.\n");
