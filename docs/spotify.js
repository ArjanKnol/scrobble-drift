/**
 * Spotify catalogue resolution, client side.
 *
 * ---------------------------------------------------------------------------
 * The problem this solves
 * ---------------------------------------------------------------------------
 * MusicBrainz answers "has this unreleased track been released yet" perfectly
 * and enforces a hard 1 request/second. A library with 4,000 distinct era
 * tracks therefore needs 67 minutes of wall clock, and that is the single
 * slowest thing in a full scan by an order of magnitude.
 *
 * The fix is not a faster API. It is asking a better-shaped question.
 *
 * MusicBrainz is asked PER TRACK: "does a recording named X by artist Y exist
 * on an official release?" 4,000 tracks, 4,000 questions. But those 4,000
 * tracks belong to maybe 250 artists, and Spotify will hand over an artist's
 * ENTIRE official catalogue in a couple of calls. So we ask 250 questions
 * instead of 4,000, get back every title those artists have ever released, and
 * answer all 4,000 locally with zero further network traffic.
 *
 * Roughly 800 calls instead of 4,000, at ~5/s instead of 1/s. Minutes, not
 * hours. The residual, tracks Spotify has never heard of, still goes to
 * MusicBrainz, and that residual is small precisely because it is the genuinely
 * unreleased material.
 *
 * ---------------------------------------------------------------------------
 * Why this cannot replace MusicBrainz
 * ---------------------------------------------------------------------------
 * Spotify's catalogue is a licensing artefact, not a discography. It has no
 * bootlegs, no unofficial releases, patchy pre-2000 coverage, and it loses
 * tracks permanently when a licence lapses. So:
 *
 *   PRESENCE in Spotify  -> strong evidence, act on it
 *   ABSENCE from Spotify -> no evidence at all, ask MusicBrainz
 *
 * Treating absence as a verdict would silently mark genuinely-released tracks
 * as unreleased, which is worse than being slow. That asymmetry is the whole
 * design and every function below preserves it.
 */

import { norm, normTitle, baseTitle } from "./drift.js";

/**
 * Build one artist's complete official title index.
 *
 * Two phases because the Worker splits them: album list first, then tracklists
 * batched 20 at a time. Splitting keeps each Worker request inside the free
 * plan's 10ms CPU budget, which a prolific artist would otherwise blow on JSON
 * parsing alone.
 *
 * `api` is an async (path) => json function supplied by the caller, so pacing,
 * retry and progress reporting all stay outside this module.
 */
export async function fetchCatalogue(artist, api) {
  const found = await api(
    `/api/spotify/artist-albums?artist=${encodeURIComponent(artist)}`);

  const empty = { artist, found: false, albums: [], titles: new Map(), releases: 0 };

  // CRITICAL distinction. A null response means the CALL failed; a response with
  // found:false means Spotify genuinely has no such artist. Both leave us with
  // no catalogue, but only the second is an answer.
  //
  // Conflating them poisons the cache: a transient Spotify outage would write
  // "this artist does not exist" to disk permanently, and every later scan would
  // read that back and skip the lookup forever. So `error` is flagged, and the
  // caller must not persist a result carrying it.
  if (found == null) return { ...empty, error: true };
  if (!found.found) return empty;

  const ids = (found.albums || []).map((a) => a.id);

  // Albums are stored ONCE in a flat list and referenced by index from the
  // title map. The obvious alternative, copying the album object onto every
  // track, costs about 20x more: a prolific artist has ~1,500 tracks and ~50
  // releases, and this index is persisted to IndexedDB for every artist in the
  // library. Inlining measured out near 150MB total, which competes with the
  // scrobble data itself for the same quota and would fail a large scan.
  const albums = [];
  const seen = new Map();     // rg_id -> index into albums
  const titles = new Map();   // match key -> [album index]
  let partial = false;

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const res = await api(`/api/spotify/album-tracks?ids=${batch.join(",")}`);
    if (res?.partial) partial = true;

    for (const t of res?.tracks || []) {
      const al = t.album;
      if (!al?.rg_id) continue;
      let idx = seen.get(al.rg_id);
      if (idx === undefined) {
        idx = albums.length;
        // Only the fields the detectors read. url and total_tracks were used to
        // classify the release inside the Worker and are dead weight here.
        albums.push({
          rg_id: al.rg_id, title: al.title, primary: al.primary,
          secondary: al.secondary || [], first_release: al.first_release,
          status: al.status, source: "spotify",
        });
        seen.set(al.rg_id, idx);
      }
      // Index under BOTH the literal title and the feature-stripped base
      // title. A leak scrobbled as "Sicko Mode (feat. Drake)" must find the
      // official "SICKO MODE", and D8's whole premise is that those two
      // spellings coexist in the same library.
      for (const k of keysFor(t.title)) {
        const list = titles.get(k);
        if (list) { if (!list.includes(idx)) list.push(idx); }
        else titles.set(k, [idx]);
      }
    }
  }

  return {
    artist,
    found: true,
    artist_name: found.artist_name,
    albums,
    titles,
    releases: ids.length,
    truncated: Boolean(found.truncated),
    partial,
  };
}

/**
 * Match keys for a title, most precise first.
 *
 * Diacritics are PRESERVED in the primary key. This is not pedantry: the
 * library genuinely contains "Back Home" and "Back Homë" as two different Yeat
 * tracks, and folding them together would produce a confidently wrong answer
 * about which one was released. The diacritic-folded key is offered as a
 * separate, clearly-marked fallback tier rather than mixed into the first.
 */
