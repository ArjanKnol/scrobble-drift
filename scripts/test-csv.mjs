/**
 * CSV import and artist focus.
 *
 * Run: node scripts/test-csv.mjs
 */
import { parseScrobbleCsv, parseRecords, toUts } from "../docs/csv.js";
import {
  artistMatcher, topArtists, suggestArtists, leadArtist, findingsByArtist,
} from "../docs/focus.js";
import { readFile } from "node:fs/promises";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
                           `${m}  (got ${JSON.stringify(a)})`);
const throws = (fn, re, m) => {
  try { fn(); ok(false, m); } catch (e) { ok(re.test(e.message), `${m}  (${e.message})`); }
};

console.log("\nlastfmstats.com export");
{
  const csv = "﻿Artist;Album;AlbumId;Track;Date#Some_User\r\n" +
    "Kendrick Lamar;DAMN.;abc;HUMBLE.;1700000000000\r\n" +
    'Bowie;"Heroes";;"""Heroes""";1600000000000\r\n' +
    "Artist;;;Track with no album;1650000000000\r\n" +
    ";;;missing artist;1650000000000\r\n";
  const r = parseScrobbleCsv(csv);
  eq(r.format, "lastfmstats", "recognised by the Date#username header");
  eq(r.username, "Some_User", "username taken from the Date header");
  eq(r.scrobbles.length, 3, "three usable rows");
  eq(r.skipped, 1, "the row with no artist is skipped, not fatal");
  eq(r.scrobbles.map((s) => s.uts), [1700000000, 1650000000, 1600000000],
     "milliseconds become seconds, sorted newest first like the API");
  eq(r.scrobbles[2].track, '"Heroes"', "doubled quotes inside a quoted field survive");
  eq(r.scrobbles[1].album, "", "an empty album stays empty (counted as no album)");
  eq(Object.keys(r.scrobbles[0]).sort(),
     ["album", "album_mbid", "artist", "artist_mbid", "track", "track_mbid", "uts"],
     "same shape as scrobbles fetched from Last.fm");
}

console.log("\nother layouts");
{
  const r = parseScrobbleCsv("artist,album,title,date\n" +
    'A,"B, with comma",C,2024-01-02 10:00\n');
  eq(r.format, "csv", "a plain headered CSV with Title instead of Track");
  eq(r.scrobbles[0].album, "B, with comma", "commas inside quotes are kept");
  eq(r.scrobbles[0].uts, Date.UTC(2024, 0, 2, 10) / 1000, "a date string is read as UTC");
  eq(r.username, null, "no username when the file has none");

  const h = parseScrobbleCsv("Radiohead,OK Computer,Airbag,31 Jan 2020 18:44\n" +
                             "Radiohead,OK Computer,Lucky,31 Jan 2020 18:40\n");
  eq(h.format, "headerless", "the old four-column lastfm-to-csv export");
  eq(h.scrobbles.length, 2, "both rows read");

  eq(toUts("1700000000"), 1700000000, "seconds stay seconds");
  eq(toUts("1700000000123"), 1700000000, "milliseconds are divided");
  eq(toUts("nonsense"), null, "an unreadable date is null");
  eq(parseRecords('a;"b\nc";d\n', ";"), [["a", "b\nc", "d"]], "a newline inside quotes is data");
}

console.log("\nrejections");
throws(() => parseScrobbleCsv(""), /empty/, "an empty file");
throws(() => parseScrobbleCsv("name,email\nx,y\n"), /does not look like/, "an unrelated CSV");
throws(() => parseScrobbleCsv("Artist;Album;Track;Date\n;;;\n"), /No usable/, "a header with no data");
{
  const r = parseScrobbleCsv('Artist;Album;Track;Date#<script>\nA;B;C;1700000000\n');
  eq(r.username, null, "a malformed username can never reach a link");
}

