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

  /*
   * And cleared BEFORE the render, which the finally block does not do.
   *
   * `finally` runs after the success-path render, so having the assignment ONLY
   * there meant every successful scan rendered with `running` still true and the
   * whole "Scan complete" panel disappeared. Fixing one failure mode created
   * another, and only a real scan caught it: both statements existed and were
   * individually correct, the bug was purely their order.
   */
  /*
   * Anchored on `stats.phase = "done"`, not on the first `render()`.
   *
   * There is an earlier render mid-scan, the one that shows local findings before
   * release lookups start, and matching that gave a false failure. The success
   * path is identifiable by the phase being set to done, so the window checked is
   * from there to the next render call.
   */
  const doneAt = code.indexOf('stats.phase = "done"');
  const renderAfter = code.indexOf("render();", doneAt);
  ok("the success path is locatable", doneAt > 0 && renderAfter > doneAt);
  const window_ = code.slice(doneAt, renderAfter);
  ok("stats.running is cleared BEFORE the success-path render",
     /stats\.running\s*=\s*false/.test(window_),
     "Otherwise the summary panel is suppressed on every successful scan, which " +
     "is what happened when the assignment lived only in `finally`.");

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

/* ---- 7. retry means RESUME, and ingest paces itself --------------------- */
{
  /*
   * The Try Again button used to just click Scan, which starts at page 1, while
   * the text beside it promised "trying again resumes rather than starting over".
   * Seen live: a scan that failed at page 401 of 700 came back at page 49 and
   * re-fetched 50,000 scrobbles that were already on disk, spending the shared API
   * budget to do it. Worse than useless, because the wrong behaviour looked
   * deliberate.
   */
  const retryAt = code.indexOf("querySelector(\".panel.err .retry\")");
  ok("the retry button is wired", retryAt > 0);
  const retryBlock = code.slice(retryAt, retryAt + 900);
  ok("Try Again loads the checkpoint before restarting",
     /loadState\(\)/.test(retryBlock) && /resumeFrom = st/.test(retryBlock),
     "Without this it starts from page 1 while claiming to resume.");
  ok("and only resumes a checkpoint for the SAME user",
     /toLowerCase\(\) === /.test(retryBlock),
     "Resuming someone else's saved scan would silently mix two libraries.");

  /*
   * Ingest paces itself to the server's page budget. RL_PAGES allows 120 pages a
   * minute and each request carries 8, so the sustainable rate is one request
   * every 4 seconds. Unpaced it sprinted, burned the minute in ~15 seconds and
   * stalled for 60, which is the same throughput delivered as a freeze.
   */
  ok("ingest has a minimum interval between requests",
     /INGEST_MIN_MS\s*=\s*4000/.test(code),
     "Matching RL_PAGES (120/min) divided by PAGES_PER_REQUEST (8).");
  ok("and it subtracts time already spent, rather than sleeping blindly",
     /INGEST_MIN_MS - sinceLast/.test(code),
     "A flat sleep would add the round trip on top of the interval.");
  ok("the pacing wait is interruptible",
     /if \(abort\) break;[\s\S]{0,80}lastRequestAt = Date\.now\(\)/.test(code),
     "Stop must not have to wait out a 4-second sleep.");
}

/* ---- 8. deep pages Last.fm will not serve ------------------------------- */
{
  /*
   * A 140,000-scrobble history returned HTTP 500 twice at page 640 and page 644.
   * The same place both times, so a specific unservable page rather than
   * turbulence. Retrying cannot help, and neither can keeping partial batches:
   * when the broken page is the FIRST of a batch there is nothing to keep.
   *
   * `user.getRecentTracks` takes `to`, an upper timestamp bound, so the remaining
   * history can be fetched through a shallow window that never reaches the deep
   * page.
   */
  ok("the client can window by timestamp",
     /qs\.set\("to", String\(toAnchor\)\)/.test(code),
     "Without `to` there is no way past a page Last.fm refuses to serve.");
  ok("it tracks the oldest scrobble seen, which is the next anchor",
     /oldestUts === null \|\| sc\.uts < oldestUts/.test(code));
  ok("a 5xx re-anchors instead of ending the scan",
     /res\.status >= 500 && oldestUts !== null/.test(code) &&
     /toAnchor = oldestUts - 1/.test(code));

  // The two guards that stop this becoming an infinite loop.
  ok("re-anchoring is capped",
     /reAnchors < MAX_REANCHORS/.test(code),
     "A permanently broken window would otherwise retry forever.");
  ok("and requires the anchor to actually move",
     /oldestUts !== lastAnchorUts/.test(code),
     "Re-anchoring to the same timestamp makes no progress, so it must not count.");

  // The target must be captured once. Inside a window Last.fm reports the count
  // WITHIN that window, so re-reading it mid-scan shrinks the denominator and the
  // progress bar jumps to 100%.
  ok("the scrobble total is captured from the first response only",
     /totalScrobbles \?\?= data\.total_scrobbles/.test(code),
     "Otherwise a windowed response redefines the target mid-scan.");

  // Resume has to remember the window or it walks straight back into the bad page.
  ok("the checkpoint stores the date window",
     /to: toAnchor/.test(code) && /toAnchor = resumeFrom\.to \|\| null/.test(code),
     "A resumed scan would otherwise restart into the page that broke it.");

  ok("and the summary says pages were refused rather than implying a clean run",
     /reanchors/.test(code));
}

