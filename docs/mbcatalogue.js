/**
 * MusicBrainz artist catalogues, client side.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 * The Spotify catalogue trick replaced one lookup per track with one per artist,
 * and made that phase several times faster. The same idea was never applied to
 * MusicBrainz, which is where it is worth far more, because MusicBrainz allows
 * exactly ONE request per second.
 *
 * Measured on a real 10,000-scrobble scan: Spotify resolved most of 1,407 tracks
 * in about two minutes, and the few hundred it could not answer then took five
 * more minutes at one search per second. That residual is the whole cost of the
 * scan, and those few hundred tracks belong to only a few dozen artists.
 *
 * So: browse each artist's official releases WITH tracklists, build the same kind
 * of title index Spotify builds, and answer every one of that artist's tracks
 * locally.
 *
 * ---------------------------------------------------------------------------
 * Two things the docs settled that were not obvious
 * ---------------------------------------------------------------------------
 *  - Browsing RECORDINGS by artist cannot include releases. The only `inc`
 *    values for a recording browse are artist-credits and isrcs, so it would
 *    tell us an artist has a track called X without telling us whether it was
 *    ever released, which is exactly the question. Browsing RELEASES supports
 *    `inc=recordings`, so that is the right direction.
 *  - Release browse paging is unusual. Responses are capped at roughly 500
 *    tracks, so fewer than `limit` releases may come back, and the offset must
 *    advance by the number ACTUALLY RETURNED. Advancing by the limit silently
 *    skips releases.
 *
 * The output shape is deliberately identical to spotify.js, so matchTrack() in
 * that module works against either source with no branching. Adding a third
 * source should mean writing another module like this one and nothing else.
 */

import { norm, normTitle, baseTitle } from "./drift.js";

/** Cap on pages per artist. 5 pages is ~2,500 tracks, more than any real
 *  discography needs, and it bounds the worst case for a very prolific artist. */
const MAX_PAGES = 5;

/**
 * Build one artist's official title index from MusicBrainz.
 *
 * `mbid` may be null, in which case the artist name is resolved first. Last.fm
 * supplies artist_mbid on many scrobbles but not all, and using the supplied one
 * saves a call as well as removing any chance of resolving to the wrong artist.
 *
 * `api` is an async (path) => json function, so pacing, retry and progress all
 * stay in the caller, exactly as in spotify.js. That is what lets this be tested
 * offline with no network and no rate limit.
 */
export async function fetchMbCatalogue(artist, mbid, api) {
  const empty = {
    artist, mbid: mbid || null, found: false,
    albums: [], titles: new Map(), releases: 0, source: "musicbrainz",
  };

  let id = mbid;
  if (!id) {
    const res = await api(
      `/api/mb/artist-id?artist=${encodeURIComponent(artist)}`);
    // null means the CALL failed; found:false means MusicBrainz has no such
    // artist. Only the second is an answer, and only the first must block
    // caching. Same distinction as spotify.js, for the same reason: caching a
    // failure writes a permanent false negative.
    if (res == null) return { ...empty, error: true };
    if (!res.found || !res.mbid) return empty;
    id = res.mbid;
  }

  const albums = [];
  const seen = new Map();     // rg_id -> index into albums
  const titles = new Map();   // match key -> [album index]
  let failed = 0;
  let offset = 0;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_PAGES) {
    const page = await api(
      `/api/mb/artist-catalogue?mbid=${id}&offset=${offset}`);
    if (page == null) { failed++; break; }
    pages++;

    for (const rel of page.releases || []) {
      if (!rel?.rg_id) continue;
      let idx = seen.get(rel.rg_id);
      if (idx === undefined) {
        idx = albums.length;
        albums.push({
          rg_id: rel.rg_id, title: rel.title, primary: rel.primary,
          secondary: rel.secondary || [], first_release: rel.first_release,
          status: rel.status, source: "musicbrainz",
        });
        seen.set(rel.rg_id, idx);
      }
      for (const t of rel.tracks || []) {
        // Same dual key as Spotify: the literal title and the feature-stripped
        // base title, so a leak tagged "Sicko Mode (feat. Drake)" finds the
        // official "SICKO MODE".
        for (const k of keysFor(t)) {
          const list = titles.get(k);
          if (list) { if (!list.includes(idx)) list.push(idx); }
          else titles.set(k, [idx]);
        }
      }
    }

    if (!page.next_offset) break;
    offset = page.next_offset;
    if (pages >= MAX_PAGES) truncated = true;
  }

  return {
    artist, mbid: id, found: true,
    albums, titles,
    releases: albums.length,
    source: "musicbrainz",
    truncated,
    // A failed page leaves the index incomplete, so the caller must not persist
    // it. An artist with 40 releases whose second page failed would otherwise be
    // cached as having 20, and every later scan would trust that.
    error: failed > 0,
    failed_pages: failed,
  };
}