console.log("\nartist focus");
{
  const sc = [
    { artist: "Beyoncé" }, { artist: "Beyonce" }, { artist: "Beyoncé feat. JAY-Z" },
    { artist: "The Weeknd" }, { artist: "Simon & Garfunkel" }, { artist: "Simon" },
  ];
  eq(sc.filter(artistMatcher("beyonce")).length, 3,
     "case, accents and a guest credit all match the lead artist");
  eq(sc.filter(artistMatcher("weeknd")).length, 1, "a leading The is optional");
  eq(sc.filter(artistMatcher("Simon")).length, 1,
     "'&' does not split a duo, so Simon & Garfunkel is not Simon");
  eq(leadArtist("A ft. B"), "A", "lead credit");
  const top = topArtists(sc, 2);
  eq(top[0], { artist: "Beyoncé", plays: 3 }, "top artists group spellings, most used name wins");
  eq(top.length, 2, "and are capped");
  eq(suggestArtists("beyon", sc), ["Beyoncé"], "a partial name gets a suggestion");
  const f = findingsByArtist([{ artist: "Beyonce" }, { artist: "Beyoncé" }, { artist: "x" }]);
  eq(f.get("beyonce"), 2, "findings are counted per artist the same way");
}

console.log("\none scan, one source");
{
  const html = (await readFile(new URL("../docs/index.html", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  ok(/if \(scanning\) return;\s+\/\/ one scan at a time/.test(html),
     "submitting while a scan runs does nothing");
  ok(/\$\("csv"\)\.disabled = scanning;/.test(html), "the file picker is locked during a scan");
  ok(/\$\("user"\)\.classList\.toggle\("hide", file\);/.test(html) &&
     /\$\("user"\)\.disabled = scanning;/.test(html),
     "the username is hidden on the file tab and locked during a scan");
  ok(/\$\("depth"\)\.classList\.toggle\("hide", file\);/.test(html), "and so is the depth");
  ok(/\$\(id\)\.disabled = scanning;/.test(html), "the source tabs cannot be switched mid-scan");
  ok(/if \(mode === "lfm"\) csvSource = null;/.test(html),
     "leaving the file tab drops the file, so no hidden second source exists");
  ok(/const fromFile = mode === "file" \? csvSource : null;/.test(html),
     "the scan uses the file only on the file tab");
  ok(/fromFile\s*\? fromFile\.scrobbles\s*: await fetchAll/.test(html),
     "a file scan never calls Last.fm for scrobbles");
  ok(/!fromFile && !apiKey && \(wanted === 0/.test(html),
     "the API-key gate does not apply to a file");
  ok(/mode = "lfm";\s+csvSource = null;\s+applySource\(\);\s+\$\("user"\)\.value = st\.user;/.test(html),
     "resuming a Last.fm scan clears a chosen file");
  ok(/async function refocus\(name\)[\s\S]{0,120}if \(scanning/.test(html),
     "picking another artist is ignored while a scan runs");
  ok(!/metadata rot/.test(html), "the 'metadata rot' wording is gone");
  ok(!/no\s+existing tool catches it/.test(html), "and so is the 'no existing tool' claim");
  ok(/"@type":"WebSite"/.test(html) && /"name":"Scrobble Drift"/.test(html),
     "search engines are told the site name");
}

console.log("\nfindings that say 'nothing to fix' are not counted");
{
  const { chartWrongness, fixList, affectsChart } = await import("../docs/drift.js");
  const mk = (reason) => ({ detector: "D4", reason, artist: "D-Block Europe", track: "Intro",
    members: [{ album: "Home Alone 2", plays: 9 }, { album: "PTSD", plays: 4 }] });
  for (const r of ["structural", "disproven", "plain-albums"]) {
    ok(!affectsChart(mk(r)), `a '${r}' finding is not a chart problem`);
    eq(fixList([mk(r)]).length, 0, `and never reaches the fix list`);
    eq(chartWrongness([], [mk(r)]).misplaced, 0, `and adds no misplaced plays`);
  }
  eq(fixList([mk("migration")]).length, 1, "a real split still does");
}

console.log("\nanalysis off the main thread, with progress");
{
  const d = await import("../docs/drift.js");
  const sc = [];
  for (let i = 0; i < 300; i++) sc.push({ uts: 1e9 + i, artist: `Act ${i % 40}`,
    album: `LP ${i % 7}`, track: `T${i % 11}` });
  const seen = [];
  const a = d.analyse(sc, { onProgress: (f, label) => seen.push([f, label]) });
  const b = d.analyse(sc);
  eq(JSON.stringify({ ...a, generated: 0 }), JSON.stringify({ ...b, generated: 0 }),
     "progress reporting does not change the report");
  ok(seen.length >= 5 && seen[0][0] === 0 && seen.at(-1)[0] === 1,
     "progress runs from 0 to 1");
  ok(seen.every((x, i) => i === 0 || x[0] >= seen[i - 1][0]), "and never goes backwards");
  let cloned = null;
  try { cloned = structuredClone(a); } catch {}
  ok(cloned && cloned.issues_total === a.issues_total,
     "the report survives the trip back from a worker");

  const html = (await readFile(new URL("../docs/index.html", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  ok(/new Worker\(new URL\("\.\/analyse-worker\.js", import\.meta\.url\)/.test(html),
     "the page analyses in a module worker");
  ok(/if \(!started\) \{\s+try \{ resolve\(analyse\(/.test(html),
     "and falls back to the page if the worker cannot start");
  ok(/analysisWorker\.terminate\(\)/.test(html), "Stop ends a running analysis");
  const w = await readFile(new URL("../docs/analyse-worker.js", import.meta.url), "utf8");
  ok(/import \{ analyse \} from "\.\/drift\.js"/.test(w),
     "the worker runs the same drift.js as the page");
}

console.log("\n'Early Version' is unreleased material");
{
  const d = await import("../docs/drift.js");
  const sc = [
    { uts: 1, artist: "Kanye West", album: "The College Dropout: Early Version", track: "Home" },
    { uts: 2, artist: "Kanye West", album: "Unreleased (Yandhi Era)", track: "Hurricane" },
    { uts: 3, artist: "Kanye West", album: "The College Dropout", track: "Spaceship" },
  ];
  ok(d.weakEraCandidates(sc).some((c) => /Early Version/.test(c.album)),
     "an Early Version album is treated as possible unreleased material");
  ok(!d.weakEraCandidates(sc).some((c) => c.album === "The College Dropout"),
     "the real album is not");
}

console.log("\na song released on both projects is not a split");
{
  const d = await import("../docs/drift.js");
  const issue = { detector: "D4", class: "split", reason: "candidate",
    artist: "Post Malone", track: "Money Made Me Do It", plays_affected: 22,
    suggest: "consolidate to 'Stoney (Deluxe)'",
    members: [{ album: "Stoney (Deluxe)", plays: 21 }, { album: "August 26th", plays: 1 }] };
  const groups = [
    { title: "Stoney", primary: "Album", secondary: [], first_release: "2016-12-09" },
    { title: "August 26th", primary: "Album", secondary: ["Mixtape/Street"], first_release: "2016-05-11" },
  ];
  eq(d.membersOnRelease(issue.members, groups), ["Stoney", "August 26th"],
     "both album strings are found among the release groups, editions ignored");
  const out = d.resolveOne(issue, () => ({ groups }));
  eq(out.reason, "on-both", "the lookup settles it as released on both");
  eq(out.verdict?.label, "On both releases", "and says so on the card");
  ok(out.style_choice === true, "it becomes a tagging choice, not a defect");
  ok(!/split/.test(out.title) && /is on 2 releases/.test(out.title),
     "and the card title stops calling it a split");
  ok(/leave them as they are/.test(out.suggest) && /one album per song/.test(out.suggest),
     "and offers both options: keep accurate, or merge for the chart");
  eq(d.fixList([out]).length, 0, "it leaves the fix list");
  eq(d.chartWrongness([], [out]).misplaced, 0, "and the headline");
  const single = d.resolveOne(issue, () => ({ groups: [groups[0]] }));
  ok(single.reason !== "on-both", "when only one release has it, it is still a split");
  eq(d.membersOnRelease(issue.members,
       [{ title: "Hits", secondary: ["Compilation"] }, groups[0]]), ["Stoney"],
     "a compilation does not count as a second release");
}

console.log("\na checked finding does not vanish from view");
{
  const html = (await readFile(new URL("../docs/index.html", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  ok(/const inChart = \(i\) => affectsChart\(i\) \|\| i\.kept_in_place;/.test(html),
     "a finding a check turned into a choice stays in the list being read");
  ok((html.match(/now\.kept_in_place = true/g) || []).length === 2,
     "for a single check and for Check all");
  ok(/Kept here for now/.test(html), "and the card says where it will go");
}

console.log("\na leak that came out on the album its era is named after");
{
  const d = await import("../docs/drift.js");
  const era = [{ uts: 1, artist: "Kanye West", album: "Unreleased (DONDA Era)", track: "Jail" }];
  const spotify = { groups: [{ title: "Donda", primary: "Album", status: "Official",
    secondary: [], first_release: "2021-08-29", source: "spotify" }] };
  const mbOnly = { groups: [
    { title: "Donda", primary: "Album", status: "Bootleg", secondary: [], first_release: "2021" },
    { title: "DONDA: Miracles", primary: "Album", status: "Official", secondary: [], first_release: "2021" },
  ] };
  eq(d.d14eReleasedSince(era, () => spotify).length, 1,
     "Spotify listing it on Donda counts, even though the era is called DONDA");
  eq(d.d14eReleasedSince(era, () => mbOnly).length, 0,
     "a MusicBrainz release named after the era still does not");
}

console.log("\nleaks are asked about as songs, not as leaked versions");
{
  const d = await import("../docs/drift.js");
  eq(d.eraLookupTitle("Hurricane (feat. Ant Clemons, Ty Dolla $ign & Young Thug)"), "Hurricane",
     "guest credits from the leak are dropped");
  eq(d.eraLookupTitle("Off The Grid (Demo) [feat. Playboi Carti]"), "Off The Grid",
     "and so are version tags like (Demo)");
  eq(d.eraLookupTitle("Bye Bye Baby [V2]"), "Bye Bye Baby", "and [V2]");
  eq(d.eraLookupTitle("Jail (Synthpop Remix)"), "Jail (Synthpop Remix)",
     "but a remix is a different song and keeps its name");
  const era = [
    { uts: 1, artist: "Kanye West", album: "Unreleased (Yandhi Era)", track: "Hurricane (feat. Ant Clemons)" },
    { uts: 2, artist: "Kanye West", album: "Unreleased (Yandhi Era)", track: "Hurricane (feat. Big Sean & Ty Dolla $ign)" },
  ];
  const asked = [];
  const found = d.d14eReleasedSince(era, (a, t) => { asked.push(t); return { groups: [
    { title: "Donda", primary: "Album", status: "Official", secondary: [],
      first_release: "2021-08-29", source: "spotify" }] }; });
  eq(asked, ["Hurricane"], "two leaked versions are one question, asked by the song title");
  eq(found.length, 1, "and one finding");
  ok(/2 leaked versions/.test(found[0].suggest), "which says how many versions you have");
  // The button runs discoveryOffers' jobs, not the resolution plan. Testing only
  // d14eReleasedSince let the first version of this fix ship without effect.
  const offer = d.discoveryOffers(era).find((o) => o.id === "era_released");
  eq(offer.jobs.map((j) => j.track), ["Hurricane"],
     "the 'check for official releases' button asks for the song, once");
}

console.log("\nfilters and lookup results are readable");
{
  const html = (await readFile(new URL("../docs/index.html", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  ok(/All kinds of finding/.test(html) && !/All detectors/.test(html),
     "the filter talks about kinds of finding, not detectors");
  ok(/\$\{esc\(detName\(k\)\)\} \(\$\{N\(v\.count\)\}\)/.test(html),
     "each option is a plain name and a count");
  const d = await import("../docs/drift.js");
  const codes = new Set();
  const src = await readFile(new URL("../docs/drift.js", import.meta.url), "utf8");
  for (const m of src.matchAll(/detector: "(D\d+[a-z]?)"/g)) codes.add(m[1]);
  const named = [...codes].filter((c) => new RegExp(`\\b${c}: "`).test(html));
  eq(named.length, codes.size, "every detector the analysis can produce has a name");
  ok(/\$\{offerResults\(o\)\}/.test(html),
     "a finished lookup lists what it found on its own card");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
