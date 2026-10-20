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

/*
 * `fetchCatalogue`, `byArtist` and `estimate` lived here and are gone.
 *
 * They batched Spotify lookups by ARTIST: one album list plus one tracklist
 * call answered every track by that artist, instead of one search per track.
 * The win was real and large, and it is unreachable: `GET /albums?ids=` returns
 * 403 Forbidden to a client-credentials app, and it was the only source of
 * tracklists. Re-verified against the live Worker before deleting this.
 *
 * It cannot be rebuilt a different way. `/artists/{id}/albums` works and gives
 * names, types and track counts, but not tracklists, and the question these
 * answered is "which album contains this track" -- the album name is the thing
 * being looked for, so matching on it is circular.
 *
 * What survives: `matchTrack`, which is a generic matcher over a catalogue
 * index and is still used, because the MUSICBRAINZ browse DOES return
 * tracklists via `inc=recordings`. And `fetchTrack`, the per-track search that
 * replaced all of this.
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
 * Which releases contain one track, asked of Spotify directly.
 *
 * This replaces the catalogue-plus-tracklists approach, which cannot work any
 * more. `GET /albums?ids=` returns 403 Forbidden to a client-credentials app, and
 * that endpoint was the only source of tracklists, so `fetchCatalogue` built an
 * index with no titles in it and `matchTrack` missed every single time. The
 * visible symptom was "Spotify: 0 of 150 tracks resolved" followed by every
 * lookup falling through to MusicBrainz at one per second.
 *
 * Confirmed by probing what the app is actually entitled to:
 *
 *   search type=artist / album / track    OK
 *   GET /artists/{id}/albums              OK
 *   GET /albums?ids=                      403 Forbidden
 *
 * `search type=track` still works and returns each track with its album, its
 * album type and its release date, which is everything the detectors need. One
 * call per track at 3/s rather than about eight per artist, and the Worker caches
 * the answer in D1 so it is shared across everyone.
 *
 * Returns the SAME shape as matchTrack and as /api/mb/recording: `{ groups }`
 * sorted earliest first. That is what lets d0Resolve, d14eReleasedSince and
 * d16StrandedSingles stay unaware of which source answered.
 */
export async function fetchTrack(artist, track, api) {
  /*
   * `api` here is spPaced, which returns the PARSED BODY or null. Not a Response.
   * The first version of this checked `res.ok` and read `res.data`, which are
   * both undefined on a plain object, so every call looked like a failure and
   * routed everything to MusicBrainz. Same contract as fetchCatalogue uses a few
   * lines up, which is where it should have been read from.
   */
  const body = await api(
    "/api/spotify/track?" + new URLSearchParams({ artist, track }));

  // null is a failed call, not an answer. Flagged so the caller sends the track
  // to MusicBrainz rather than recording "Spotify has never heard of this",
  // which would be a permanent false negative.
  if (body == null) return { groups: [], source: "spotify", error: true };

  const groups = body.groups || [];
  return {
    groups,
    source: "spotify",
    // Whether the Worker served this from the shared cache: the difference
    // between a call that cost Spotify something and one database read.
    shared: Boolean(body.shared),
    tier: groups.length ? "exact" : "none",
  };
}
