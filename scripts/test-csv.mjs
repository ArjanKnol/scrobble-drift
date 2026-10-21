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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
