/**
 * Read a scrobble export from a CSV file, entirely in the browser.
 *
 * Why this exists: a full-history scan through the Last.fm API needs your own
 * API key and can take ten minutes or more. Several people already have their
 * whole history as a file, usually from lastfmstats.com, and asked to use that
 * instead. A file costs nothing upstream, has no rate limit and no batch that
 * can exceed the Worker's CPU budget.
 *
 * Formats accepted:
 *
 *   1. lastfmstats.com: semicolon separated, header row
 *        Artist;Album;AlbumId;Track;Date#username
 *      Date is epoch MILLISECONDS. The username rides along in the Date header,
 *      which is how the report knows whose library links to build.
 *
 *   2. Any headered CSV with Artist, Album, Track (or Title/Song) and Date
 *      columns, comma or semicolon separated. Date may be epoch seconds, epoch
 *      milliseconds, or a date string a browser can parse.
 *
 *   3. The headerless four-column export (artist, album, track, date) produced
 *      by the older lastfm-to-csv tool.
 *
 * Output is the same shape fetchAll() produces from the API, newest first, so
 * everything downstream works unchanged.
 */

/** Split CSV text into records, honouring quotes, doubled quotes and CRLF. */
export function parseRecords(text, delim) {
  const out = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delim) {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      out.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Pick the delimiter from the first line: whichever splits it into more fields. */
export function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const count = (d) => first.split(d).length;
  return count(";") > count(",") ? ";" : ",";
}

/**
 * Turn a Date cell into epoch SECONDS, or null.
 *
 * Digits only: anything above 1e11 is milliseconds (1e11 seconds is the year
 * 5138), anything below is seconds. Otherwise a date string, read as UTC when it
 * carries no zone, because Last.fm's own exports are UTC.
 */
export function toUts(cell) {
  const s = String(cell ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }
  const zoned = /(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT)\s*$/i.test(s);
  const t = Date.parse(zoned ? s : `${s} UTC`);
  if (Number.isFinite(t)) return Math.floor(t / 1000);
  const t2 = Date.parse(s);
  return Number.isFinite(t2) ? Math.floor(t2 / 1000) : null;
}

const HEAD = {
  artist: "artist", "artist name": "artist",
  album: "album", "album name": "album",
  track: "track", title: "track", song: "track", "track name": "track",
  date: "date", time: "date", timestamp: "date", uts: "date", "played at": "date",
};

/**
 * Parse an export.
 *
 * Returns { scrobbles, username, skipped, format }. Throws an Error with a
 * plain-English message when the file is clearly not a scrobble export, so the
 * page can show it as-is.
 */
export function parseScrobbleCsv(text) {
  text = String(text || "").replace(/^﻿/, "");
  if (!text.trim()) throw new Error("That file is empty.");

  const delim = sniffDelimiter(text);
  const rows = parseRecords(text, delim);
  if (!rows.length) throw new Error("That file has no rows.");

  // Map the header, if there is one.
  let username = null;
  const cols = {};
  rows[0].forEach((raw, i) => {
    const h = raw.trim().toLowerCase();
    const user = h.match(/^date#(.+)$/);
    if (user) { cols.date ??= i; username = raw.trim().slice(5) || null; return; }
    const key = HEAD[h];
    if (key && cols[key] === undefined) cols[key] = i;
  });

  let body, format;
  if (cols.artist !== undefined && cols.track !== undefined && cols.date !== undefined) {
    body = rows.slice(1);
    format = username ? "lastfmstats" : "csv";
  } else if (rows[0].length === 4 && toUts(rows[0][3]) !== null) {
    // No header, but the first row already looks like data: artist, album,
    // track, date. The old lastfm-to-csv layout.
    cols.artist = 0; cols.album = 1; cols.track = 2; cols.date = 3;
    body = rows;
    format = "headerless";
  } else {
    throw new Error(
      "This does not look like a scrobble export. It needs columns for " +
      "Artist, Album, Track and Date. A lastfmstats.com export works as-is.");
  }

  const scrobbles = [];
  let skipped = 0;
  for (const r of body) {
    const artist = (r[cols.artist] ?? "").trim();
    const track = (r[cols.track] ?? "").trim();
    const uts = toUts(r[cols.date]);
    if (!artist || !track || uts === null) { skipped++; continue; }
    scrobbles.push({
      uts,
      artist,
      artist_mbid: "",
      album: cols.album !== undefined ? (r[cols.album] ?? "").trim() : "",
      album_mbid: "",
      track,
      track_mbid: "",
    });
  }
  if (!scrobbles.length) {
    throw new Error("No usable scrobbles in that file. Every row was missing " +
                    "an artist, a track or a readable date.");
  }

  // Newest first, matching what the API returns.
  scrobbles.sort((a, b) => b.uts - a.uts);

  // A Last.fm username is 2 to 15 characters; keep only something plausible so a
  // malformed header can never end up inside a link.
  if (username && !/^[A-Za-z0-9_.-]{2,20}$/.test(username)) username = null;

  return { scrobbles, username, skipped, format };
}