/**
 * Match keys for a title, most precise first.
 *
 * Identical to the Spotify module by design. Diacritics are preserved in the
 * primary key: the library genuinely contains "Back Home" and "Back Homë" as two
 * different Yeat tracks.
 */
function keysFor(title) {
  const keys = new Set();
  const exact = normTitle(title);
  if (exact) keys.add(exact);
  const base = normTitle(baseTitle(title));
  if (base) keys.add(base);
  return keys;
}

/**
 * Which artists are worth a catalogue browse rather than per-track searches?
 *
 * A catalogue costs 1 to 6 calls and answers every one of that artist's tracks.
 * A per-track search costs exactly one call per track. So the catalogue wins as
 * soon as an artist has more tracks to check than the catalogue costs, and loses
 * for an artist with a single track.
 *
 * Splitting on that boundary rather than picking one strategy is worth real time:
 * a residual of 300 tracks over 40 artists is mostly artists with one or two
 * tracks, where a browse would be pure overhead.
 */
export function splitByStrategy(jobs, { catalogueCost = 2 } = {}) {
  const byArtist = new Map();
  for (const job of jobs) {
    const k = norm(job.artist);
    const rec = byArtist.get(k) ||
      { artist: job.artist, mbid: job.artist_mbid || null, jobs: [], plays: 0 };
    rec.jobs.push(job);
    rec.plays += job.plays || 0;
    // Any scrobble's mbid will do, and having one skips the name lookup.
    if (!rec.mbid && job.artist_mbid) rec.mbid = job.artist_mbid;
    byArtist.set(k, rec);
  }

  const catalogue = [], perTrack = [];
  for (const rec of byArtist.values()) {
    // An artist with a known MBID costs one call less, so the threshold drops.
    const cost = rec.mbid ? catalogueCost - 1 : catalogueCost;
    if (rec.jobs.length > cost) catalogue.push(rec);
    else perTrack.push(...rec.jobs);
  }
  catalogue.sort((a, b) => b.plays - a.plays);
  return { catalogue, perTrack };
}

/**
 * Estimated call count for a split, so the UI can show an honest wait.
 *
 * `pages = 1` because a browse returns up to 100 releases capped at ~500 tracks,
 * and most artists fit in one page. Only genuinely prolific discographies need a
 * second, and the paging loop handles those without the estimate needing to.
 *
 * This matters for the threshold, not just the display: with a known MBID a
 * catalogue is ONE call, so any artist with two or more residual tracks is
 * already cheaper to browse than to search. Assuming two pages set the bar twice
 * as high as it needed to be and sent artists to per-track search that a browse
 * would have covered for free.
 */
export function estimateMb({ catalogue, perTrack }, { pages = 1 } = {}) {
  const calls = catalogue.reduce(
    (n, a) => n + (a.mbid ? 0 : 1) + pages, 0) + perTrack.length;
  return {
    artists: catalogue.length,
    catalogue_tracks: catalogue.reduce((n, a) => n + a.jobs.length, 0),
    per_track: perTrack.length,
    calls,
    // MusicBrainz is a hard 1 request per second. No concurrency changes that.
    seconds: calls,
  };
}
