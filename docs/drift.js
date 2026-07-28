/**
 * Scrobble Drift detectors, browser build.
 *
 * A faithful port of scripts/detectors.py. Same rules, same thresholds, same
 * issue shapes. Pure functions over an array of scrobbles:
 *
 *   {uts, artist, artist_mbid, album, album_mbid, track, track_mbid}
 *
 * NOTE ON DUPLICATION: this logic now exists in Python and JavaScript. That is
 * a real maintenance liability and should not be permanent. The Python version
 * powers the scheduled monitor; this one powers self-service scanning in the
 * browser. Consolidating on this file and running the monitor from a Worker
 * cron would leave one implementation. See README.
 */

/* ------------------------------------------------------------ normalising */

const APOSTROPHES = /[‘’ʼ`´]/g;

export function norm(text, { dropThe = false } = {}) {
  if (!text) return "";
  let s = text.normalize("NFKD").replace(APOSTROPHES, "'");
  s = s.replace(/\p{M}/gu, "");                 // strip combining marks
  s = s.replace(/[^\p{L}\p{N}\s']/gu, " ").toLowerCase();
  s = s.replace(/\s+/g, " ").trim();
  if (dropThe && s.startsWith("the ")) s = s.slice(4);
  return s;
}

/**
 * Ratcliff/Obershelp similarity, matching Python's SequenceMatcher.ratio().
 *
 * Implemented properly rather than substituting Levenshtein, because every
 * threshold in this file was tuned against SequenceMatcher. Swapping the
 * metric would silently change which issues fire.
 */
export function similar(a, b) {
  if (!a.length && !b.length) return 1;
  const total = a.length + b.length;
  if (!total) return 0;
  return (2 * matchingChars(a, b)) / total;
}

function matchingChars(a, b) {
  if (!a.length || !b.length) return 0;
  let bestI = 0, bestJ = 0, bestLen = 0;
  // Longest common substring via the standard rolling row.
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > bestLen) { bestLen = cur[j]; bestI = i - cur[j]; bestJ = j - cur[j]; }
      }
    }
    prev = cur;
  }
  if (!bestLen) return 0;
  return bestLen
    + matchingChars(a.slice(0, bestI), b.slice(0, bestJ))
    + matchingChars(a.slice(bestI + bestLen), b.slice(bestJ + bestLen));
}

const counter = (items, keyOf) => {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
};
const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const monthOf = (uts) => new Date(uts * 1000).toISOString().slice(0, 7);
const monthName = (uts) =>
  new Date(uts * 1000).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });

/* --------------------------------------------- D14: era-tagged unreleased */

const ERA_ALBUM =
  /unreleased|\(\s*[^)]*\bera\b[^)]*\)|\bleak(?:ed)?\b|\bsnippet\b|\bOG\s*file\b|\bref(?:erence)?\s*track\b|\bCDQ\b/i;
const ERA_NAME = /\(\s*([^)]*?)\s*era\s*\)/i;

export const isEraTagged = (album) => Boolean(album) && ERA_ALBUM.test(album);
export const eraName = (album) => {
  const m = ERA_NAME.exec(album || "");
  return m ? m[1].trim() : null;
};

/**
 * The guard. Era-tagged material is partitioned out before anything else and
 * hidden from D0, D4, D1 and D13.
 *
 * Without this, D0 resolves "Unreleased (Rodeo Era)" against MusicBrainz,
 * finds "Rodeo", and confidently recommends merging them, destroying a
 * deliberate distinction. And every leak gets flagged as a typo because it has
 * near-zero listeners and no database entry. Confidently damaging a carefully
 * maintained taxonomy is the worst thing this tool could do.
 */
export function partitionEra(scrobbles) {
  const era = [], rest = [];
  for (const s of scrobbles) (isEraTagged(s.album) ? era : rest).push(s);
  return { era, rest };
}

export function d14Overview(era, totalPlays) {
  const albums = counter(era, (s) => `${s.artist}␟${s.album}`);
  const perArtist = new Map();
  for (const s of era) {
    const name = eraName(s.album);
    if (!name) continue;
    if (!perArtist.has(s.artist)) perArtist.set(s.artist, new Map());
    const m = perArtist.get(s.artist);
    m.set(name, (m.get(name) || 0) + 1);
  }
  return {
    plays: era.length,
    share_of_all_plays: totalPlays ? +((100 * era.length) / totalPlays).toFixed(2) : 0,
    album_strings: albums.size,
    artists: perArtist.size,
    distinct_eras: [...perArtist.values()].reduce((n, m) => n + m.size, 0),
    top_albums: ranked(albums).slice(0, 25).map(([key, plays]) => ({ key, plays })),
  };
}

export function d14aFormatVariants(era) {
  const issues = [];
  const byArtistAlbum = new Map(), byArtistEra = new Map();
  for (const s of era) {
    if (!byArtistAlbum.has(s.artist)) byArtistAlbum.set(s.artist, new Map());
    const a = byArtistAlbum.get(s.artist);
    a.set(s.album, (a.get(s.album) || 0) + 1);
    const name = eraName(s.album);
    if (name) {
      if (!byArtistEra.has(s.artist)) byArtistEra.set(s.artist, new Map());
      const e = byArtistEra.get(s.artist);
      e.set(name, (e.get(name) || 0) + 1);
    }
  }

  const shapes = new Map();
  for (const s of era) {
    const m = ERA_NAME.exec(s.album || "");
    if (m) {
      const tok = m[0].trim().slice(-4, -1);
      shapes.set(tok, (shapes.get(tok) || 0) + 1);
    }
  }
  const dominant = shapes.size ? ranked(shapes)[0][0] : "Era";

  // (a) Whole-string variants. Compares full album strings, not just the
  // extracted era name: ERA_NAME discards the literal "Era" token, so
  // comparing names alone silently misses "(EALL era)" vs "(EALL Era)".
  for (const [artist, strings] of byArtistAlbum) {
    const buckets = new Map();
    for (const raw of strings.keys()) {
      const k = norm(raw);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(raw);
    }
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      const order = [...group].sort((a, b) => strings.get(b) - strings.get(a));
      const caseOnly = new Set(group.map((g) => g.toLowerCase())).size === 1;
      issues.push({
        detector: "D14a",
        class: caseOnly ? "unfixable" : "split",
        confidence: 0.95,
        artist,
        title: `Era tag written ${group.length} ways for ${artist}: ` +
               order.map((g) => `'${g}'`).join(", "),
        plays_affected: group.reduce((n, g) => n + strings.get(g), 0),
        suggest: caseOnly
          ? `casing-only difference against your usual '${dominant}' style. ` +
            `Last.fm cannot change casing, so this is informational rather ` +
            `than actionable.`
          : `standardise on '${order[0]}' (${strings.get(order[0])} plays).`,
        members: order.map((g) => ({ album: g, plays: strings.get(g) })),
      });
    }
  }

  // (b) Typos in the era name, scoped to one artist so the candidate set is
  // tiny. Floor is 0.82 not 0.90 because transpositions score low
  // ('Yandhi' vs 'Yhandi' is 0.83), paired with a play-count asymmetry test
  // so a deliberate 'V2' project is not mistaken for a misspelling.
  for (const [artist, counts] of byArtistEra) {
    const names = [...counts.keys()];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        if (norm(a) === norm(b) || similar(norm(a), norm(b)) < 0.82) continue;
        const [lo, hi] = counts.get(a) <= counts.get(b) ? [a, b] : [b, a];
        if (counts.get(lo) > Math.max(2, 0.25 * counts.get(hi))) continue;
        const sequel = differsOnlyByVersion(lo, hi);
        issues.push({
          detector: "D14a",
          // A trailing number or version token means these are very likely
          // distinct projects, not a misspelling: 'Drip Season' and 'Drip
          // Season 3' are two different Gunna tapes. Play count asymmetry
          // cannot separate that from a typo, so downgrade to review rather
          // than assert an error.
          class: sequel ? "review" : "error",
          confidence: sequel ? 0.35 : 0.7,
          artist,
          title: sequel
            ? `Similar era names for ${artist}: '${lo}' vs '${hi}'`
            : `Probable era-name typo for ${artist}: '${lo}' vs '${hi}'`,
          plays_affected: counts.get(lo) + counts.get(hi),
          suggest: sequel
            ? `these differ only by a version or sequel marker, so they are ` +
              `probably separate projects rather than a typo. Flagged in case ` +
              `one is wrong. '${hi}' has ${counts.get(hi)} plays, '${lo}' has ` +
              `${counts.get(lo)}.`
            : `'${hi}' has ${counts.get(hi)} plays against ` +
              `${counts.get(lo)}, so '${lo}' is likely the typo.`,
          members: [lo, hi].map((n) => ({ era: n, plays: counts.get(n) })),
        });
      }
    }
  }
  return issues;
}

const VERSION_TAIL =
  /\s*(?:v\.?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?|og|alt|final|deluxe|pt\.?\s*\d+)$/i;

/**
 * True when two names are identical once a trailing version token is cut.
 *
 * Catches sequels ('Drip Season' / 'Drip Season 3'), numbered versions
 * ('Luv Is Rage' / 'Luv Is Rage 2') and leak-scene markers ('Eternal Atake v1'
 * / 'Eternal Atake OG'), all routinely distinct releases rather than typos.
 */
function differsOnlyByVersion(a, b) {
  const sa = a.replace(VERSION_TAIL, "").trim();
  const sb = b.replace(VERSION_TAIL, "").trim();
  return norm(sa) === norm(sb) && (sa !== a || sb !== b);
}

export function d14cTrackInTwoEras(era) {
  const where = new Map();
  for (const s of era) {
    const name = eraName(s.album);
    if (!name) continue;
    const k = `${s.artist}␟${norm(s.track)}`;
    if (!where.has(k)) where.set(k, { artist: s.artist, track: s.track, eras: new Map() });
    const e = where.get(k).eras;
    e.set(name, (e.get(name) || 0) + 1);
  }
  const issues = [];
  for (const { artist, track, eras } of where.values()) {
    if (eras.size < 2) continue;
    const versioned = [...eras.keys()].some((e) => /\bv\d+\b/i.test(e));
    issues.push({
      detector: "D14c",
      class: versioned ? "review" : "error",
      confidence: versioned ? 0.5 : 0.8,
      artist,
      title: `${artist} - '${track}' appears in ${eras.size} eras: ` +
             [...eras.keys()].sort().join(", "),
      plays_affected: [...eras.values()].reduce((a, b) => a + b, 0),
      suggest: versioned
        ? "a V2-style project is involved, so these may be genuinely " +
          "different versions. Verify before merging."
        : "one of these eras is wrong. Pick the correct one.",
      members: ranked(eras).map(([era_, plays]) => ({ era: era_, plays })),
    });
  }
  return issues;
}

/* ------------------------------------------------- D4 splits, D0 temporal */

const EDITION =
  /\s*[([\-]\s*(deluxe|expanded|remaster(?:ed)?|anniversary|bonus|special|complete|extended|super\s*deluxe|japanese|uk|us|explicit|clean|alternate)\b[^)\]]*[)\]]?\s*$/i;
const COMPILATION =
  /greatest\s+hits|best\s+of|\bhits\b|anthology|collection|compilation|now\s+that'?s\s+what\s+i\s+call|essential|retrospective/i;

function classifyAlbumString(album, track) {
  if (album === "(no album)") return "missing";
  if (norm(album) === norm(track)) return "single (album titled after the track)";
  if (/\s*[-–]\s*(single|ep)$/i.test(album)) return "single or EP";
  if (COMPILATION.test(album)) return "compilation";
  if (EDITION.test(album)) return "edition variant";
  return "album";
}

/**
 * The single-to-album migration, provable rather than inferred: if every play
 * of one album string predates every play of another, the track moved between
 * releases at a point in time. That is the release history of the record
 * reconstructed from the listener's own history, not a string-similarity guess.
 */
function temporalSignature(members) {
  if (members.length !== 2) return null;
  const [a, b] = [...members].sort((x, y) => x.first - y.first);
  if (a.last > b.first) return null;
  return {
    pattern: "clean_handover",
    earlier: a.album, later: b.album, boundary: b.first,
    note: `every play of '${a.album}' predates every play of '${b.album}'. ` +
          `Classic single-absorbed-into-album migration around ${monthName(b.first)}.`,
  };
}

export function d4AlbumSplits(rest, minPlays = 2) {
  const groups = new Map();
  for (const s of rest) {
    const k = `${norm(s.artist)}␟${norm(s.track)}`;
    if (!groups.has(k)) {
      groups.set(k, { artist: s.artist, track: s.track, albums: new Map(),
                      first: new Map(), last: new Map() });
    }
    const g = groups.get(k);
    const album = s.album || "(no album)";
    g.albums.set(album, (g.albums.get(album) || 0) + 1);
    g.first.set(album, Math.min(g.first.get(album) ?? s.uts, s.uts));
    g.last.set(album, Math.max(g.last.get(album) ?? s.uts, s.uts));
  }

  const issues = [];
  for (const g of groups.values()) {
    const total = [...g.albums.values()].reduce((a, b) => a + b, 0);
    if (g.albums.size < 2 || total < minPlays) continue;
    const members = ranked(g.albums).map(([album, plays]) => ({
      album, plays,
      first: g.first.get(album), last: g.last.get(album),
      looks_like: classifyAlbumString(album, g.track),
    }));
    const temporal = temporalSignature(members);
    issues.push({
      detector: "D4", class: "split",
      confidence: temporal ? 0.9 : 0.85,
      artist: g.artist, track: g.track,
      title: `${g.artist} - '${g.track}' split across ${g.albums.size} album strings`,
      plays_affected: total,
      suggest: temporal
        ? `consolidate to '${temporal.later}': the earlier string looks like ` +
          `the pre-album release.`
        : `candidate for consolidation. Enable MusicBrainz resolution for a ` +
          `confirmed target.`,
      members, temporal,
    });
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/* --------------------------------------------------- D8 feature credits */

// Only a BRACKETED trailing credit is stripped. An unbracketed "with" occurs
// in real titles ("Dancing With Myself", "With You"), and merging genuinely
// different songs is the worst failure available here.
const FEAT_SUFFIX = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|w\/)\s+[^)\]]*[)\]]\s*$/i;
const ARTIST_FEAT = /\s+(?:feat\.?|ft\.?|featuring|with|w\/|,|&|\bx\b)\s+/i;

export function baseTitle(track) {
  let out = track || "", prev = null;
  while (out !== prev) { prev = out; out = out.replace(FEAT_SUFFIX, "").trim(); }
  return out;
}

export function d8FeatureCredits(rest) {
  const issues = [];

  const variants = new Map();
  for (const s of rest) {
    const k = `${norm(s.artist)}␟${norm(baseTitle(s.track))}`;
    if (!variants.has(k)) variants.set(k, new Map());
    const m = variants.get(k);
    m.set(s.track, (m.get(s.track) || 0) + 1);
  }
  for (const titles of variants.values()) {
    if (titles.size < 2) continue;
    const order = ranked(titles);
    issues.push({
      detector: "D8", class: "split", confidence: 0.8,
      title: `'${baseTitle(order[0][0])}' scrobbled under ${titles.size} title variants`,
      plays_affected: order.reduce((n, [, v]) => n + v, 0),
      suggest: `standardise on '${order[0][0]}' (${order[0][1]} plays). Check ` +
               `the official credit style before assuming 'feat.': many ` +
               `releases use 'with'.`,
      members: order.map(([track, plays]) => ({ track, plays })),
    });
  }

  // Artist field polluted with a feature. Worse than an album split: it
  // invents a phantom artist that competes with the real one in the chart.
  const counts = counter(rest, (s) => s.artist);
  const primaries = new Set(
    [...counts.keys()].filter((a) => !ARTIST_FEAT.test(a)).map((a) => norm(a)),
  );
  for (const [artist, n] of counts) {
    if (!ARTIST_FEAT.test(artist)) continue;
    const head = artist.split(ARTIST_FEAT)[0].trim();
    if (!primaries.has(norm(head)) || norm(head) === norm(artist)) continue;
    issues.push({
      detector: "D8", class: "error", confidence: 0.9, artist,
      title: `Artist field contains a feature credit: '${artist}'`,
      plays_affected: n,
      suggest: `artist should be '${head}', with the feature moved into the ` +
               `track title. This phantom artist is competing with '${head}' ` +
               `in your artist chart.`,
      members: [{ artist, plays: n }, { artist: head, plays: counts.get(head) || 0 }],
    });
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/* ------------------------------------ D1, D5, D6, D7, D11, D12 */

export function d1ArtistVariants(rest) {
  const plays = counter(rest, (s) => s.artist);
  const tracks = new Map();
  for (const s of rest) {
    if (!tracks.has(s.artist)) tracks.set(s.artist, new Set());
    tracks.get(s.artist).add(norm(s.track));
  }
  const buckets = new Map();
  for (const artist of plays.keys()) {
    const k = norm(artist, { dropThe: true });
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(artist);
  }

  const issues = [], seen = new Set();
  const variantIssue = (names, why, confidence) => {
    const order = [...names].sort((a, b) => plays.get(b) - plays.get(a));
    return {
      detector: "D1", class: "split", confidence,
      title: `Artist variants: ${order.map((n) => `'${n}'`).join(", ")}`,
      plays_affected: order.reduce((n, a) => n + plays.get(a), 0),
      suggest: `consolidate to '${order[0]}' (${plays.get(order[0])} plays). ` +
               `Matched by ${why}.`,
      members: order.map((a) => ({ artist: a, plays: plays.get(a) })),
    };
  };

  for (const names of buckets.values()) {
    if (names.length < 2) continue;
    // Casing-only groups belong to D7, which owns the unfixable bucket.
    if (new Set(names.map((n) => n.toLowerCase())).size === 1) continue;
    issues.push(variantIssue(names, "exact match after normalisation", 0.95));
    seen.add([...names].sort().join("|"));
  }

  // Fuzzy matches are gated on a shared track title: the same artist
  // misspelled will share tracks, two different artists will not. Without the
  // gate this produces confident nonsense.
  const keys = [...buckets.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (Math.abs(keys[i].length - keys[j].length) > 3) continue;
      if (similar(keys[i], keys[j]) < 0.9) continue;
      for (const a of buckets.get(keys[i])) {
        for (const b of buckets.get(keys[j])) {
          const id = [a, b].sort().join("|");
          if (seen.has(id)) continue;
          const shared = [...tracks.get(a)].filter((t) => tracks.get(b).has(t));
          if (!shared.length) continue;
          seen.add(id);
          issues.push(variantIssue([a, b],
            `fuzzy match confirmed by ${shared.length} shared track titles`, 0.75));
        }
      }
    }
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

export function d5MissingAlbum(rest) {
  const blanks = rest.filter((s) => !s.album);
  if (!blanks.length) return [];
  const months = counter(blanks, (s) => monthOf(s.uts));
  const worst = ranked(months).slice(0, 6);
  return [{
    detector: "D5", class: "error", confidence: 0.9,
    title: `${blanks.length.toLocaleString()} scrobbles have no album`,
    plays_affected: blanks.length,
    suggest: `concentrated in ${worst.map(([m, n]) => `${m} (${n})`).join(", ")}. ` +
             `A cluster usually means one misbehaving scrobbler rather than ` +
             `scattered mistakes.`,
    members: ranked(months).slice(0, 24).map(([month, plays]) => ({ month, plays })),
  }];
}

export function d6Duplicates(scrobbles, windowSec = 30) {
  const ordered = [...scrobbles].sort((a, b) => a.uts - b.uts);
  const dupes = [];
  for (let i = 1; i < ordered.length; i++) {
    const p = ordered[i - 1], c = ordered[i];
    if (c.uts - p.uts <= windowSec &&
        norm(c.track) === norm(p.track) && norm(c.artist) === norm(p.artist)) {
      dupes.push(c);
    }
  }
  if (!dupes.length) return [];
  const dupMonths = counter(dupes, (s) => monthOf(s.uts));
  const allMonths = counter(ordered, (s) => monthOf(s.uts));
  const systemic = [...dupMonths.entries()]
    .filter(([m, n]) => (allMonths.get(m) || 0) >= 50 && n / allMonths.get(m) > 0.25)
    .sort((a, b) => b[1] / allMonths.get(b[0]) - a[1] / allMonths.get(a[0]));

  const issues = [{
    detector: "D6", class: "error", confidence: 0.8,
    title: `${dupes.length.toLocaleString()} probable duplicate scrobbles ` +
           `(same track within ${windowSec}s)`,
    plays_affected: dupes.length,
    suggest: "usually two scrobblers running at once.",
    members: ranked(dupMonths).slice(0, 24).map(([month, plays]) => ({ month, plays })),
  }];
  if (systemic.length) {
    issues.push({
      detector: "D6", class: "anomaly", confidence: 0.85,
      title: `Systematic double-scrobbling in ${systemic.length} month(s)`,
      plays_affected: systemic.reduce((n, [, v]) => n + v, 0),
      suggest: `over 25% of scrobbles duplicated in ` +
               systemic.slice(0, 8).map(([m, n]) => `${m} (${n}/${allMonths.get(m)})`).join(", ") +
               `. Two clients were almost certainly active. These months ` +
               `inflate every stat you have.`,
      members: systemic.map(([month, dupesN]) =>
        ({ month, dupes: dupesN, total: allMonths.get(month) })),
    });
  }
  return issues;
}

export function d7Casing(rest) {
  const plays = counter(rest, (s) => s.artist);
  const groups = new Map();
  for (const a of plays.keys()) {
    const k = a.toLowerCase();
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(a);
  }
  return [...groups.values()].filter((v) => v.size > 1).map((v) => {
    const names = [...v].sort();
    return {
      detector: "D7", class: "unfixable", confidence: 0.99,
      title: `Casing-only variants: ${names.map((n) => `'${n}'`).join(", ")}`,
      plays_affected: names.reduce((n, a) => n + plays.get(a), 0),
      suggest: "Last.fm stores names in a way that makes case-only edits " +
               "impossible. Listed so you know it is not worth trying.",
      members: names.map((a) => ({ artist: a, plays: plays.get(a) })),
    };
  });
}

export function d11VariousArtists(rest) {
  const va = rest.filter((s) => ["various artists", "va", "various"].includes(norm(s.artist)));
  if (!va.length) return [];
  return [{
    detector: "D11", class: "error", confidence: 0.9,
    title: `${va.length.toLocaleString()} scrobbles credited to Various Artists`,
    plays_affected: va.length,
    suggest: "the real performing artist is recoverable for most of these. " +
             "They currently pollute your artist chart.",
    members: ranked(counter(va, (s) => s.album)).slice(0, 20)
      .map(([album, plays]) => ({ album, plays })),
  }];
}

export function d12Impossible(scrobbles, now = Math.floor(Date.now() / 1000)) {
  const issues = [];
  const future = scrobbles.filter((s) => s.uts > now + 3600);
  if (future.length) {
    issues.push({
      detector: "D12", class: "anomaly", confidence: 0.99,
      title: `${future.length} scrobbles dated in the future`,
      plays_affected: future.length,
      suggest: "a client clock was wrong or a bulk import was malformed.",
      members: future.slice(0, 20).map((s) => ({ track: s.track, uts: s.uts })),
    });
  }
  const hours = counter(scrobbles, (s) => Math.floor(s.uts / 3600));
  const bursts = [...hours.entries()].filter(([, n]) => n > 60);
  if (bursts.length) {
    issues.push({
      detector: "D12", class: "anomaly", confidence: 0.7,
      title: `${bursts.length} hour(s) contain physically impossible scrobble counts`,
      plays_affected: bursts.reduce((n, [, v]) => n + v, 0),
      suggest: "more than 60 scrobbles in one hour is not listening. Likely a " +
               "bulk import or a stuck client.",
      members: bursts.sort((a, b) => b[1] - a[1]).slice(0, 20).map(([h, plays]) => ({
        month: new Date(h * 3600_000).toISOString().slice(0, 13).replace("T", " ") + ":00",
        plays,
      })),
    });
  }
  return issues;
}

/* -------------------------------------------- impact and hygiene score */

/**
 * What the album chart would look like with splits merged.
 *
 * This is the point of a read-only tool. "You have 47 duplicate names" is a
 * chore list nobody opens twice. "Your real number one is not the one Last.fm
 * shows you" is worth reading.
 */
export function chartImpact(rest, splits, topN = 25) {
  const reported = counter(rest.filter((s) => s.album),
                           (s) => `${s.artist}␟${s.album}`);
  const merged = new Map(reported);
  for (const issue of splits) {
    const members = (issue.members || []).filter((m) => m.album);
    if (members.length < 2) continue;
    const target = issue.temporal?.later || issue.external?.title || members[0].album;
    const sink = `${issue.artist}␟${target}`;
    for (const m of members) {
      const key = `${issue.artist}␟${m.album}`;
      if (key === sink) continue;
      const moved = Math.min(merged.get(key) || 0, m.plays);
      if (!moved) continue;
      merged.set(key, merged.get(key) - moved);
      merged.set(sink, (merged.get(sink) || 0) + moved);
    }
  }
  const before = ranked(reported).slice(0, 200).map(([k]) => k);
  const after = ranked(merged).slice(0, 200).map(([k]) => k);
  const posB = new Map(before.map((k, i) => [k, i + 1]));
  const posA = new Map(after.map((k, i) => [k, i + 1]));

  const movers = [];
  for (const k of new Set([...before.slice(0, 120), ...after.slice(0, 120)])) {
    const b = posB.get(k), a = posA.get(k);
    if (b && a && b !== a) {
      movers.push({ album: k, from: b, to: a, delta: b - a,
                    plays_before: reported.get(k), plays_after: merged.get(k) });
    }
  }
  movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return {
    reported_top: before.slice(0, topN).map((k) => ({ album: k, plays: reported.get(k) })),
    corrected_top: after.slice(0, topN).map((k) => ({ album: k, plays: merged.get(k) })),
    biggest_movers: movers.slice(0, 20),
    number_one_changes: Boolean(before.length && after.length && before[0] !== after[0]),
  };
}

export function hygieneScore(totalPlays, issues) {
  if (!totalPlays) return { score: 100, subscores: {} };
  const affected = (...dets) => issues
    .filter((i) => dets.includes(i.detector) && i.class !== "unfixable")
    .reduce((n, i) => n + (i.plays_affected || 0), 0);

  const parts = {
    album_integrity: affected("D0", "D4", "D5"),
    artist_integrity: affected("D1", "D3", "D8", "D11"),
    duplicate_rate: affected("D6", "D12"),
    era_consistency: affected("D14a", "D14c"),
  };
  const subscores = {};
  for (const [k, n] of Object.entries(parts)) {
    // A play can be counted by several detectors, so share can exceed 1. The
    // 2.0 multiplier decides how alarmist the score is; it is a tuning knob,
    // not a truth.
    subscores[k] = Math.max(0, Math.round(100 * (1 - Math.min((n / totalPlays) * 2.0, 1))));
  }
  const score = Math.round(
    Object.values(subscores).reduce((a, b) => a + b, 0) / Object.keys(subscores).length,
  );
  return { score, subscores, plays_affected: parts, total_plays: totalPlays };
}

/* --------------------------------------------------------- orchestration */

export function analyse(scrobbles) {
  const total = scrobbles.length;
  const { era, rest } = partitionEra(scrobbles);   // guard first, always

  const splits = d4AlbumSplits(rest);
  const issues = [
    ...d14aFormatVariants(era),
    ...d14cTrackInTwoEras(era),
    ...splits,
    ...d8FeatureCredits(rest),
    ...d1ArtistVariants(rest),
    ...d5MissingAlbum(rest),
    ...d6Duplicates(scrobbles),
    ...d7Casing(rest),
    ...d11VariousArtists(rest),
    ...d12Impossible(scrobbles),
  ];
  // D2 (canonical-name divergence) is intentionally absent. It would compare
  // stored names against Last.fm's canonical forms and call the difference an
  // error, which is backwards for anyone with autocorrect off.

  issues.sort((a, b) => (b.plays_affected || 0) - (a.plays_affected || 0));

  const byDetector = {};
  for (const i of issues) {
    byDetector[i.detector] ??= { count: 0, plays_affected: 0 };
    byDetector[i.detector].count++;
    byDetector[i.detector].plays_affected += i.plays_affected || 0;
  }

  return {
    generated: Math.floor(Date.now() / 1000),
    profile: {
      scrobbles_ingested: total,
      distinct_artists: new Set(scrobbles.map((s) => s.artist)).size,
      distinct_albums: new Set(scrobbles.filter((s) => s.album)
        .map((s) => `${s.artist}␟${s.album}`)).size,
      distinct_tracks: new Set(scrobbles.map((s) => `${s.artist}␟${s.track}`)).size,
    },
    hygiene: hygieneScore(total, issues),
    era: d14Overview(era, total),
    impact: chartImpact(rest, splits),
    summary_by_detector: byDetector,
    issues,
    issues_total: issues.length,
  };
}