/* ---- 9. every imported name actually exists ---------------------------- */
{
  /*
   * `node --check` parses; it does not resolve. So adding a call to
   * `d8VerifyJointCredits` while failing to add it to the import list produced a
   * file that checked clean and would have thrown ReferenceError on the first real
   * scan. The import statement is multi-line, which is exactly why the edit that
   * was supposed to add it silently matched nothing.
   *
   * Cheap to assert, and it covers every module the page pulls from.
   */
  const mods = {
    "./drift.js": await import("../docs/drift.js"),
    "./spotify.js": await import("../docs/spotify.js"),
    "./store.js": await import("../docs/store.js"),
    "./config.js": await import("../docs/config.js"),
  };

  let checked = 0;
  for (const [spec, mod] of Object.entries(mods)) {
    // Non-greedy, and anchored on this specific specifier, so one import block
    // cannot swallow the next.
    const re = new RegExp(`import \\{([^}]*?)\\} from "${spec.replace(".", "\\.")}"`);
    const m = html.match(re);
    ok(Boolean(m), `the import from ${spec} is found`);
    if (!m) continue;

    const names = m[1].split(",").map((x) => x.trim()).filter(Boolean)
      .map((x) => x.split(/\s+as\s+/)[0].trim());
    for (const n of names) {
      checked++;
      ok(n in mod, `${spec} exports ${n}`);
    }
  }
  ok(checked > 20, `checked ${checked} imported names`);

  // And the namespace import, which the regex above cannot see.
  ok(/import \* as store from "\.\/store\.js"/.test(html),
     "store is imported as a namespace, so every store.X call resolves");
}

/* ---- 10. a private profile is offered no false workaround --------------- */
{
  /*
   * The default hint under every error is "scan fewer months, or use your own
   * Last.fm API key". For a private listening history neither works: the privacy
   * setting is enforced on the TARGET account rather than the caller, so every key
   * receives the same 403, and a shallower scan reads the same refused endpoint.
   * Suggesting it sends people off to generate an API key for nothing.
   */
  ok("fail() takes a hint channel",
     /function fail\(msg, detail = "", hint = undefined\)/.test(code));
  ok("and null suppresses the generic advice entirely",
     /hint === null \? "" :/.test(code),
     "Not an empty string: the default must still apply when nothing is passed.");
  ok("the default is still used when no hint is given",
     /hint \?\? "Or scan fewer months/.test(code));

  const at = code.indexOf("res.status === 403");
  const block = code.slice(at, code.indexOf("}", code.indexOf("join(\" \")", at)) + 40);
  ok("the private-profile error passes hint: null",
     /hint: null/.test(block),
     "Otherwise it advertises a workaround that cannot work.");
  ok("and the error carries the hint through to fail()",
     /fail\(err\.message \|\| String\(err\), err\.detail \|\| "", err\.hint\)/.test(code));
}

/* ---- 11. step 2 must not throttle itself against calls it never makes --- */
{
  /*
   * Measured against the live Worker: a cache hit answers in 64ms and the endpoint
   * sustains 63 requests a second. The client paced itself to 3. Worse, that pacer
   * charged EVERY request, including ones served from the shared cache, which
   * never reach Spotify or MusicBrainz at all. Step 2 was rate-limiting itself
   * against services it was not calling, and the effect grows as the shared cache
   * fills, which is exactly backwards.
   */
  ok("the pacer can refund an unspent slot",
     /refund\(\) \{/.test(code),
     "Without it, a cache hit costs the same as a real upstream call.");
  ok("a refund never rewinds past now",
     /Math\.max\(Date\.now\(\), this\.nextSlot - this\.interval\)/.test(code),
     "Otherwise credit accumulates and is spent as a burst later.");

  ok("Spotify refunds a shared-cache answer",
     /if \(out\?\.shared\) spPace\.refund\(\)/.test(code));
  ok("MusicBrainz refunds one too",
     /if \(out\?\.shared\) mbPace\.refund\(\)/.test(code));

  /*
   * The era phase ran one job at a time. On a library with thousands of
   * unreleased plays that is hundreds of sequential round trips, each waiting out
   * a full pacer interval, which was a large part of why step 2 dragged.
   */
  ok("the era phase is pooled rather than serial",
     /await pool\(eraJobs, \d+, async \(job\) => \{/.test(code),
     "A plain for-loop here serialises every era lookup.");
  ok("and it is closed as a callback",
     /tick\("Checking era names"\);\s*\}\);/.test(code),
     "A pooled body ends with `});`, not `}`.");

  // `continue` and `break` are loop statements and are illegal in a callback.
  // Converting a loop to a pool without converting these is a silent syntax trap.
  const at = code.indexOf("await pool(eraJobs");
  const body = code.slice(at, code.indexOf('tick("Checking era names")', at));
  ok(!/\bcontinue;/.test(body) && !/\bbreak;/.test(body),
     "no loop-only statements survive inside the pooled callback");
}

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\n  FAILED");
  for (const f of fails) console.log("   x " + f);
  process.exit(1);
}
console.log("  The scan flow cannot claim to be finished when it is not.\n");