/**
 * Edition qualifiers, for collapsing pressings of one album into one candidate.
 *
 * Only stripped when they appear as a trailing qualifier, in brackets or after a
 * dash. A bare word match would destroy real titles: Deluxe is a Chief Keef
 * mixtape, and there are albums literally called Remastered and Anniversary.
 * The list is deliberately conservative for the same reason. False merges here
 * would produce wrong consolidation advice, which is worse than a slightly
 * longer candidate list.
 */
const EDITION = new RegExp(
  "[\\s]*(?:[\\(\\[][^\\)\\]]*\\b(?:deluxe|expanded|extended|remaster(?:ed)?|" +
  "anniversary|edition|version|explicit|clean|bonus|reissue|special|complete|" +
  "int[eé]grale|super)\\b[^\\)\\]]*[\\)\\]]" +
  "|[-–—]\\s*(?:deluxe|expanded|extended|remaster(?:ed)?|anniversary|" +
  "reissue|special)(?:\\s+(?:edition|version))?)\\s*$", "i");

function editionKey(title) {
  let out = title || "", prev = null;
  // Looped: "Rodeo (Deluxe) (Remastered)" needs both stripped.
  while (out !== prev) { prev = out; out = out.replace(EDITION, "").trim(); }
  // Fall back to the full title if stripping emptied it, which happens for an
  // album genuinely named e.g. "Deluxe".
  return norm(out) || norm(title);
}

function keysFor(title) {
  const keys = new Set();
  const exact = normTitle(title);
  if (exact) keys.add(exact);
  const base = normTitle(baseTitle(title));
  if (base) keys.add(base);
  return keys;
}

/**
 * Resolve one track against a catalogue index.
 *
 * Returns the same `{ groups: [...] }` shape as /api/mb/recording, so
 * d0Resolve and d14eReleasedSince consume it without knowing the source. That
 * is the entire reason the Worker adapts Spotify albums into release-group
 * shape: one detector contract, swappable evidence.
 *
 * Returns null on a miss, which the caller must read as "ask MusicBrainz", NOT
 * as "unreleased".
 */
export function matchTrack(cat, track) {
  if (!cat?.found || !cat.titles?.size) return null;

  const exact = normTitle(track);
  let idxs = cat.titles.get(exact);
  let tier = "exact";

  if (!idxs) {
    const base = normTitle(baseTitle(track));
    if (base && base !== exact) { idxs = cat.titles.get(base); tier = "base"; }
  }
  if (!idxs) {
    // Last tier: fold diacritics and punctuation. Deliberately last, and
    // deliberately marked, because this is the tier that can conflate two
    // genuinely distinct titles.
    const folded = norm(track);
    for (const [k, v] of cat.titles) {
      if (norm(k) === folded) { idxs = v; tier = "folded"; break; }
    }
  }
  if (!idxs?.length) return null;

  // Collapse editions. Spotify lists the standard, deluxe, explicit, anniversary
  // and regional pressings of one album as separate objects with separate dates.
  // Keying on the raw title would leave all of them in the candidate list, and
  // "consolidate to 'Rodeo (Deluxe)'" is bad advice when 'Rodeo' is the album.
  // editionKey strips the qualifier so they merge, and the earliest date within
  // each merged group wins, which is the original pressing.
  const byTitle = new Map();
  for (const i of idxs) {
    const g = cat.albums[i];
    if (!g) continue;
    const k = editionKey(g.title);
    const cur = byTitle.get(k);
    if (!cur || (g.first_release || "9999") < (cur.first_release || "9999")) {
      byTitle.set(k, g);
    }
  }

  const groups = [...byTitle.values()].sort((a, b) =>
    (a.first_release || "9999").localeCompare(b.first_release || "9999"));

  return { groups, source: "spotify", tier };
}

/**
 * Group a resolution plan by artist, busiest artist first.
 *
 * Ordering matters when a budget is capped: one catalogue fetch for an artist
 * with 300 era tracks buys 300 answers, so spending the early budget on the
 * biggest artists maximises coverage per call. This is the batching win, and it
 * is why the plan is reshaped from per-track to per-artist before any network
 * traffic happens.
 */
export function byArtist(plan) {
  const groups = new Map();
  for (const job of plan) {
    const k = norm(job.artist);
    const cur = groups.get(k);
    if (cur) { cur.jobs.push(job); cur.plays += job.plays || 0; }
    else groups.set(k, { artist: job.artist, jobs: [job], plays: job.plays || 0 });
  }
  return [...groups.values()].sort((a, b) => b.plays - a.plays);
}

/**
 * Estimate the call count before spending anything.
 *
 * Shown in the dry run so the cost is visible up front rather than discovered
 * 40 minutes in. Per artist: one album-list call, plus one album-tracks call
 * per 20 releases. Twelve releases is the observed median once compilations and
 * singles are included.
 */
export function estimate(artistGroups, { albumsPerArtist = 12 } = {}) {
  const perArtist = 1 + Math.ceil(albumsPerArtist / 20);
  const calls = artistGroups.length * perArtist;
  return {
    artists: artistGroups.length,
    tracks: artistGroups.reduce((n, g) => n + g.jobs.length, 0),
    calls,
    // 5/s is a deliberately conservative read of Spotify's undocumented
    // limit. It publishes no number, only 429 with Retry-After.
    seconds: Math.ceil(calls / 5),
  };
}
