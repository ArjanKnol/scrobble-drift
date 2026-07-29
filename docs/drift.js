/**
 * Scrobble Drift detectors. The single implementation.
 *
 * Pure functions over an array of scrobbles:
 *
 *   {uts, artist, artist_mbid, album, album_mbid, track, track_mbid}
 *
 * No I/O, no DOM, no network. Everything that needs the network (pacing, retry,
 * caching, progress) lives in the caller, which is what makes every rule in here
 * testable offline and is why scripts/test-*.mjs need no fixtures or API keys.
 *
 * This file was once a port of a parallel Python implementation, and the two
 * drifted within days: a fix landed in one and not the other. The Python copy is
 * gone. If a second consumer ever appears, it imports this file rather than
 * reimplementing it.
 */

/* ------------------------------------------------------------ normalising */

const APOSTROPHES = /[‘’ʼ`´]/g;

/**
 * Loose key, for deciding whether two names might be the SAME THING spelled
 * differently. Strips diacritics, so "Jaÿ-Z" and "Jay-Z" match.
 *
 * Do not use this to establish identity. See normTitle().
 */
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
 * Strict key, for deciding whether two titles are the SAME TRACK.
 *
 * Identical to norm() except that diacritics are PRESERVED, because artists use
 * them deliberately. Yeat has both "Back Home" and "Back Homë"; they are
 * different songs. Folding accents away merged them and produced a confident
 * recommendation to consolidate two unrelated tracks.
 *
 * The lesson generalises: normalisation for fuzzy matching should be
 * aggressive, normalisation for identity must be conservative. Using one
 * function for both was the bug.
 *
 * NFC rather than NFKD so that a precomposed "ë" (U+00EB) and a decomposed
 * "e" + combining diaeresis compare equal, without discarding the mark.
 */
export function normTitle(text) {
  if (!text) return "";
  return text.normalize("NFC").replace(APOSTROPHES, "'")
    .replace(/[^\p{L}\p{N}\p{M}\s']/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ").trim();
}

/**
 * Identity key for a TRACK TITLE. Preserves symbols.
 *
 * normTitle() replaces every symbol with a space, which is right for fuzzy
 * matching and wrong for identity. Measured collisions in a real library:
 *
 *   '@ MEH'        vs 'Meh'          -> both "meh"
 *   '$ELF TITLED'  vs 'ELF TITLED'   -> both "elf titled"
 *
 * Playboi Carti has both 'Meh' and '@ MEH'; they are different tracks. Merging
 * them produced a confident "split across 2 album strings" for two songs that
 * were never the same song. This is the same lesson as the diacritics in
 * normTitle(): identity normalisation must be conservative, and using one
 * function for both jobs is the bug.
 *
 * Spacing AROUND a symbol is still normalised, so '@ MEH' and '@MEH' agree.
 * That is a formatting difference; the presence of the '@' is not.
 */
export function trackIdentity(text) {
  if (!text) return "";
  return text.normalize("NFC").replace(APOSTROPHES, "'")
    .toLowerCase()
    .replace(/\s+/g, " ").trim()
    .replace(/\s*([^\p{L}\p{N}\p{M}\s'])\s*/gu, "$1");
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

/**
 * Levenshtein distance, abandoned early once it exceeds `max`.
 *
 * Needed because the similarity ratio alone cannot catch a single-character
 * typo in a short name: 2M/(n+m) for "yeat" vs "teat" is 0.75, well under the
 * 0.9 threshold. Measured behaviour of a one-character typo by name length:
 *
 *   "Sef" / "Sez"                  0.667  missed
 *   "Yeat" / "Teat"                0.750  missed
 *   "Woop" / "Wopp"                0.750  missed
 *   "Gunna" / "Gunnna"             0.909  caught
 *   "Playboi Carti" / "...Cartii"  0.963  caught
 *
 * So the ratio only works for names of roughly ten characters or more. Short
 * artist names are common, and a whole class of real typos was invisible.
 */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                    // deletion
        cur[j - 1] + 1,                                 // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),   // substitution
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;                   // cannot recover
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Do two names differ ONLY by capitalisation?
 *
 * Deliberately narrow. NFC-normalise (so a precomposed 'Ÿ' and a decomposed
 * 'Y' + combining diaeresis compare equal) then lowercase, and compare nothing
 * else. Using a looser normaliser here would be a bug: norm() strips
 * punctuation, so it would call 'Jaÿ-Z' and 'Jaÿ Z' casing-only when the
 * hyphen-to-space change is something the user CAN make.
 *
 *   'Jaÿ-Z' vs 'JAŸ-Z'   -> true,  unfixable, never reported
 *   'Jaÿ-Z' vs 'Jaÿ Z'   -> false, fixable
 *   'Jaÿ-Z' vs 'JAY Z'   -> false, fixable
 */
export const caseOnly = (a, b) =>
  String(a ?? "").normalize("NFC").toLowerCase() ===
  String(b ?? "").normalize("NFC").toLowerCase();

/** Typo budget scaled to name length. One char for short names, two for long. */
const typoBudget = (a, b) =>
  Math.max(1, Math.floor(Math.max(a.length, b.length) / 10));

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

/**
 * Unreleased-material conventions in the wild.
 *
 * There is no standard. Observed forms, all of which mean the same thing:
 *
 *   Unreleased (Rodeo Era)        the common one
 *   Unreleased [Rodeo Era]        same, square brackets
 *   Unreleased (Rodeo Sessions)   "sessions" instead of "era"
 *   Rodeo Sessions                no "unreleased" marker at all
 *   Unreleased (Rodeo)            bare parenthetical
 *   Unreleased                    one bucket per artist, no era at all
 *
 * The earlier version recognised only the first. That was not merely narrow: it
 * broke silently in the worst possible way. "Unreleased (Rodeo Sessions)" was
 * classified as era-tagged by the UNRELEASED marker but yielded NO era name, so
 * it landed in the protected partition and then vanished from every era
 * consistency check. Tagged, protected, and invisible.
 */

/*
 * Markers come in two strengths, because some of these words are also real
 * album titles.
 *
 * STRONG markers are leak-culture vocabulary that essentially never titles a
 * commercial release: "unreleased", "CDQ", "OG file", "reference track".
 *
 * WEAK markers are ordinary collection nouns. Lil Baby's "The Leaks" is an
 * officially released project; so are albums called "Outtakes" and "Demos".
 * Treating those as unreleased material does more than mislabel them: the era
 * guard PROTECTS whatever it matches, excluding it from D0, D4 and D1. So a real
 * album silently stopped being checked for splits, which is a lost finding with
 * no error message anywhere.
 *
 * This is the same shape as the "Sessions" problem and gets the same answer: a
 * weak marker only counts when the SAME ARTIST is strongly marked somewhere else
 * in the library, which turns the convention into evidence instead of a guess.
 */
const UNREL_STRONG =
  /\bunreleased\b|\bunrelased\b|\bOG\s*file(?:s)?\b|\bref(?:erence)?\s*track(?:s)?\b|\bCDQ\b/i;

// Pluralised deliberately: the old \bsnippet\b failed on the bare "Snippets"
// that people actually use, because the trailing s ate the word boundary.
const UNREL_WEAK =
  /\bleak(?:s|ed)?\b|\bsnippet(?:s)?\b|\bouttake(?:s)?\b|\bleftover(?:s)?\b/i;

// Kept for eraName(), which needs to strip any marker before reading the
// qualifier, regardless of strength.
const UNREL_MARK = new RegExp(
  `${UNREL_STRONG.source}|${UNREL_WEAK.source}`, "i");

// "(Rodeo Era)", "[Rodeo Sessions]" -> Rodeo
const BRACKETED_QUAL =
  /[([]\s*([^)\]]*?)\s*\b(?:era|sessions?|sesh)\b\s*[)\]]/i;
// Trailing "Rodeo Era" / "Rodeo Sessions" with no brackets at all.
const BARE_QUAL = /^\s*(.+?)\s+\b(?:era|sessions?|sesh)\b\s*$/i;
// "Unreleased (Rodeo)" -> Rodeo. Only consulted after an unreleased marker.
const BARE_BRACKET = /[([]\s*([^)\]]+?)\s*[)\]]/;

/** Album strings that are unambiguously unreleased material on their own. */
const explicitEra = (album) =>
  Boolean(album) && (UNREL_STRONG.test(album) || BRACKETED_QUAL.test(album));

/**
 * A weak marker with nothing else to back it up.
 *
 * 'The Leaks', 'Outtakes', 'Snippets' on their own. Real albums carry these
 * titles, so they need corroboration from the same artist before being treated
 * as leak material. 'Unreleased Leaks' is not in here: the strong marker
 * settles it.
 */
const weakEra = (album) =>
  Boolean(album) && !explicitEra(album) && UNREL_WEAK.test(album);

/**
 * Ambiguous forms: a bare "Rodeo Sessions" with no unreleased marker.
 *
 * Kept separate because "Sessions" is also a real album word. Abbey Road
 * Sessions and Spotify Sessions are commercial releases, and classifying them as
 * unreleased would quietly exclude them from split detection. So these only
 * count when the SAME ARTIST is tagged explicitly elsewhere in the library,
 * which is what makes the convention evidence rather than a guess.
 */
const ambiguousEra = (album) =>
  Boolean(album) && !explicitEra(album) && BARE_QUAL.test(album);

/**
 * Context-free "does this look like unreleased material".
 *
 * Includes the weak and ambiguous forms, so it answers the question a human
 * would. partitionEra() is the one that decides, and it requires corroboration
 * for anything that is not explicit.
 */
export const isEraTagged = (album) =>
  explicitEra(album) || weakEra(album) || ambiguousEra(album);

/**
 * The era name, or null when the string is a single undifferentiated bucket.
 *
 * Returning null is meaningful, not a failure: "Unreleased" with no qualifier is
 * a deliberate convention, and D14f reports it as such rather than as an error.
 */
export const eraName = (album) => {
  if (!album) return null;

  // Bracketed qualifier wins: it is the most explicit form.
  let m = BRACKETED_QUAL.exec(album);
  if (m?.[1]?.trim()) return m[1].trim();

  // Bare trailing qualifier, e.g. "Rodeo Sessions". Strip any unreleased marker
  // first so "Unreleased Rodeo Sessions" yields Rodeo rather than the lot.
  const stripped = album.replace(UNREL_MARK, " ").replace(/\s+/g, " ").trim();
  m = BARE_QUAL.exec(stripped);
  if (m?.[1]?.trim()) return m[1].trim();

  // Bare parenthetical after an unreleased marker: "Unreleased (Rodeo)".
  if (UNREL_MARK.test(album)) {
    m = BARE_BRACKET.exec(album);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
};

/** True for a bucket with no era distinction at all, e.g. bare "Unreleased". */
export const isUndifferentiated = (album) =>
  (explicitEra(album) || weakEra(album)) && !eraName(album);

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
export function partitionEra(scrobbles, { official } = {}) {
  /*
   * `official` is an optional Set of album strings VERIFIED to be real releases,
   * keyed `norm(artist)␟norm(album)`. Built by the caller from Spotify or
   * MusicBrainz before analysis; see weakEraCandidates().
   *
   * This beats the corroboration heuristic outright, and it fixes a case the
   * heuristic cannot: Lil Baby's "The Leaks" is an officially released project,
   * but he ALSO tags leaks with explicit era names, so corroboration alone still
   * swallowed the real album. Asking whether the release exists is a fact;
   * "does this artist tag leaks elsewhere" is only a correlation.
   *
   * Applied to weak and ambiguous markers only. A strong marker stays strong
   * even if some artist happens to have released a record called "Unreleased",
   * because un-protecting a genuine leak bucket is the more damaging error.
   */
  const isOfficial = official instanceof Set
    ? (artist, album) => official.has(`${norm(artist)}␟${norm(album)}`)
    : () => false;

  // Pass 1: which artists tag unreleased material explicitly? Only for those is
  // a bare "Rodeo Sessions" evidence of the convention rather than a guess about
  // a real album. Without this, Abbey Road Sessions gets protected and silently
  // dropped from split detection for everybody.
  const taggers = new Set();
  for (const s of scrobbles) {
    if (explicitEra(s.album)) taggers.add(norm(s.artist));
  }

  const era = [], rest = [];
  for (const s of scrobbles) {
    let isEra;
    if (explicitEra(s.album)) {
      isEra = true;
    } else if (weakEra(s.album) || ambiguousEra(s.album)) {
      // Verified real release wins; otherwise fall back to corroboration.
      isEra = !isOfficial(s.artist, s.album) && taggers.has(norm(s.artist));
    } else {
      isEra = false;
    }
    (isEra ? era : rest).push(s);
  }
  return { era, rest };
}

/**
 * Album strings whose classification would benefit from a release lookup.
 *
 * Only the weak and ambiguous ones: 'The Leaks', 'Outtakes', 'Rodeo Sessions'.
 * Strong markers need no help and normal albums are not in question, so this
 * list is short, usually a handful per library. Sorted busiest first so a capped
 * budget is spent where it changes the most plays.
 */
export function weakEraCandidates(scrobbles, { limit = 40 } = {}) {
  const seen = new Map();
  for (const s of scrobbles) {
    if (!s.album) continue;
    if (explicitEra(s.album)) continue;
    if (!weakEra(s.album) && !ambiguousEra(s.album)) continue;
    const k = `${norm(s.artist)}␟${norm(s.album)}`;
    const rec = seen.get(k) || { artist: s.artist, album: s.album, plays: 0 };
    rec.plays++;
    seen.set(k, rec);
  }
  return [...seen.values()].sort((a, b) => b.plays - a.plays).slice(0, limit);
}

/** Key an artist/album pair for the `official` set. */
export const officialKey = (artist, album) =>
  `${norm(artist)}␟${norm(album)}`;

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
      // Keep the ALBUM STRINGS behind each era name, not just a play count.
      // The extracted name is what the comparison needs, but it is not what the
      // user has in their library: reporting 'Eternal Atake OG' when the library
      // says 'Unreleased (Eternal Atake OG Era)' means they have to work out
      // which entry is being talked about before they can act on it.
      const rec = e.get(name) || { plays: 0, albums: new Map() };
      rec.plays++;
      rec.albums.set(s.album, (rec.albums.get(s.album) || 0) + 1);
      e.set(name, rec);
    }
  }


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
      // Casing-only differences are skipped entirely. Last.fm cannot change the
      // casing of a name, so there is nothing to act on, and a report padded
      // with impossible work is worse than a shorter honest one. Same reason
      // D7 is not run.
      if (new Set(group.map((g) => g.toLowerCase())).size === 1) continue;
      issues.push({
        detector: "D14a",
        class: "split",
        confidence: 0.95,
        artist,
        title: `Era tag written ${group.length} ways for ${artist}: ` +
               order.map((g) => `'${g}'`).join(", "),
        plays_affected: group.reduce((n, g) => n + strings.get(g), 0),
        suggest: `standardise on '${order[0]}' (${strings.get(order[0])} plays).`,
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
    const playsOf = (n) => counts.get(n).plays;
    // The album string the user actually has for this era. Most-played when an
    // era is spelled several ways, e.g. both "(Rodeo Era)" and "Rodeo Sessions".
    const albumOf = (n) => ranked(counts.get(n).albums)[0][0];
    const albumsOf = (n) => ranked(counts.get(n).albums);

    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        if (norm(a) === norm(b) || similar(norm(a), norm(b)) < 0.82) continue;
        const [lo, hi] = playsOf(a) <= playsOf(b) ? [a, b] : [b, a];
        if (playsOf(lo) > Math.max(2, 0.25 * playsOf(hi))) continue;
        const sequel = differsOnlyByVersion(lo, hi);
        const loAlbum = albumOf(lo), hiAlbum = albumOf(hi);
        issues.push({
          detector: "D14a",
          // Sequel-vs-typo cannot be decided from play counts. Marked here so
          // the MusicBrainz phase can settle it with evidence: if both era
          // names exist as real release groups they are separate projects and
          // this is dropped entirely. See verifyEraNames().
          // a/b stay as ERA NAMES because that is what MusicBrainz is asked
          // about. The album strings ride along so verifyEraNames can name what
          // the user actually has when it rewrites these messages.
          verify: sequel
            ? { artist, a: lo, b: hi, aAlbum: loAlbum, bAlbum: hiAlbum }
            : undefined,
          // A trailing number or version token means these are very likely
          // distinct projects, not a misspelling: 'Drip Season' and 'Drip
          // Season 3' are two different Gunna tapes. Play count asymmetry
          // cannot separate that from a typo, so downgrade to review rather
          // than assert an error.
          class: sequel ? "review" : "error",
          confidence: sequel ? 0.35 : 0.7,
          artist,
          title: sequel
            ? `Similar era names for ${artist}: '${loAlbum}' vs '${hiAlbum}'`
            : `Probable era-name typo for ${artist}: '${loAlbum}' vs ` +
              `'${hiAlbum}'`,
          plays_affected: playsOf(lo) + playsOf(hi),
          suggest: sequel
            ? `these differ only by a version or sequel marker, so they are ` +
              `probably separate projects rather than a typo. Checking ` +
              `MusicBrainz to confirm. '${hiAlbum}' has ${playsOf(hi)} plays, ` +
              `'${loAlbum}' has ${playsOf(lo)}.`
            : `'${hiAlbum}' has ${playsOf(hi)} plays against ` +
              `${playsOf(lo)}, so '${loAlbum}' is likely the typo.`,
          // Album strings, so the report names what is in the library and the
          // UI can deep-link straight to those album pages. The era name is
          // carried too, for the cases where one era has several spellings.
          members: [lo, hi].flatMap((n) =>
            albumsOf(n).map(([album, plays]) => ({ album, era: n, plays }))),
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

/**
 * One track title filed under several eras.
 *
 * NOT an error. An earlier version of this claimed "one of these eras is
 * wrong", which is simply false: songs routinely survive across album eras.
 * They get recorded for one project, held back, reworked, and considered again
 * for a later one. Kanye tracks in particular move between projects constantly,
 * so a title appearing under both BULLY and Cuck is entirely legitimate.
 *
 * What IS worth surfacing is that the two entries are indistinguishable in your
 * own data. If they are different versions, the track titles could say so; if
 * they are the same file, one era tag is redundant. Both are the listener's
 * call, so this is reported as review and never as an error.
 */
export function d14cTrackInTwoEras(era) {
  const where = new Map();
  for (const s of era) {
    const name = eraName(s.album);
    if (!name) continue;
    const k = `${s.artist}␟${normTitle(s.track)}`;
    if (!where.has(k)) where.set(k, { artist: s.artist, track: s.track, eras: new Map() });
    const e = where.get(k).eras;
    e.set(name, (e.get(name) || 0) + 1);
  }
  const issues = [];
  for (const { artist, track, eras } of where.values()) {
    if (eras.size < 2) continue;
    // A version marker makes a carried-over song even more likely, so it is
    // reported with lower confidence still.
    const versioned = [...eras.keys()].some((e) => /\bv\d+\b/i.test(e));
    issues.push({
      detector: "D14c",
      class: "review",
      confidence: versioned ? 0.3 : 0.45,
      artist,
      title: `${artist} - '${track}' is filed under ${eras.size} eras: ` +
             [...eras.keys()].sort().join(", "),
      plays_affected: [...eras.values()].reduce((a, b) => a + b, 0),
      suggest:
        "Often legitimate: songs get held back and reworked across projects, " +
        "so the same title can genuinely belong to more than one era" +
        (versioned ? ", and a version marker here makes that likelier" : "") +
        ". Nothing to fix if that is the case. If these are different " +
        "versions, consider putting that in the track title so the two are " +
        "distinguishable. If they are the same file, one era tag is redundant.",
      members: ranked(eras).map(([era_, plays]) => ({ era: era_, plays })),
    });
  }
  return issues;
}

/**
 * D14f: one undifferentiated bucket holding an artist's whole unreleased output.
 *
 * A large number of people file everything under a bare "Unreleased" per artist
 * rather than splitting by era. That is a legitimate convention, not a mistake,
 * and this is the difference between a tool that respects its users and one that
 * lectures them. So:
 *
 *   - class is `review`, never error
 *   - `style_choice` is set, which keeps it out of the score's actionable count.
 *     A deliberate convention must not cap someone's score at 99 forever.
 *   - the wording offers an option and states the benefit, rather than implying
 *     the current state is wrong
 *
 * The threshold exists because the suggestion is only useful at scale. Splitting
 * three tracks by era gains nothing; splitting sixty makes the collection
 * navigable and makes the "released since" check far more informative.
 */
export function d14fSingleBucket(era, { minTracks = 8 } = {}) {
  const buckets = new Map();
  for (const s of era) {
    if (!isUndifferentiated(s.album)) continue;
    const k = `${norm(s.artist)}␟${norm(s.album)}`;
    if (!buckets.has(k)) {
      buckets.set(k, { artist: s.artist, album: s.album, plays: 0, tracks: new Set() });
    }
    const b = buckets.get(k);
    b.plays++;
    b.tracks.add(normTitle(s.track));
  }

  const issues = [];
  for (const b of [...buckets.values()].sort((x, y) => y.plays - x.plays)) {
    if (b.tracks.size < minTracks) continue;
    issues.push({
      detector: "D14f",
      class: "review",
      confidence: 0.3,
      style_choice: true,
      artist: b.artist,
      album: b.album,
      title: `${b.artist} - ${b.tracks.size} unreleased tracks in one ` +
             `'${b.album}' bucket`,
      plays_affected: b.plays,
      suggest:
        `All of it sits under a single album string, so there is no way to see ` +
        `which project each track came from. This is a common and perfectly ` +
        `valid way to tag, so nothing here is wrong. If you ever want the ` +
        `detail, naming the period, e.g. '${b.album} (Rodeo Era)' or ` +
        `'${b.album} (Rodeo Sessions)', would let Scrobble Drift group them by ` +
        `project and tell you which ones have since been officially released.`,
      members: [{ album: b.album, plays: b.plays }],
      no_auto_action: true,
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
  if (normTitle(album) === normTitle(track)) return "single (album titled after the track)";
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
/**
 * Track titles that recur across an artist's albums by design.
 *
 * "Intro" on one album and "Intro" on another are two different recordings, not
 * one track split in two. Grouping on artist plus title cannot tell them apart,
 * so these are handled separately rather than reported as splits.
 */
const STRUCTURAL_TITLE =
  /^(intro|outro|interlude|skit|prelude|epilogue|intermission|reprise|untitled|hidden track|bonus track|instrumental)\s*\d*$/i;

export const isStructuralTitle = (track) => STRUCTURAL_TITLE.test(normTitle(track));

/**
 * Could the earlier album string plausibly be a pre-album release of this
 * track, rather than simply a different album that happens to share a title?
 *
 * Needed because a clean chronological handover is not by itself evidence of a
 * single being absorbed into an album. Two unrelated albums played in sequence
 * produce the same shape. J. Cole's "Intro" on Cole World and on the 2014
 * Forest Hills Drive anniversary edition looked like a textbook migration and
 * is nothing of the kind.
 */
function plausiblePreRelease(earlier, later, track) {
  const e = normTitle(earlier), l = normTitle(later), t = normTitle(track);
  if (!e || !l) return false;
  if (e === t || e.includes(t)) return true;              // single named for the track
  if (/\s[-–]\s(single|ep)$/i.test(earlier)) return true; // explicitly a single or EP
  if (e.includes(l) || l.includes(e)) return true;        // edition of the same album
  return similar(norm(earlier), norm(later)) >= 0.6;      // near-identical titles
}

function temporalSignature(members, track) {
  if (members.length !== 2) return null;
  const [a, b] = [...members].sort((x, y) => x.first - y.first);
  if (a.last > b.first) return null;

  const migration = plausiblePreRelease(a.album, b.album, track);
  return {
    pattern: migration ? "clean_handover" : "sequential_unrelated",
    migration,
    earlier: a.album, later: b.album, boundary: b.first,
    note: migration
      ? `every play of '${a.album}' predates every play of '${b.album}'. ` +
        `Classic single-absorbed-into-album migration around ${monthName(b.first)}.`
      // Same chronology, no causal claim: these look like two different
      // releases rather than one becoming the other.
      : `every play of '${a.album}' predates every play of '${b.album}' ` +
        `(${monthName(b.first)}), but the two look like different releases ` +
        `rather than one absorbing the other.`,
  };
}

export function d4AlbumSplits(rest, minPlays = 2) {
  const groups = new Map();
  for (const s of rest) {
    // trackIdentity, not normTitle: this key decides whether two scrobbles are
    // THE SAME TRACK, and normTitle deletes symbols, which merged Carti's 'Meh'
    // with his '@ MEH'.
    const k = `${norm(s.artist)}␟${trackIdentity(s.track)}`;
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
    const structural = isStructuralTitle(g.track);
    const temporal = temporalSignature(members, g.track);
    const migration = Boolean(temporal?.migration);

    issues.push({
      detector: "D4",
      // A structural title almost certainly means several distinct tracks, so
      // it is a question rather than a finding.
      class: structural ? "review" : "split",
      confidence: structural ? 0.25 : (migration ? 0.9 : 0.7),
      artist: g.artist, track: g.track,
      title: structural
        ? `${g.artist} - '${g.track}' appears on ${g.albums.size} albums`
        : `${g.artist} - '${g.track}' split across ${g.albums.size} album strings`,
      plays_affected: total,
      suggest: structural
        ? `'${g.track}' is a structural track title, so these are almost ` +
          `certainly different recordings, one per album, rather than one ` +
          `track split in two. Nothing to fix unless you know otherwise.`
        : migration
        ? `consolidate to '${temporal.later}': the earlier string looks like ` +
          `the pre-album release.`
        : `candidate for consolidation, but the two album strings do not look ` +
          `like editions of one release. Enable MusicBrainz resolution to ` +
          `confirm before merging anything.`,
      members,
      // The temporal note is suppressed for structural titles: the chronology
      // is real but says nothing useful about two different albums.
      temporal: structural ? undefined : temporal,
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

/**
 * The featured artists named in a title's trailing credit clause.
 *
 * `Roll in Peace (feat. XXXTENTACION)` -> {"xxxtentacion"}
 * `Knife Talk (with 21 Savage & Project Pat)` -> {"21 savage", "project pat"}
 * `Roll in Peace` -> {} (empty, meaning no credit stated)
 *
 * Looped, because a title can carry more than one clause.
 */
export function featCredits(title) {
  const names = new Set();
  let out = title || "", prev = null;
  while (out !== prev) {
    prev = out;
    const m = FEAT_SUFFIX.exec(out);
    if (!m) break;
    const inner = m[0]
      .replace(/^[\s([]*/, "").replace(/[)\]\s]*$/, "")
      .replace(/^(?:feat\.?|ft\.?|featuring|with|w\/)\s+/i, "");
    for (const n of inner.split(/\s*(?:,|&|\+|\band\b|\bx\b)\s*/i)) {
      const k = norm(n);
      if (k) names.add(k);
    }
    out = out.replace(FEAT_SUFFIX, "").trim();
  }
  return names;
}

const isSubset = (a, b) => [...a].every((x) => b.has(x));

/**
 * Could two credit line-ups describe the SAME recording?
 *
 * Yes when one states no credit at all (the bare title), or when one line-up is
 * a subset of the other, which is the credit-completeness case: `(feat. Drake)`
 * and `(feat. Drake & Future)` are plausibly the same song tagged with varying
 * thoroughness.
 *
 * No when the line-ups are disjoint. `(feat. XXXTENTACION)` and
 * `(feat. Travis Scott)` are two different recordings of a song, and merging
 * them would destroy a real distinction rather than fix a spelling.
 */
const creditsCompatible = (a, b) =>
  !a.size || !b.size || isSubset(a, b) || isSubset(b, a);

export function d8FeatureCredits(rest) {
  const issues = [];

  const variants = new Map();
  for (const s of rest) {
    const k = `${norm(s.artist)}␟${trackIdentity(baseTitle(s.track))}`;
    if (!variants.has(k)) variants.set(k, { artist: s.artist, titles: new Map() });
    const v = variants.get(k);
    v.titles.set(s.track, (v.titles.get(s.track) || 0) + 1);
  }
  for (const { artist, titles } of variants.values()) {
    if (titles.size < 2) continue;

    /*
     * Guard against merging genuinely different recordings.
     *
     * baseTitle() strips the whole credit clause, so
     * 'Roll in Peace (feat. XXXTENTACION)' and
     * 'Roll In Peace (feat. Travis Scott)' both reduce to 'roll in peace' and
     * landed in one group. The tool then advised standardising on the more
     * played one, which would have merged two different songs.
     *
     * D8's real premise is narrower than "same base title": it is the same
     * RECORDING scrobbled with and without its credit. So when the credits name
     * different artists, this is not a spelling variant and there is nothing to
     * fix.
     *
     * Conservative on purpose. With two conflicting line-ups present, a bare
     * title cannot be attributed to either, so the whole group is dropped
     * rather than guessing. That loses a real finding when someone has a bare
     * title AND two different features, which is rare, and the alternative is a
     * confident recommendation to merge two distinct tracks.
     */
    const order = ranked(titles);
    const credits = order.map(([t]) => featCredits(t));
    let conflict = false;
    for (let i = 0; i < credits.length && !conflict; i++) {
      for (let j = i + 1; j < credits.length; j++) {
        if (!creditsCompatible(credits[i], credits[j])) { conflict = true; break; }
      }
    }

    if (conflict) {
      /*
       * Conflicting line-ups. Almost always genuinely different recordings, so
       * this must NEVER recommend a merge.
       *
       * It is still worth mentioning, at the lowest confidence the report has,
       * for the one case where it is a real finding: a bare title sitting
       * alongside two different features, where some of those bare plays
       * probably belong to one of them and there is no way to tell which. That
       * is unresolvable from the data, so the finding describes the situation
       * and explicitly says not to merge.
       *
       * Silence would be defensible too, but it hides a genuine ambiguity the
       * user is better placed to resolve than the tool is: they can listen.
       */
      const bare = order.filter(([, ], i) => credits[i].size === 0);
      if (!bare.length) continue;      // only distinct features, nothing to say

      const lineups = order
        .filter((_, i) => credits[i].size > 0)
        .map(([t]) => t);
      issues.push({
        detector: "D8",
        class: "review",
        confidence: 0.2,
        no_auto_action: true,
        artist,
        track: order[0][0],
        title: `${artist} - '${baseTitle(order[0][0])}' exists as ` +
               `${lineups.length} different features, plus ` +
               `${bare.length === 1 ? "an untagged version" : "untagged versions"}`,
        plays_affected: bare.reduce((n, [, v]) => n + v, 0),
        suggest:
          `Do NOT merge these: ${lineups.map((t) => `'${t}'`).join(" and ")} ` +
          `credit different artists, so they are different recordings. The ` +
          `only open question is which of them ` +
          `${bare.map(([t, v]) => `'${t}' (${v} play${v === 1 ? "" : "s"})`)
              .join(" and ")} belongs to. Your data cannot say, so this is ` +
          `here for information only. Listening is the only way to tell.`,
        members: order.map(([track, plays], i) => ({
          track, plays,
          looks_like: credits[i].size
            ? `feat. ${[...credits[i]].join(", ")}` : "no credit stated",
        })),
      });
      continue;
    }

    issues.push({
      detector: "D8", class: "split", confidence: 0.8,
      // The artist is carried AND named in the title. Without it the report
      // said things like "'Make It Work' scrobbled under 2 title variants",
      // which does not identify whose track it is, and left the issue with no
      // artist for the library deep links to use.
      artist,
      track: order[0][0],
      title: `${artist} - '${baseTitle(order[0][0])}' scrobbled under ` +
             `${titles.size} title variants`,
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
    tracks.get(s.artist).add(normTitle(s.track));
  }
  const buckets = new Map();
  for (const artist of plays.keys()) {
    const k = norm(artist, { dropThe: true });
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(artist);
  }

  const issues = [], seen = new Set();

  /**
   * Build a variant finding, dropping members that differ from the target by
   * capitalisation alone.
   *
   * Last.fm cannot change just the casing of a name, so those are unactionable
   * and are deliberately never reported. The group-level skip below catches
   * groups where EVERY name is casing-equal, but it does nothing for a MIXED
   * group, and mixed is the common case:
   *
   *   'Jaÿ-Z' (142)   the correct spelling
   *   'JAŸ-Z'  (99)   casing-only, impossible to fix
   *   'JAY Z'   (4)   missing diaeresis and hyphen, genuinely fixable
   *
   * That reported "245 plays" and implied all three could be merged, when only
   * 4 plays were actionable. Listing work nobody can do next to work they can
   * makes the whole finding untrustworthy.
   *
   * Returns null when nothing actionable survives, so the caller drops it.
   */
  const variantIssue = (names, why, confidence) => {
    const order = [...names].sort((a, b) => plays.get(b) - plays.get(a));
    const target = order[0];
    const keep = order.filter((n) => n === target || !caseOnly(n, target));
    if (keep.length < 2) return null;

    const moving = keep.slice(1).reduce((n, a) => n + plays.get(a), 0);
    return {
      detector: "D1", class: "split", confidence,
      title: `Artist variants: ${keep.map((n) => `'${n}'`).join(", ")}`,
      // Only the reported members. Counting the dropped casing variants here
      // would inflate both the headline number and the hygiene score penalty
      // with plays that cannot be moved.
      plays_affected: keep.reduce((n, a) => n + plays.get(a), 0),
      suggest:
        `rename ${keep.slice(1).map((n) => `'${n}'`).join(" and ")} to ` +
        `'${target}', which moves ${moving} play${moving === 1 ? "" : "s"}. ` +
        `Matched by ${why}.`,
      members: keep.map((a) => ({ artist: a, plays: plays.get(a) })),
    };
  };

  for (const names of buckets.values()) {
    if (names.length < 2) continue;
    // Fast path for groups where EVERY name is casing-equal. variantIssue would
    // return null for these anyway; this just skips the work and documents it.
    if (new Set(names.map((n) => n.toLowerCase())).size === 1) continue;
    const issue = variantIssue(names, "exact match after normalisation", 0.95);
    if (issue) issues.push(issue);
    // Marked seen either way, so a dropped casing-only pair is not re-proposed
    // by the fuzzy pass below.
    seen.add([...names].sort().join("|"));
  }

  // Fuzzy matches are gated on a shared track title: the same artist
  // misspelled will share tracks, two different artists will not. Without the
  // gate this produces confident nonsense.
  //
  // ACCURACY OVER SPEED: this compares EVERY pair. An earlier version blocked
  // candidates by first character, which was 25x faster but silently stopped
  // catching typos in the first character. Full comparison is ~10s for 5,000
  // artists; the caller yields between chunks so the tab stays responsive, and
  // correctness is not traded away for a progress bar.
  //
  // The length gate below is not a heuristic, it is implied by the threshold:
  // Ratcliff/Obershelp similarity is 2M/(n+m) with M <= min(n,m), so a pair
  // whose lengths differ by more than 3 cannot reach 0.9 at these string
  // lengths. Skipping them loses nothing.
  const keys = [...buckets.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const ka = keys[i], kb = keys[j];
      if (Math.abs(ka.length - kb.length) > 3) continue;

      // Two independent candidate rules. The ratio catches reorderings and
      // longer-name noise; the edit distance catches short-name typos the ratio
      // structurally cannot reach. Confidence differs so the weaker signal is
      // labelled as such rather than presented as equally certain.
      const ratio = similar(ka, kb);
      const byRatio = ratio >= 0.9;
      const byEdit = !byRatio &&
        editDistance(ka, kb, typoBudget(ka, kb)) <= typoBudget(ka, kb);
      if (!byRatio && !byEdit) continue;

      for (const a of buckets.get(ka)) {
        for (const b of buckets.get(kb)) {
          const id = [a, b].sort().join("|");
          if (seen.has(id)) continue;

          // Gate 1: they must share a track title. The same artist misspelled
          // will; two different artists will not.
          const shared = [...tracks.get(a)].filter((t) => tracks.get(b).has(t));
          if (!shared.length) continue;

          // Gate 2: play-count asymmetry. A typo gets scrobbled a handful of
          // times; two genuinely different artists have comparable presence.
          // This matters most for short names, where edit distance alone would
          // pair up unrelated artists that happen to share a generic title
          // like "Intro". Exact-normalisation matches skip this gate, since
          // those are not judgement calls.
          const lo = Math.min(plays.get(a), plays.get(b));
          const hi = Math.max(plays.get(a), plays.get(b));
          if (lo > 0.4 * hi) continue;

          seen.add(id);
          const issue = variantIssue([a, b],
            byRatio
              ? `fuzzy match (${(ratio * 100).toFixed(0)}% similar) confirmed by ` +
                `${shared.length} shared track title(s)`
              : `one-character difference confirmed by ${shared.length} ` +
                `shared track title(s)`,
            byRatio ? 0.75 : 0.6);
          // null when the pair turns out to differ by casing alone, which the
          // fuzzy matcher can reach even though the exact pass skips it.
          if (issue) issues.push(issue);
        }
      }
    }
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/**
 * Scrobbles with no album at all.
 *
 * This used to list the MONTHS the blanks fell in, which explained the cause (a
 * cluster means one misbehaving scrobbler) but gave the reader nothing to do:
 * "18 scrobbles have no album, concentrated in 2017-07" cannot be acted on
 * without hunting through a year of history by hand.
 *
 * It now lists the actual tracks, busiest first, so every one is a link. The
 * month clustering stays in the prose, where it belongs: it is an explanation,
 * not a task. `tracks` is carried on the issue so d5Resolve() can add the album
 * each one probably belongs to once the release lookups have run.
 */
export function d5MissingAlbum(rest) {
  const blanks = rest.filter((s) => !s.album);
  if (!blanks.length) return [];
  const months = counter(blanks, (s) => monthOf(s.uts));
  const worst = ranked(months).slice(0, 4);

  const tracks = new Map();
  for (const s of blanks) {
    const k = `${norm(s.artist)}␟${trackIdentity(s.track)}`;
    const rec = tracks.get(k) ||
      { artist: s.artist, track: s.track, plays: 0, first: s.uts, last: s.uts };
    rec.plays++;
    rec.first = Math.min(rec.first, s.uts);
    rec.last = Math.max(rec.last, s.uts);
    tracks.set(k, rec);
  }
  const order = [...tracks.values()].sort((a, b) => b.plays - a.plays);

  return [{
    detector: "D5", class: "error", confidence: 0.9,
    title: `${blanks.length.toLocaleString()} scrobbles have no album, across ` +
           `${order.length.toLocaleString()} track${order.length === 1 ? "" : "s"}`,
    plays_affected: blanks.length,
    suggest:
      `Every track is listed below and links straight to it in your library. ` +
      `Mostly ${worst.map(([m, n]) => `${m} (${n})`).join(", ")}: a cluster like ` +
      `that usually means one misbehaving scrobbler over a short period rather ` +
      `than scattered mistakes, so the cause may be worth more than the ` +
      `individual fixes.`,
    tracks: order,
    members: order.slice(0, 30).map((t) => ({
      artist: t.artist, track: t.track, plays: t.plays,
    })),
    months: ranked(months).slice(0, 24).map(([month, plays]) => ({ month, plays })),
  }];
}

/**
 * Name the album each blank-album track probably belongs to.
 *
 * The point of D5 is not "you have 18 blanks", it is "here is what each one
 * should say". Reuses the same lookup the split resolver uses, so it costs
 * nothing extra once those answers are cached.
 *
 * Preference order matches d0Resolve: the earliest non-compilation album, since
 * that is where a track originally appeared, rather than whatever compilation
 * happens to be listed first.
 */
export function d5Resolve(issue, lookup) {
  if (!issue?.tracks?.length) return issue;
  let named = 0;
  const members = issue.tracks.slice(0, 30).map((t) => {
    const found = lookup(t.artist, t.track);
    const groups = found?.groups || [];
    const albums = groups.filter((g) =>
      g.primary === "Album" && !(g.secondary || []).includes("Compilation"));
    const target = albums[0] || groups[0];
    if (target) named++;
    return {
      artist: t.artist, track: t.track, plays: t.plays,
      looks_like: target
        ? `should be: ${target.title}`
        : "no album found for this title",
    };
  });

  return {
    ...issue,
    members,
    suggest: named
      ? `${named} of ${members.length} have been matched to a release, shown ` +
        `next to each track below. Each one links to your library. ` +
        issue.suggest.replace(/^Every track is listed below[^.]*\. /, "")
      : issue.suggest,
  };
}

export function d6Duplicates(scrobbles, windowSec = 30) {
  const ordered = [...scrobbles].sort((a, b) => a.uts - b.uts);
  const dupes = [];
  for (let i = 1; i < ordered.length; i++) {
    const p = ordered[i - 1], c = ordered[i];
    if (c.uts - p.uts <= windowSec &&
        normTitle(c.track) === normTitle(p.track) &&
        norm(c.artist) === norm(p.artist)) {
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

/**
 * Settle sequel-vs-typo era pairs with MusicBrainz instead of guessing.
 *
 * Play-count asymmetry cannot tell "Drip Season" and "Drip Season 3" (two real
 * Gunna tapes) apart from "Yandhi" and "Yhandi" (a typo). Asking whether each
 * name exists as a release group can.
 *
 * `exists(artist, title)` must return a truthy value only on an EXACT title
 * match after normalisation. MusicBrainz search is fuzzy and returns
 * "Drip Season 3" when asked for "Drip Season", so counting results would
 * confirm everything.
 *
 * Returns a new issue array with verified pairs dropped or sharpened.
 *
 * Honest caveat: absence from MusicBrainz is weak evidence. Era names in leak
 * culture routinely refer to projects that were never released and so have no
 * release group at all. Only the asymmetric case gets promoted to an error;
 * "neither exists" stays a low-confidence review rather than an accusation.
 */
export function verifyEraNames(issues, exists) {
  const out = [];
  for (const issue of issues) {
    if (!issue.verify) { out.push(issue); continue; }
    const { artist, a, b } = issue.verify;
    // Name the library strings, not the extracted era names. MusicBrainz is
    // asked about the era name; the user is told about the album they have.
    const aA = issue.verify.aAlbum || a;
    const bA = issue.verify.bAlbum || b;
    const hasA = Boolean(exists(artist, a));
    const hasB = Boolean(exists(artist, b));

    if (hasA && hasB) {
      // Both are real projects. Not a typo, and not worth mentioning.
      continue;
    }
    if (hasB && !hasA) {
      // The common spelling is a real release, the rare one is not.
      out.push({
        ...issue, class: "error", confidence: 0.85, verify: undefined,
        title: `Era name not found in MusicBrainz for ${artist}: '${aA}'`,
        suggest: `'${b}' exists as a real release for ${artist} but '${a}' ` +
                 `does not, so '${aA}' is likely a typo or the wrong era name. ` +
                 `Compare it against '${bA}'.`,
      });
      continue;
    }
    if (hasA && !hasB) {
      out.push({
        ...issue, class: "review", confidence: 0.4, verify: undefined,
        suggest: `'${a}' exists as a real release for ${artist} but '${b}' ` +
                 `does not, which is the opposite of what a typo looks like: ` +
                 `the rarer spelling is the real one. Worth comparing ` +
                 `'${aA}' against '${bA}'.`,
      });
      continue;
    }
    // Neither found. Common for genuinely unreleased projects, so this stays a
    // weak review rather than becoming a claim.
    out.push({
      ...issue, confidence: 0.3, verify: undefined,
      suggest: `neither '${a}' nor '${b}' exists as a release in MusicBrainz, ` +
               `which is normal for unreleased projects. Cannot tell a sequel ` +
               `from a typo here, so this is informational only. The two ` +
               `entries are '${aA}' and '${bA}'.`,
    });
  }
  return out;
}

/** Era-name pairs awaiting MusicBrainz verification, flattened to lookups. */
export function eraVerificationPlan(issues) {
  const jobs = new Map();
  for (const i of issues) {
    if (!i.verify) continue;
    for (const title of [i.verify.a, i.verify.b]) {
      jobs.set(`${i.verify.artist}␟${title}`.toLowerCase(),
               { artist: i.verify.artist, title });
    }
  }
  return [...jobs.values()];
}

/* ------------------------------------ D0 and D14e: MusicBrainz resolution */

/**
 * Which tracks need a MusicBrainz lookup, busiest first.
 *
 * Returned as a plan so the caller can pace, show progress, persist results
 * and resume, none of which belongs inside a detector.
 */
export function resolutionPlan(scrobbles, { budget = 3000 } = {}) {
  const { era, rest } = partitionEra(scrobbles);
  const splits = d4AlbumSplits(rest);

  const jobs = new Map();   // key -> {artist, track, plays, kind}
  const add = (artist, track, plays, kind) => {
    if (!artist || !track) return;
    const k = `${artist}␟${track}`.toLowerCase();
    const cur = jobs.get(k);
    if (cur) { cur.plays += plays; return; }
    jobs.set(k, { artist, track, plays, kind });
  };

  for (const s of splits) add(s.artist, s.track, s.plays_affected, "split");

  // Blank-album tracks. Cheap to include and it is what turns D5 from "you have
  // 18 blanks" into "here is the album each one should say".
  const blanks = new Map();
  for (const s of rest) {
    if (s.album) continue;
    const k = `${norm(s.artist)}␟${trackIdentity(s.track)}`;
    const cur = blanks.get(k) || { artist: s.artist, track: s.track, plays: 0 };
    cur.plays++;
    blanks.set(k, cur);
  }
  for (const b of blanks.values()) add(b.artist, b.track, b.plays, "missing");

  // D14e works per track, not per album string.
  const eraTracks = new Map();
  for (const s of era) {
    const k = `${s.artist}␟${s.track}`;
    const cur = eraTracks.get(k) || { artist: s.artist, track: s.track, plays: 0 };
    cur.plays++;
    eraTracks.set(k, cur);
  }
  for (const t of eraTracks.values()) add(t.artist, t.track, t.plays, "era");

  return [...jobs.values()]
    .sort((a, b) => b.plays - a.plays)   // spend a capped budget where it counts
    .slice(0, budget);
}

/**
 * Pick a consolidation target for each split, using MusicBrainz.
 *
 * Target = earliest release group of primary type Album without a Compilation
 * secondary type. One rule handles both directions: singles resolve forward
 * into their album, compilations resolve back to the original studio release.
 */
export function d0Resolve(splits, lookup) {
  const out = [];
  for (const issue of splits) {
    const found = lookup(issue.artist, issue.track);
    if (!found?.groups?.length) continue;
    const groups = found.groups;
    const albums = groups.filter((g) =>
      g.primary === "Album" && !(g.secondary || []).includes("Compilation"));
    const target = (albums[0] || groups[0]);
    out.push({
      ...issue,
      detector: "D0",
      confidence: issue.temporal ? 0.9 : 0.75,
      suggest: `consolidate to '${target.title}' (${target.primary}, ` +
               `${target.first_release || "date unknown"})`,
      external: target,
      candidates: groups.slice(0, 8),
    });
  }
  return out;
}

/**
 * Unreleased material that now has an official release.
 *
 * Deliberately does NOT recommend consolidation. A leak is frequently a
 * different recording from the official release, so the pre/post split may be
 * correct rather than accidental. Title matching is also weaker here than
 * anywhere else: leaks circulate under working titles and get released under
 * different ones, with no duration or fingerprint fallback. Precision over
 * recall, always "verify".
 */
export function d14eReleasedSince(era, lookup) {
  const tracks = new Map();
  for (const s of era) {
    const k = `${s.artist}␟${s.track}`;
    const rec = tracks.get(k) ||
      { artist: s.artist, track: s.track, plays: 0, first: s.uts, last: s.uts, eras: new Map() };
    rec.plays++;
    rec.first = Math.min(rec.first, s.uts);
    rec.last = Math.max(rec.last, s.uts);
    const name = eraName(s.album);
    if (name) rec.eras.set(name, (rec.eras.get(name) || 0) + 1);
    tracks.set(k, rec);
  }

  const issues = [];
  for (const rec of [...tracks.values()].sort((a, b) => b.plays - a.plays)) {
    const found = lookup(rec.artist, rec.track);
    if (!found?.groups?.length) continue;

    /*
     * MusicBrainz is a WEAK source for this one question, and this is the only
     * detector where that is true.
     *
     * MusicBrainz catalogues leaked and bootlegged projects as release groups,
     * because it documents music rather than commerce. Kanye's `Yandhi` was
     * never released, yet it exists there, so "a release group with this title
     * exists" is close to worthless as evidence that a leak came out. The
     * detector reported "An official Album 'Yandhi' (date unknown) contains a
     * recording with this title" for a track filed under `Unreleased (Yandhi v2
     * Era)`, which is circular: it found the leak it was asked about.
     *
     * Three guards, cheapest and strongest first.
     */
    const eraNames = [...rec.eras.keys()];

    const official = found.groups.filter((g) => {
      if (g.status !== "Official") return false;
      if (!["Album", "Single", "EP"].includes(g.primary)) return false;
      const secondary = g.secondary || [];
      // Bootleg was already excluded. Demo and Mixtape/Street are how
      // MusicBrainz files a lot of leaked material.
      if (secondary.some((t) => /bootleg|demo/i.test(t))) return false;

      // GUARD 1: no release date, no claim. A commercially released album has a
      // date; leaked material catalogued after the fact frequently does not.
      // This alone kills the "(date unknown)" findings.
      if (!g.first_release) return false;

      // GUARD 2: the release must not simply BE the era the user filed this
      // under. If someone tags a track `Unreleased (Yandhi v2 Era)` and the
      // match is a release group called `Yandhi`, that is the same unreleased
      // project under a different name, not proof it came out.
      const title = norm(g.title);
      for (const e of eraNames) {
        const en = norm(e);
        if (!en) continue;
        if (title === en || title.includes(en) || en.includes(title)) return false;
      }
      return true;
    });
    if (!official.length) continue;

    // GUARD 3: prefer a Spotify match, and say which source answered. Presence
    // on Spotify means commercially available today, which is the question the
    // user actually has. MusicBrainz presence means "documented somewhere".
    official.sort((a, b) =>
      (a.source === "spotify" ? 0 : 1) - (b.source === "spotify" ? 0 : 1));
    const best = official[0];
    const streaming = best.source === "spotify";
    issues.push({
      detector: "D14e", class: "split",
      // Spotify presence is much better evidence than a MusicBrainz entry, so
      // the two are not reported with the same confidence.
      confidence: streaming ? 0.6 : 0.35,
      artist: rec.artist,
      title: `Possibly released since: ${rec.artist} - ${rec.track}`,
      plays_affected: rec.plays,
      suggest:
        `${best.primary} '${best.title}' (${best.first_release}) contains a ` +
        `recording with this title` +
        (streaming
          ? `, and it is on Spotify now, so it is genuinely available. `
          : `, according to MusicBrainz. Note MusicBrainz also documents leaked ` +
            `and bootlegged projects, so this is weaker evidence than it looks. `) +
        `Verify it is the same version before doing anything: the leak may be a ` +
        `different mix. Your plays run ${monthName(rec.first)} to ` +
        `${monthName(rec.last)}.`,
      members: [...rec.eras.entries()].map(([era_, plays]) => ({ era: era_, plays })),
      external: best,
      no_auto_action: true,
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

    /*
     * The sink MUST be an album string the user actually has.
     *
     * This used to be `issue.external?.title`, the MusicBrainz release-group
     * title, which is frequently not the string in the library: MusicBrainz
     * says "Graduation (Deluxe Edition)" where the scrobbles say "Graduation".
     * The simulation then moved 159 plays out of a real album and into a
     * phantom entry that existed nowhere in the data. The user saw their
     * number-one album drop 409 -> 250 with no visible destination, because
     * the movers list only reports albums present both before and after.
     *
     * The distinction that was missed: the MusicBrainz title is the right thing
     * to RECOMMEND (D0's suggest text names the canonical release), but the
     * chart simulation answers a different question, "what would your chart look
     * like if these plays were one album", and that can only ever redistribute
     * among strings that exist. Recommendation target and simulation target are
     * not the same thing.
     */
    const wanted = issue.temporal?.later || issue.external?.title || null;
    let target = null;
    if (wanted) {
      const w = norm(wanted);
      target = members.find((m) => norm(m.album) === w)?.album
            // Partial match catches "Graduation" against "Graduation (Deluxe)"
            // in either direction, which is the common real case.
            ?? members.find((m) => norm(m.album).includes(w) ||
                                   w.includes(norm(m.album)))?.album
            ?? null;
    }
    /*
     * Fallback when MusicBrainz gave no answer, which is common: the lookup can
     * fail, be skipped by the budget, or simply find nothing.
     *
     * This used to be `members[0].album`, the most-played variant. That is
     * backwards often enough to matter. The premise of the whole tool is that a
     * single gets absorbed into an album later, so if a track has 20 plays under
     * "God's Plan - Single" and 5 under "Scorpion", most-played picks the single
     * and the simulation moves plays OUT of the album. The user then sees their
     * real albums losing plays to singles, which is the opposite of the advice
     * the tool exists to give.
     *
     * So rank by what the string IS first, and only use plays to break ties
     * within a tier.
     */
    if (!target) {
      const RANK = {
        "album": 0,
        "edition variant": 1,        // a deluxe edition is still the album
        "compilation": 2,
        "single or EP": 3,
        "single (album titled after the track)": 4,
        "missing": 5,
      };
      const tier = (m) => RANK[classifyAlbumString(m.album, issue.track)] ?? 3;
      // members arrive ranked by plays, so a stable sort on tier alone leaves
      // the most-played member first within each tier.
      target = [...members].sort((a, b) => tier(a) - tier(b))[0].album;
    }

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
  // Drop emptied entries. A string whose plays all moved into its sibling no
  // longer exists in the corrected world, and listing it at 0 plays invites the
  // reader to think an album lost everything.
  const before = ranked(reported).filter(([, n]) => n > 0).slice(0, 200).map(([k]) => k);
  const after = ranked(merged).filter(([, n]) => n > 0).slice(0, 200).map(([k]) => k);
  const posB = new Map(before.map((k, i) => [k, i + 1]));
  const posA = new Map(after.map((k, i) => [k, i + 1]));

  const movers = [];
  for (const k of new Set([...before.slice(0, 120), ...after.slice(0, 120)])) {
    const b = posB.get(k), a = posA.get(k);
    if (b && a && b !== a) {
      const pb = reported.get(k) || 0, pa = merged.get(k) || 0;
      movers.push({
        album: k, from: b, to: a, delta: b - a,
        plays_before: pb, plays_after: pa,
        // A row can move for two entirely different reasons, and showing both
        // identically is what made this section unreadable. Either this album
        // absorbed plays from its own split variants, or its play count did not
        // change at all and it simply moved because other albums did.
        reason: pa === pb ? "displaced" : "merged",
      });
    }
  }
  movers.sort((x, y) =>
    (x.reason === y.reason ? 0 : x.reason === "merged" ? -1 : 1) ||
    Math.abs(y.delta) - Math.abs(x.delta));

  return {
    reported_top: before.slice(0, topN).map((k) => ({ album: k, plays: reported.get(k) })),
    corrected_top: after.slice(0, topN).map((k) => ({ album: k, plays: merged.get(k) })),
    biggest_movers: movers.slice(0, 20),
    number_one_changes: Boolean(before.length && after.length && before[0] !== after[0]),
  };
}

/**
 * Which bucket each detector scores into.
 *
 * Exhaustive on purpose, and asserted as such below. The previous version
 * hardcoded four detector lists inline and silently omitted D14e, so "this leak
 * has since been released" findings scored nothing at all: the report could list
 * them while the score called the library perfect. Any detector added later and
 * not listed here now throws in development rather than quietly scoring zero.
 */
const BUCKETS = {
  album_integrity:  ["D0", "D4", "D5"],
  artist_integrity: ["D1", "D3", "D8", "D11"],
  duplicate_rate:   ["D6", "D12"],
  era_consistency:  ["D14a", "D14c", "D14e", "D14f"],
};

/**
 * Severity weight per issue class.
 *
 * A confirmed split is not the same as something merely worth a look, and the
 * old play-share formula treated them identically. `review` is deliberately
 * light: those are informational, and inflating them would punish people for
 * having unusual libraries rather than untidy ones.
 */
const CLASS_WEIGHT = { error: 3, split: 2, review: 0.75, unfixable: 0 };

/**
 * Hygiene score, 0 to 100.
 *
 * ---------------------------------------------------------------------------
 * Why this is not play share
 * ---------------------------------------------------------------------------
 * It used to be, and the result was a number that said 100 while the report
 * below it listed ten problems. That is not a tuning issue, it is the wrong
 * denominator. 30 affected plays out of 139,000 is 0.02%, which rounds to
 * perfect no matter how many distinct things are actually wrong, so the score
 * was really measuring library SIZE and got easier to ace the more you listened.
 *
 * What a user is actually looking at is a to-do list, so the score is built
 * from the same thing: how many distinct findings there are, weighted by how
 * severe each one is, measured against the number of album strings, which is
 * the unit that gets curated. Play counts still matter, but as a modifier
 * rather than the denominator: a split affecting 400 plays deserves more weight
 * than one affecting 2.
 *
 * The rule that makes it honest: 100 is reserved for a clean library. Any
 * actionable finding caps the score at 99, so the headline can never contradict
 * the list underneath it.
 */
export function hygieneScore(totalPlays, issues, albumStrings = 0) {
  const subscores = {};
  const counts = {};
  const plays = {};

  // Falls back to a play-derived estimate when the caller omits the string
  // count. Kept because the argument is optional and a wrong-but-sane score
  // beats a crash, not because any current caller relies on it.
  //
  // The floor matters. Without it a library with 11 album strings bottoms out a
  // bucket on a single finding, because 12% of 11 is barely one penalty point.
  // Scoring someone 0 for one split in a small collection is noise, not
  // information, so the scorer refuses to be harsher than it would be for an
  // 80-string library. Real scans are far above this and unaffected: 2,000
  // scrobbles is typically ~800 strings.
  const MIN_DENOM = 80;
  const denom = Math.max(albumStrings || Math.ceil(totalPlays / 10), MIN_DENOM);

  let actionable = 0;

  for (const [bucket, dets] of Object.entries(BUCKETS)) {
    const mine = issues.filter((i) => dets.includes(i.detector) &&
                                      i.class !== "unfixable");
    counts[bucket] = mine.length;
    plays[bucket] = mine.reduce((n, i) => n + (i.plays_affected || 0), 0);

    let penalty = 0;
    for (const i of mine) {
      // A deliberate tagging convention is not a defect, so it costs NOTHING.
      // It is still reported, and still counted in issue_counts so the UI can
      // show it, but it does not touch the score at all.
      //
      // An earlier version docked points here on the reasoning that the era
      // information "genuinely is not there". That was wrong, and the test that
      // caught it is worth keeping: filing everything under one "Unreleased"
      // bucket is a choice thousands of people make on purpose, and scoring
      // them down for it turns a description into a scolding.
      if (i.style_choice) continue;

      const w = CLASS_WEIGHT[i.class] ?? 1;
      if (w > 0) actionable++;
      // Plays scale the weight sub-linearly. Linear would let one heavily
      // played album dominate the entire score; ignoring plays entirely would
      // rank a 2-play typo alongside a 400-play split.
      penalty += w * (1 + Math.log10(1 + (i.plays_affected || 0)));
    }

    // 12 is the tuning knob: the penalty a bucket can absorb per album string
    // before it bottoms out. It is a judgement about how alarmist to be, not a
    // fact, and it is the one number to change if the score feels wrong.
    subscores[bucket] =
      Math.max(0, Math.round(100 * (1 - Math.min(penalty / (denom * 0.12), 1))));
  }

  let score = Math.round(
    Object.values(subscores).reduce((a, b) => a + b, 0) /
    Object.keys(subscores).length);

  // The invariant. 100 means nothing left to fix, full stop.
  if (actionable > 0) score = Math.min(score, 99);

  return {
    score,
    subscores,
    issue_counts: counts,
    plays_affected: plays,
    actionable,
    total_plays: totalPlays,
    album_strings: albumStrings || null,
  };
}

/**
 * Every detector that can appear in a report must score somewhere.
 *
 * Checked at import time because the failure it prevents is silent: an
 * unbucketed detector does not error, it just never affects the score, which is
 * exactly the D14e bug that shipped. Cheap enough to run always.
 */
export const SCORED_DETECTORS = new Set(Object.values(BUCKETS).flat());

/* --------------------------------------------------------- orchestration */

export function analyse(scrobbles, { official } = {}) {
  const total = scrobbles.length;
  // guard first, always. `official` lets verified real releases out of the
  // protected partition so they get checked for splits like any other album.
  const { era, rest } = partitionEra(scrobbles, { official });

  const splits = d4AlbumSplits(rest);
  const issues = [
    ...d14aFormatVariants(era),
    ...d14cTrackInTwoEras(era),
    ...d14fSingleBucket(era),
    ...splits,
    ...d8FeatureCredits(rest),
    ...d1ArtistVariants(rest),
    ...d5MissingAlbum(rest),
    ...d6Duplicates(scrobbles),
    ...d11VariousArtists(rest),
    ...d12Impossible(scrobbles),
  ];
  // Two detectors are deliberately NOT run, and both stay in this file so the
  // reasoning survives and re-enabling is one line.
  //
  // D2 (canonical-name divergence) would compare stored names against
  // Last.fm's canonical forms and call the difference an error, which is
  // backwards for anyone with autocorrect off.
  //
  // D7 (casing-only variants) finds real duplicates, but Last.fm cannot change
  // the casing of a name, so every finding is unactionable. A report padded
  // with work nobody can do is worse than a shorter honest one. Note D1 also
  // skips casing-only groups, so these are now absent entirely rather than
  // reported under a different detector.

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
    // Album strings, not plays, are the scoring denominator: they are the unit
    // that actually gets curated. See hygieneScore for why.
    hygiene: hygieneScore(total, issues, new Set(
      scrobbles.filter((s) => s.album).map((s) => `${s.artist}␟${s.album}`)).size),
    era: d14Overview(era, total),
    impact: chartImpact(rest, splits),
    summary_by_detector: byDetector,
    issues,
    issues_total: issues.length,
  };
}
