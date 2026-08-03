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
 * Do two names differ ONLY in their digits?
 *
 * `Artist 0` and `Artist 9`. `Front 242` and `Front 243`. `Section 80` and
 * `Section 8`. These are different entities, never a misspelling of each other,
 * and a one-character edit distance on a short name will happily pair them.
 *
 * This is the same rule already applied to era names via VERSION_TAIL — two era
 * names differing only by a version marker are separate projects — and it was
 * simply never applied to ARTIST names. A synthetic library of 300 scrobbles with
 * no injected flaws produced 27 D1 findings, every one of them a pair like
 * `Artist 0` / `Artist 9`, and the D1 gates could not stop it: generic names
 * share track titles, which is exactly what the shared-title gate looks for.
 *
 * Deliberately narrow. Only fires when the two names are IDENTICAL once digits
 * are removed AND their digits actually differ, so:
 *
 *   'Artist 0'  / 'Artist 9'   -> true,  suppressed
 *   'Blink 182' / 'Blink-182'  -> false, same digits, still a real variant
 *   'Yeat'      / 'Teat'       -> false, no digits involved
 *   'Gunna'     / 'Gunnna'     -> false
 */
export const digitsOnlyDiffer = (a, b) => {
  const A = norm(a), B = norm(b);
  if (A === B) return false;
  const strip = (x) => x.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  if (strip(A) !== strip(B)) return false;
  const digits = (x) => (x.match(/\d+/g) || []).join(",");
  return digits(A) !== digits(B);
};

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

/* ---------------------------------------------------------------------------
 * Era naming, in six forms this library has to recognise:
 *
 *     Unreleased (Rodeo Era)        marker + bracketed qualifier
 *     Unreleased (Rodeo Sessions)   ditto, other qualifier word
 *     Rodeo Sessions                bare qualifier, no marker
 *     Eternal Atake (Sessions)      name OUTSIDE the bracket
 *     Unreleased (Rodeo)            marker + bare parenthetical
 *     Unreleased                    no era at all, a single bucket
 *
 * The fourth form was missing until a real library turned up with 111 Lil Uzi
 * Vert tracks named that way. The old `BRACKETED_QUAL` regex matched its
 * "(Sessions)" with an EMPTY capture group, so the string counted as unreleased
 * and was protected from every other detector, while yielding no era name — and
 * D14f then told the owner to "split them by era", which he had already done.
 * That was the third instance of the same silent failure: absence of an answer
 * treated as a negative answer.
 *
 * All of it is string operations now, rather than regexes. See the note on
 * ReDoS below for why that is not a matter of taste.
 * ------------------------------------------------------------------------- */
const QUAL_WORD = /^(?:era|sessions?|sesh)$/i;

/*
 * All three era-name patterns are now string operations, not regexes.
 *
 * BARE_QUAL was `/^\s*(.+?)\s+\b(?:era|sessions?|sesh)\b\s*$/i` and hung outright
 * on 4,096 leading spaces. It survived this long because `eraName` happens to
 * collapse whitespace before reaching it, while `ambiguousEra` tests the RAW
 * album string, so only `isEraTagged` was reachable and nothing called it with a
 * pathological title until the fuzzer did.
 *
 * BRACKETED_QUAL and BARE_BRACKET had the same defect in a quieter form:
 * `\s*([^)\]]*?)\s*` puts a lazy quantifier over a class that INCLUDES
 * whitespace between two `\s*`, so three quantifiers compete for every space
 * inside a bracket.
 *
 * There is no clever regex fix. Splitting a string on its last space and
 * comparing a word against a fixed anchored alternation cannot backtrack at all,
 * and it reads more plainly than the pattern it replaces.
 */

/** Every bracketed group as [content, startIndex, endIndex]. Linear: the class
 *  excludes both closing brackets, so each group matches exactly one way. */
const BRACKET_GROUP = /[([]([^)\]]*)[)\]]/g;
function bracketGroups(s) {
  const out = [];
  BRACKET_GROUP.lastIndex = 0;                     // /g is stateful, so reset
  for (let m; (m = BRACKET_GROUP.exec(s)); )
    out.push([m[1], m.index, m.index + m[0].length]);
  return out;
}

/** ["Rodeo", "Era"] for "Rodeo Era"; ["", "Sessions"] for "Sessions". */
function splitLastWord(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const i = t.lastIndexOf(" ");
  return i < 0 ? ["", t] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * The bracketed form: "(Rodeo Era)", "[Rodeo Sessions]" -> Rodeo.
 *
 * Returns the prefix, "" for a qualifier-only bracket such as "(Sessions)", or
 * null when no group ends in a qualifier. Scans groups left to right and takes
 * the first that qualifies, which is what the old regex did via backtracking.
 */
function bracketedQual(album) {
  if (!album) return null;
  for (const [content, start, end] of bracketGroups(album)) {
    const [pre, last] = splitLastWord(content);
    if (!QUAL_WORD.test(last)) continue;
    if (pre) return pre;
    // Qualifier alone in the bracket: the era name is what PRECEDES it,
    // e.g. "Eternal Atake (Sessions)". Only when the bracket ends the title,
    // so a stray "(Era)" in the middle does not rename the record.
    if (!album.slice(end).trim()) {
      const before = album.slice(0, start)
        .replace(UNREL_MARK, " ").replace(/\s+/g, " ").trim();
      if (before) return before;
    }
    return "";
  }
  return null;
}

/** The bare trailing form: "Rodeo Sessions" -> Rodeo. Null if it does not apply. */
function bareQual(album) {
  if (!album) return null;
  const [pre, last] = splitLastWord(album);
  return QUAL_WORD.test(last) && pre ? pre : null;
}

/** "Unreleased (Rodeo)" -> Rodeo. Only consulted after an unreleased marker. */
function bareBracket(album) {
  for (const [content] of bracketGroups(album || "")) {
    const t = content.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  return null;
}

/** Album strings that are unambiguously unreleased material on their own. */
const explicitEra = (album) =>
  Boolean(album) && (UNREL_STRONG.test(album) || bracketedQual(album) !== null);

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
  Boolean(album) && !explicitEra(album) && bareQual(album) !== null;

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

  // Bracketed qualifier wins: it is the most explicit form. "" means the bracket
  // held nothing but the qualifier and there was no usable name around it.
  const br = bracketedQual(album);
  if (br) return br;

  // Bare trailing qualifier, e.g. "Rodeo Sessions". Strip any unreleased marker
  // first so "Unreleased Rodeo Sessions" yields Rodeo rather than the lot.
  const bare = bareQual(album.replace(UNREL_MARK, " "));
  if (bare) return bare;

  // Bare parenthetical after an unreleased marker: "Unreleased (Rodeo)".
  if (br === null && UNREL_MARK.test(album)) {
    const inner = bareBracket(album);
    if (inner) return inner;
  }
  return null;
};

/** True for a bucket with no era distinction at all, e.g. bare "Unreleased". */
export const isUndifferentiated = (album) =>
  (explicitEra(album) || weakEra(album)) && !eraName(album);

/**
 * The guard. Era-tagged material is partitioned out before anything else and
 * hidden from D0, D4 and D1.
 *
 * Without this, D0 resolves "Unreleased (Rodeo Era)" against MusicBrainz,
 * finds "Rodeo", and confidently recommends merging them, destroying a
 * deliberate distinction. Confidently damaging a carefully maintained taxonomy
 * is the worst thing this tool could do.
 *
 * NOTE ON "D13". Earlier versions of this comment also named a D13 "orphan
 * detector", which would have flagged any album or artist with near-zero global
 * listeners and no database entry as a probable typo. It was never written, and
 * the comment promising the guard protected against it was therefore describing
 * protection from nothing — worse than either building it or leaving it out,
 * because a reader trusts the guard covers a case it does not.
 *
 * It is deliberately not being built. Two reasons:
 *
 *  - The cost is one artist.getInfo or album.getInfo per distinct string. A
 *    139,000-scrobble library has ~15,000 album strings, which is impossible
 *    inside any sane budget, so it would need a cap and would then only inspect
 *    the popular strings, which are precisely the ones LEAST likely to be typos.
 *  - The findings would mostly be unactionable. D1, D4 and D8 already catch
 *    typos by comparing strings against each other WITHIN the library. What an
 *    orphan check adds is the typo with no correct counterpart to compare
 *    against, and for exactly those it can say "nobody else has this string"
 *    without being able to say what it should have been.
 *
 * If it is ever revisited, the honest form is a low-listener-count signal used to
 * RANK existing findings rather than to generate new ones.
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
        // Version and sequel markers: not a typo, not worth a lookup, not
        // reported. Previously these became low-confidence reviews awaiting a
        // MusicBrainz ruling, which in practice was noise: the ruling often
        // could not be obtained, and when it could, MusicBrainz catalogues
        // leaked projects anyway so both names frequently "existed".
        if (differsOnlyByVersion(lo, hi)) continue;

        const loAlbum = albumOf(lo), hiAlbum = albumOf(hi);
        issues.push({
          detector: "D14a",
          // Sequel-vs-typo cannot be decided from play counts. Marked here so
          // the MusicBrainz phase can settle it with evidence: if both era
          // names exist as real release groups they are separate projects and
          // this is dropped entirely. See verifyEraNames().
          /*
           * The remaining pairs are probable typos, and THOSE are worth a
           * database check. It can only make the finding more honest: if both
           * spellings turn out to be real projects it is dropped entirely, and
           * if the lookup fails the claim is withheld rather than asserted.
           *
           * The check used to sit on the version pairs instead, where it could
           * not help, while the typo assertion went out unverified.
           *
           * a/b stay as ERA NAMES because that is what MusicBrainz is asked
           * about. The album strings ride along so verifyEraNames can name what
           * the user actually has when it rewrites these messages.
           */
          verify: { artist, a: lo, b: hi, aAlbum: loAlbum, bAlbum: hiAlbum },
          class: "error",
          confidence: 0.7,
          artist,
          title: `Probable era-name typo for ${artist}: '${loAlbum}' vs ` +
                 `'${hiAlbum}'`,
          plays_affected: playsOf(lo) + playsOf(hi),
          suggest: `'${hiAlbum}' has ${playsOf(hi)} plays against ` +
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

/*
 * Trailing version and sequel markers.
 *
 * Two era names differing only by one of these are DIFFERENT PROJECTS, always.
 * 'Drip Season 1' and 'Drip Season 2' are two Gunna tapes; 'Yandhi v1' and
 * 'Yandhi v2' are two leak packages. There is no reading under which they are a
 * misspelling of each other, so they are dropped rather than reported at low
 * confidence and sent for a database check that cannot settle anything.
 *
 * Roman numerals are limited to ii and iii: unambiguous as a trailing token,
 * where a bare 'v' or 'i' would collide with the v-prefix form and with real
 * words.
 */
const VERSION_TAIL =
  /\s*(?:v\.?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?|og|alt|final|deluxe|ii|iii|(?:pt\.?|part)\s*\d+)$/i;

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
    const k = `${s.artist}␟${trackIdentity(s.track)}`;
    if (!where.has(k)) {
      where.set(k, { artist: s.artist, track: s.track, eras: new Map(),
                     albums: new Map() });
    }
    const rec = where.get(k);
    rec.eras.set(name, (rec.eras.get(name) || 0) + 1);
    // The album strings behind each era, so the finding can link to them
    // instead of offering only an artist link.
    rec.albums.set(s.album, (rec.albums.get(s.album) || 0) + 1);
  }
  const issues = [];
  for (const { artist, track, eras, albums } of where.values()) {
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
      /*
       * `track` on the issue, and album strings in the members.
       *
       * Without `track` the issue had no track for issueLinks to use, and the
       * members carried only era NAMES, which are not linkable to anything. The
       * result was a finding about one specific song offering nothing but a link
       * to the artist's whole library. Naming the track and both album strings
       * makes it one click per entry.
       */
      track,
      members: [
        ...ranked(albums).map(([album, plays]) => ({ album, plays })),
        ...ranked(eras).map(([era_, plays]) => ({ era: era_, plays })),
      ],
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
export function d14fSingleBucket(era, { minTracks = 8, rest = [] } = {}) {
  /*
   * `rest` is the non-unreleased half of the library, used for two things the
   * earlier version could not do.
   *
   * 1. CHART RANK. The information-loss argument ("you cannot see which project
   *    each track came from") is true but abstract. The concrete consequence is
   *    that one `Unreleased` bucket becomes a single enormous album: 340 leaks
   *    pooled under one name can outrank every real record in the chart. That is
   *    a distortion of the same kind D4 exists for, and it is measurable.
   *
   * 2. REAL EXAMPLES. It used to suggest "e.g. 'Unreleased (Rodeo Era)'"
   *    regardless of who the artist was, which is useless for anyone who does not
   *    listen to Travis Scott. The artist's own released albums are sitting in the
   *    library, so the suggestion can name their actual projects.
   */
  const albumPlays = counter(rest.filter((x) => x.album),
                             (x) => `${x.artist}␟${x.album}`);
  // Real albums per artist, most played first, for the examples.
  const realAlbums = new Map();
  for (const [key, plays] of ranked(albumPlays)) {
    const [artist, album] = key.split("␟");
    const k = norm(artist);
    if (!realAlbums.has(k)) realAlbums.set(k, []);
    const list = realAlbums.get(k);
    if (list.length < 3) list.push({ album, plays });
  }

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

  // Where this bucket would sit if it were a real album, so the inflation is a
  // number rather than an assertion.
  const realRanking = ranked(albumPlays).map(([, plays]) => plays);
  const rankOf = (plays) => realRanking.filter((p) => p > plays).length + 1;

  const issues = [];
  for (const b of [...buckets.values()].sort((x, y) => y.plays - x.plays)) {
    if (b.tracks.size < minTracks) continue;

    const rank = rankOf(b.plays);
    const biggestReal = realRanking[0] || 0;
    const outranksAll = b.plays > biggestReal && biggestReal > 0;

    // Examples from THIS artist's own catalogue, falling back to a generic
    // phrasing rather than naming someone else's albums.
    const examples = (realAlbums.get(norm(b.artist)) || []).slice(0, 2);
    const suggestion = examples.length
      ? examples.map((e) => `'${b.album} (${e.album} Era)'`).join(" and ")
      : `'${b.album} (Era name)'`;

    issues.push({
      detector: "D14f",
      class: "review",
      confidence: 0.3,
      style_choice: true,
      artist: b.artist,
      album: b.album,
      title: `${b.artist} - ${b.tracks.size} unreleased tracks pooled into one ` +
             `'${b.album}' album` +
             (rank <= 10 ? `, now your #${rank} album` : ""),
      plays_affected: b.plays,
      chart_rank: rank,
      suggest:
        `${b.plays} plays across ${b.tracks.size} tracks all sit under one album ` +
        `name, which makes it a single enormous album in your chart` +
        (outranksAll
          ? `: it currently outranks every real album you own.`
          : rank <= 10
          ? `, ranking #${rank}.`
          : `.`) +
        ` This is a common and perfectly valid way to tag, so nothing here is ` +
        `wrong. Splitting it by period would both fix the chart and let ` +
        `Scrobble Drift tell you which of these have since been officially ` +
        `released. For ${b.artist} that would look like ${suggestion}` +
        (examples.length
          ? `, using the projects you already listen to.`
          : `, naming whichever period each track came from.`),
      members: [
        { album: b.album, plays: b.plays,
          looks_like: `${b.tracks.size} distinct tracks` },
        ...examples.map((e) => ({
          album: e.album, plays: e.plays,
          looks_like: "a real album of theirs, for comparison",
        })),
      ],
      no_auto_action: true,
    });
  }
  return issues;
}

/* -------------------------------------------------------- MBID evidence */

/**
 * MusicBrainz IDs, which Last.fm hands us for free and nothing has ever read.
 *
 * ---------------------------------------------------------------------------
 * Why this matters more than any heuristic in this file
 * ---------------------------------------------------------------------------
 * Every scrobble carries `album_mbid` and `track_mbid`. Both were ingested by the
 * Worker, carried through the whole pipeline, and used by exactly zero detectors.
 * The README even advertised a "D3 — MusicBrainz ID conflicts" that did not exist.
 *
 * That is a big miss, because an MBID is GROUND TRUTH for the question D4 spends
 * the most effort guessing at:
 *
 *   same album_mbid, different album strings  -> provably one release, two spellings
 *   different album_mbid                      -> provably different releases
 *
 * The second half is what kills the false positives. The Jackson 5's "Dancing
 * Machine" on both `Get It Together` and `Dancing Machine` carries two different
 * album MBIDs, so it is demonstrably not a split, and no amount of string
 * cleverness was ever going to work that out.
 *
 * ---------------------------------------------------------------------------
 * The one caveat that stops this being conclusive in both directions
 * ---------------------------------------------------------------------------
 * `album_mbid` identifies a RELEASE, not a release group. The standard and
 * deluxe pressings of one album are different releases with different MBIDs. So
 * differing MBIDs are strong evidence AGAINST a split but not proof, and are used
 * to downgrade rather than suppress. A matching MBID has no such ambiguity and is
 * treated as conclusive.
 *
 * Last.fm also populates these inconsistently: present when the scrobbler sent
 * good metadata, absent otherwise. Absence is never treated as evidence.
 */

/**
 * Recording MBIDs seen for each (artist, exact track title).
 *
 * Keyed on the EXACT title, not the base title, because the whole point is to
 * compare two spellings against each other. Keying on the base title would merge
 * them before the comparison could happen.
 */
export function trackMbids(scrobbles) {
  const map = new Map();
  for (const s of scrobbles) {
    if (!s.track || !s.track_mbid) continue;
    const k = `${norm(s.artist)}␟${trackIdentity(s.track)}`;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(s.track_mbid);
  }
  return map;
}

/**
 * How two track titles relate, per MusicBrainz.
 *
 * `track_mbid` identifies a RECORDING, which is exactly the right granularity
 * for D8: the question is whether two title spellings are the same performance.
 *
 *   "same"      one recording, two spellings. Conclusive.
 *   "different" two recordings. Also conclusive, in the opposite direction:
 *               'Roll in Peace (feat. XXXTENTACION)' and the Travis Scott
 *               version are genuinely different recordings and must not merge.
 *   "unknown"   at least one side has no MBID.
 *
 * Unlike album MBIDs there is no pressing ambiguity here, so BOTH answers are
 * treated as conclusive. A remaster or a live take is a different recording and
 * differing MBIDs correctly say so.
 */
export function trackMbidVerdict(mbids, artist, a, b) {
  const A = mbids.get(`${norm(artist)}␟${trackIdentity(a)}`);
  const B = mbids.get(`${norm(artist)}␟${trackIdentity(b)}`);
  if (!A?.size || !B?.size) return "unknown";
  for (const id of A) if (B.has(id)) return "same";
  return "different";
}

/** Album MBIDs seen for each (artist, album string). */
/**
 * Artist name -> the set of MusicBrainz artist IDs seen for it.
 *
 * The decisive evidence for D8. If "Macklemore & Ryan Lewis" carries its own
 * artist MBID then MusicBrainz holds it as an artist in its own right, and no
 * amount of pattern matching should be allowed to argue otherwise. Free: the ID is
 * already on every scrobble, it just was not being read.
 */
export function artistMbids(scrobbles) {
  const out = new Map();
  for (const s of scrobbles || []) {
    if (!s?.artist || !s.artist_mbid) continue;
    const k = norm(s.artist);
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(s.artist_mbid);
  }
  return out;
}

export function albumMbids(scrobbles) {
  const map = new Map();
  for (const s of scrobbles) {
    if (!s.album || !s.album_mbid) continue;
    const k = `${norm(s.artist)}␟${norm(s.album)}`;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(s.album_mbid);
  }
  return map;
}

/**
 * How two album strings relate, per MusicBrainz.
 *
 *   "same"      they share an MBID: one release, two spellings
 *   "different" neither MBID appears on the other: different releases
 *   "unknown"   at least one side has no MBID at all
 */
export function mbidVerdict(mbids, artist, a, b) {
  const A = mbids.get(`${norm(artist)}␟${norm(a)}`);
  const B = mbids.get(`${norm(artist)}␟${norm(b)}`);
  if (!A?.size || !B?.size) return "unknown";
  for (const id of A) if (B.has(id)) return "same";
  return "different";
}

/*
 * There is no D3.
 *
 * It reported that one album name in a library covers two different MusicBrainz
 * releases, which happens with a reissue or a second pressing. Removed because it
 * was unactionable in the strictest sense: Last.fm already pools those plays under
 * one name, which is the correct outcome, so there was nothing to merge, nothing
 * to click and nothing to decide.
 *
 * The justification it shipped with was "it explains a play count that looks off",
 * and that does not survive being read carefully: if two pressings are pooled the
 * count is their sum, which is what you want. It was a fact about MusicBrainz's
 * data model rather than about anyone's library, and it failed the standard set
 * for the rest of the report, which is that a finding has to be something you can
 * act on.
 *
 * Reported by the person it was shown to as "I have absolutely no clue what is
 * flagged here", which is the right reaction to a card whose own text says
 * "nothing to merge" above two opaque MBID fragments.
 *
 * `albumMbids` and `mbidVerdict` remain and are still load-bearing: they are the
 * ground truth D4 uses to decide that two album names ARE the same release, and to
 * downgrade itself when they are not. That was always the valuable half.
 */

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
  // MusicBrainz IDs from the scrobbles themselves. Free, already in hand, and
  // conclusive where present. Built once for the whole pass.
  const mbids = albumMbids(rest);
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

    /*
     * A track legitimately on two different albums is not a split.
     *
     * The Jackson 5's 'Dancing Machine' is on the 1973 album `Get It Together`
     * and on the 1974 album `Dancing Machine`. Both are real, separate records.
     * The detector already worked this out, saying "the two look like different
     * releases rather than one absorbing the other", and then reported it as a
     * 70% split anyway. The evidence was being computed and ignored.
     *
     * The distinction D4 exists for is a single being ABSORBED into an album, so
     * it needs at least one of:
     *   - a migration signature (all early plays on one string, later on another)
     *   - one string that looks like a single, an EP or an edition variant
     *
     * Two plain albums with no migration is normal discography, not drift.
     *
     * Note `classifyAlbumString` calls an album named after its title track a
     * "single", which is wrong for `Dancing Machine` and for every self-titled
     * lead single. Requiring a migration signature alongside it is what stops
     * that misread from producing a confident claim.
     */
    /*
     * MBID evidence, ranked above every string heuristic below.
     *
     * "same"      -> the two strings ARE one release. Conclusive: upgrade to an
     *                error, and no release lookup is needed at all.
     * "different" -> provably separate releases. Downgraded rather than
     *                suppressed, because album_mbid identifies a RELEASE and the
     *                deluxe and standard pressings of one album legitimately
     *                carry different IDs.
     * "unknown"   -> at least one side has no MBID. Falls through to the
     *                heuristics unchanged; absence is never evidence.
     */
    const verdict = members.length >= 2
      ? mbidVerdict(mbids, g.artist, members[0].album, members[1].album)
      : "unknown";

    const kinds = members.slice(0, 2).map((m) => m.looks_like);
    /*
     * Only RELIABLE single markers count here.
     *
     * classifyAlbumString returns "single (album titled after the track)"
     * whenever the album and track names match, which is a guess, not a fact:
     * an album named after its lead track is extremely common. `Dancing
     * Machine` is a 1974 Jackson 5 ALBUM, and treating that label as evidence of
     * a single is what let a two-album discography look like a split.
     *
     * An explicit " - Single" / " - EP" suffix, an edition variant or a
     * compilation are all real signals. The name-match guess is not.
     */
    const hasSingleish = kinds.some((k) =>
      /single or ep|edition variant|compilation|missing/i.test(k || ""));
    const plainAlbums = !structural && !migration && !hasSingleish;

    // A one-play minority side is a stray, not a systematic split. Same
    // reasoning as the single stray scrobble in D8.
    const minority = members.length > 1
      ? members[members.length - 1].plays : 0;
    const stray = minority <= 1 && total <= 4;

    // A verified MBID match overrides every doubt below it: the strings are the
    // same release, whatever they look like. A verified mismatch overrides the
    // other way.
    /*
     * ONE decision, from which class and confidence are both derived.
     *
     * These used to be two independent ternary ladders with DIFFERENT orderings:
     * `class` tested stray before migration, `confidence` tested migration before
     * stray. A finding that was both — a chronologically clean split with only 4
     * plays — came out as class "review" carrying 0.9 confidence, which is a
     * contradiction the report has no way to render sensibly.
     *
     * Real data found it. A 541-scrobble library produced exactly one finding and
     * it was this: "review 90%". Two ladders that must agree will eventually
     * disagree, so there is now one.
     *
     * Order is most-conclusive-first. `stray` deliberately outranks `migration`:
     * a one-play minority is too small to trust any signal, including a clean
     * chronological separation, and nothing with four total plays is worth
     * acting on either way.
     */
    const reason =
      verdict === "same" ? "proven"
      : verdict === "different" ? "disproven"
      : structural ? "structural"
      : stray ? "stray"
      : plainAlbums ? "plain-albums"
      : migration ? "migration"
      : "candidate";

    const DECISION = {
      "proven":       { class: "error",  confidence: 0.97 },
      "disproven":    { class: "review", confidence: 0.15 },
      "structural":   { class: "review", confidence: 0.25 },
      "stray":        { class: "review", confidence: 0.30 },
      "plain-albums": { class: "review", confidence: 0.20 },
      "migration":    { class: "split",  confidence: 0.90 },
      "candidate":    { class: "split",  confidence: 0.70 },
    };
    const decided = DECISION[reason];

    issues.push({
      detector: "D4",
      class: decided.class,
      confidence: decided.confidence,
      // Carried so a reader (or a future test) can see WHY, not just how sure.
      reason,
      // Carried so the resolver can skip a lookup it cannot improve on.
      mbid_verdict: verdict,
      artist: g.artist, track: g.track,
      title: structural
        ? `${g.artist} - '${g.track}' appears on ${g.albums.size} albums`
        : `${g.artist} - '${g.track}' split across ${g.albums.size} album strings`,
      plays_affected: total,
      suggest: reason === "proven"
        ? `MusicBrainz confirms these are the same release under two different ` +
          `names, so this is certain rather than a guess. Consolidate to ` +
          `'${members[0].album}' (${members[0].plays} plays).`
        : reason === "disproven"
        ? `MusicBrainz says these two album names are different releases, so ` +
          `this is probably a song that genuinely appears on both rather than a ` +
          `split. Note it identifies pressings, so a deluxe and a standard ` +
          `edition of one album will also look different here. Nothing to fix ` +
          `unless you know they are the same record.`
        : reason === "structural"
        ? `'${g.track}' is a structural track title, so these are almost ` +
          `certainly different recordings, one per album, rather than one ` +
          `track split in two. Nothing to fix unless you know otherwise.`
        : reason === "migration"
        ? `consolidate to '${temporal.later}': the earlier string looks like ` +
          `the pre-album release.`
        : reason === "plain-albums"
        ? `Both of these look like ordinary albums, and there is no sign of one ` +
          `absorbing the other, so this is probably just a song that appears on ` +
          `two releases. Common with lead singles that get their own album, ` +
          `reissues and label compilations. Nothing to fix unless you know ` +
          `these are the same record.`
        : reason === "stray"
        ? `${minority} play sits under '${members[members.length - 1].album}' ` +
          `against ${members[0].plays} under '${members[0].album}'. Too small ` +
          `to be a tagging habit, so probably a one-off. The dates are below if ` +
          `you want to look.`
        : `candidate for consolidation, but the two album strings do not look ` +
          `like editions of one release. Enable release lookups to confirm ` +
          `before merging anything.`,
      members,
      // The temporal note is suppressed for structural titles, and for anything
      // decided on other grounds: quoting a chronology under a finding that says
      // "these are two different albums" reads as contradictory evidence.
      temporal: (reason === "structural" || reason === "disproven")
        ? undefined : temporal,
    });
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/* --------------------------------------------------- D8 feature credits */

// Only a BRACKETED trailing credit is stripped. An unbracketed "with" occurs
// in real titles ("Dancing With Myself", "With You"), and merging genuinely
// different songs is the worst failure available here.
const FEAT_SUFFIX = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|w\/)\s+[^)\]]*[)\]]\s*$/i;
/*
 * Feature markers in an ARTIST field, split by how ambiguous they are.
 *
 * `&` and `,` used to sit in here alongside `feat.`, and that was badly wrong. An
 * ampersand is a band-name separator far more often than a feature marker, and the
 * only gate was that the text before it also existed in the library, which is true
 * for every duo whose frontman has solo work:
 *
 *   Macklemore & Ryan Lewis      Bob Marley & The Wailers
 *   Tom Petty & The Heartbreakers    Nick Cave & The Bad Seeds
 *   Simon & Garfunkel            Angus & Julia Stone
 *
 * All reported as `error` at 90% confidence, telling the owner to strip a real
 * artist's name down to its first member. Reported by the person it was shown to:
 * "this is one of the few times an & is correct". It is not few. Commas are the
 * same story: Earth, Wind & Fire and Tyler, The Creator.
 *
 * So they are gone. What remains is unambiguous: nobody names a band "X feat. Y".
 * `with` and ` x ` stay but only as WEAK evidence, because "Jack U x Skrillex" is a
 * collaboration marker while a band could plausibly use either.
 */
const ARTIST_FEAT_STRONG = /\s+(?:feat\.?|ft\.?|featuring|w\/)\s+/i;
const ARTIST_FEAT_WEAK = /\s+(?:with|\bx\b)\s+/i;

/*
 * `&` and `,` on their own prove nothing, but they are not always innocent either.
 *
 * The distinction is not the punctuation, it is DUO versus ONE-OFF COLLABORATION:
 *
 *   Macklemore & Ryan Lewis   a persistent act. Ryan Lewis has no solo catalogue,
 *                             so the name is the artist and stripping it is wrong.
 *   Future & Young Thug       made one album together. Both are major solo
 *                             artists, so this tag invents a THIRD artist that
 *                             takes plays from two real ones.
 *
 * Free signal that separates them: does the part AFTER the separator also stand on
 * its own in this library? "Ryan Lewis" will not appear alone; "Young Thug" will,
 * with hundreds of plays. When both halves are substantial artists in their own
 * right, the combined string is very likely a collaboration credit.
 *
 * Reported as `review` and never as an error, because the judgement is genuinely
 * the owner's: some people deliberately keep collaboration albums under a joint
 * credit, and that is a defensible choice rather than a defect.
 */
const ARTIST_JOIN = /\s*(?:&|,|\+)\s*/;
const ARTIST_FEAT = new RegExp(
  `${ARTIST_FEAT_STRONG.source}|${ARTIST_FEAT_WEAK.source}`, "i");

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
  // Recording MBIDs, which settle the feature-credit question outright wherever
  // Last.fm supplied them. Ranked above the credit heuristic below.
  const tmb = trackMbids(rest);

  const variants = new Map();
  const when = new Map();          // `${key}␟${rawTitle}` -> {first, last}
  for (const s of rest) {
    const k = `${norm(s.artist)}␟${trackIdentity(baseTitle(s.track))}`;
    if (!variants.has(k)) variants.set(k, { artist: s.artist, titles: new Map() });
    const v = variants.get(k);
    v.titles.set(s.track, (v.titles.get(s.track) || 0) + 1);

    // WHEN each spelling was played. Without this a finding like "'IMY2' 1 play"
    // is unfindable: the user knows they never scrobbled it that way, cannot
    // locate the one that says otherwise, and reasonably concludes the tool is
    // wrong. A date turns it into something checkable in ten seconds.
    const wk = `${k}␟${s.track}`;
    const w = when.get(wk) || { first: s.uts, last: s.uts };
    w.first = Math.min(w.first, s.uts);
    w.last = Math.max(w.last, s.uts);
    when.set(wk, w);
  }
  for (const [key, { artist, titles }] of variants) {
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

    /*
     * MBID evidence first, because it is a fact where the credit test is an
     * inference.
     *
     * "same"      -> one recording under two spellings. A split, certainly, and
     *                the credit conflict below becomes irrelevant: whatever the
     *                bracketed text says, MusicBrainz says it is one performance.
     * "different" -> two recordings. Never merge, regardless of how compatible
     *                the credits look. This is the 'Roll in Peace' case settled
     *                by data rather than by parsing artist names out of brackets.
     */
    const tVerdict = order.length >= 2
      ? trackMbidVerdict(tmb, artist, order[0][0], order[1][0])
      : "unknown";

    let conflict = false;
    for (let i = 0; i < credits.length && !conflict; i++) {
      for (let j = i + 1; j < credits.length; j++) {
        if (!creditsCompatible(credits[i], credits[j])) { conflict = true; break; }
      }
    }
    // A confirmed single recording clears a credit conflict; a confirmed pair of
    // recordings creates one even when the credits look compatible.
    if (tVerdict === "same") conflict = false;
    if (tVerdict === "different") conflict = true;

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

    /*
     * A single stray play is not the same finding as an even split.
     *
     * 14 plays of 'IMY2 (with Kid Cudi)' against 1 of 'IMY2' is one mis-scrobble,
     * not a systematic tagging inconsistency, and calling both 80% confident
     * "standardise on..." overstates it. Renaming one scrobble is also barely
     * worth doing, so the wording should not imply a chore.
     */
    const total = order.reduce((n, [, v]) => n + v, 0);
    const strays = order.slice(1).reduce((n, [, v]) => n + v, 0);
    // A confirmed identical recording is not a "stray" however few plays it has:
    // it is the same performance filed twice, and that is worth stating plainly.
    const stray = tVerdict !== "same" && strays <= 2 && strays / total < 0.15;
    const proven = tVerdict === "same";

    issues.push({
      detector: "D8",
      class: proven ? "error" : "split",
      confidence: proven ? 0.97 : (stray ? 0.5 : 0.8),
      mbid_verdict: tVerdict,
      // The artist is carried AND named in the title. Without it the report
      // said things like "'Make It Work' scrobbled under 2 title variants",
      // which does not identify whose track it is, and left the issue with no
      // artist for the library deep links to use.
      artist,
      track: order[0][0],
      title: `${artist} - '${baseTitle(order[0][0])}' scrobbled under ` +
             `${titles.size} title variants`,
      plays_affected: order.reduce((n, [, v]) => n + v, 0),
      suggest: proven
        ? `MusicBrainz gives both spellings the same recording ID, so this is ` +
          `one performance filed twice rather than two versions. Standardise on ` +
          `'${order[0][0]}' (${order[0][1]} plays).`
        : stray
        ? `Almost all of these say '${order[0][0]}' (${order[0][1]} plays). ` +
          `${strays === 1 ? "One scrobble" : `${strays} scrobbles`} used a ` +
          `different spelling, dated below, which usually means a one-off from ` +
          `another player or a manual entry rather than a tagging habit. Barely ` +
          `worth fixing, but the date is there if you want to find it.`
        : `standardise on '${order[0][0]}' (${order[0][1]} plays). Check ` +
          `the official credit style before assuming 'feat.': many ` +
          `releases use 'with'.`,
      members: order.map(([track, plays]) => {
        const w = when.get(`${key}␟${track}`);
        return {
          track, plays,
          first: w?.first, last: w?.last,
          // Shown next to the variant. A single play gets one date; a range
          // gets both, which distinguishes "one stray" from "used for months".
          looks_like: w
            ? (plays === 1 || monthName(w.first) === monthName(w.last)
                ? monthName(w.first)
                : `${monthName(w.first)} to ${monthName(w.last)}`)
            : undefined,
        };
      }),
    });
  }

  // Artist field polluted with a feature. Worse than an album split: it
  // invents a phantom artist that competes with the real one in the chart.
  const counts = counter(rest, (s) => s.artist);
  const artistIds = artistMbids(rest);
  const primaries = new Set(
    [...counts.keys()].filter((a) => !ARTIST_FEAT.test(a)).map((a) => norm(a)),
  );
  /*
   * Distinct albums per artist string, which is the second collaboration signal.
   * A one-off collaboration has one album under the joint name; an established duo
   * usually has several.
   */
  const albumsPer = new Map();
  for (const sc of rest) {
    if (!sc?.artist) continue;
    const k = norm(sc.artist);
    if (!albumsPer.has(k)) albumsPer.set(k, new Set());
    if (sc.album) albumsPer.get(k).add(norm(sc.album));
  }
  const soloPlays = (name) => counts.get(name) ??
    [...counts].find(([a]) => norm(a) === norm(name))?.[1] ?? 0;

  for (const [artist, n] of counts) {
    const strong = ARTIST_FEAT_STRONG.test(artist);
    const weak = ARTIST_FEAT_WEAK.test(artist);

    /*
     * The MBID gate first, for EVERY shape of credit.
     *
     * It was below the joint-credit branch, so a joint name with its own
     * MusicBrainz artist ID never got the benefit of it. That is the wrong way
     * round: an ID is the strongest evidence available that a name is a real act,
     * and joint names are exactly where that question is hardest.
     */
    if (artistIds.get(norm(artist))?.size) continue;

    /* ---- joint credits: both halves standing alone is the tell ---------- */
    if (!strong && !weak && ARTIST_JOIN.test(artist)) {
      const parts = artist.split(ARTIST_JOIN).map((x) => x.trim()).filter(Boolean);
      if (parts.length !== 2) continue;            // "Earth, Wind & Fire" and friends
      const [a, b] = parts;
      const aPlays = soloPlays(a), bPlays = soloPlays(b);
      // BOTH sides must be real artists here, with enough plays to mean something.
      // One side alone is the duo case and must stay silent.
      if (aPlays < 5 || bPlays < 5) continue;

      const joint = albumsPer.get(norm(artist))?.size ?? 0;
      issues.push({
        detector: "D8",
        class: "review",
        // One shared album reads as a collaboration; several reads as a duo that
        // simply happens to contain two working solo artists.
        confidence: joint <= 1 ? 0.6 : 0.35,
        artist,
        title: `'${artist}' may be a collaboration rather than an artist name`,
        plays_affected: n,
        suggest:
          `Both '${a}' (${aPlays} plays) and '${b}' (${bPlays} plays) also ` +
          `exist on their own in your library, so this joint credit is a third ` +
          `artist competing with two real ones` +
          (joint <= 1
            ? `, and it covers a single album, which is what a one-off ` +
              `collaboration looks like.`
            : `, though it covers ${joint} albums, which is more like a ` +
              `established duo.`) +
          ` Crediting the tracks to one artist with the other as a feature would ` +
          `merge the plays. If you prefer keeping collaboration albums under a ` +
          `joint credit, that is a reasonable choice and nothing is broken.`,
        members: [
          { artist, plays: n, looks_like: `joint credit, ${joint} album${joint === 1 ? "" : "s"}` },
          { artist: a, plays: aPlays, looks_like: "also solo" },
          { artist: b, plays: bPlays, looks_like: "also solo" },
        ],
        /*
         * Settleable by asking whether the joint name is a real artist.
         *
         * "Tobi & Manny" has a Spotify artist page and Tobi also releases solo, so
         * the library signals alone read as a collaboration when it is actually a
         * duo. No amount of play counting fixes that; only asking does.
         * d8VerifyJointCredits drops the finding when the name turns out to be a
         * real act, and the resolve phase supplies the lookup.
         */
        verify_artist: artist,
      });
      continue;
    }

    if (!strong && !weak) continue;

    const head = artist.split(ARTIST_FEAT)[0].trim();
    if (!primaries.has(norm(head)) || norm(head) === norm(artist)) continue;

    /*
     * `with` and ` x ` are reported, but as a question rather than a defect. A
     * duo could reasonably use either, and the cost of being wrong here is that
     * someone destroys a correct artist credit on our say-so.
     */
    issues.push({
      detector: "D8",
      class: strong ? "error" : "review",
      confidence: strong ? 0.9 : 0.4,
      artist,
      title: strong
        ? `Artist field contains a feature credit: '${artist}'`
        : `Artist field may contain a feature credit: '${artist}'`,
      plays_affected: n,
      suggest: strong
        ? `artist should be '${head}', with the feature moved into the track ` +
          `title. This phantom artist is competing with '${head}' in your ` +
          `artist chart.`
        : `If this is a collaboration rather than a band name, the artist should ` +
          `be '${head}' with the rest moved into the track title, since it is ` +
          `competing with '${head}' in your artist chart. If it IS the band's ` +
          `name, leave it: plenty of acts have one like this and MusicBrainz has ` +
          `no ID on these scrobbles to settle it either way.`,
      members: [{ artist, plays: n }, { artist: head, plays: counts.get(head) || 0 }],
    });
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/**
 * Settle joint-credit findings by asking whether the name is a real artist.
 *
 * The library alone cannot decide this. "Tobi & Manny" has a Spotify artist page
 * and BOTH members release solo, so every signal available from play counts says
 * "collaboration" while the truth is "duo". "Future & Young Thug" looks identical
 * and is a collaboration. The only difference is whether the joint name exists as
 * an act, which is a question, not an inference.
 *
 * `exists(artist)` returns true, false, or null when nothing is known. Absence of
 * an answer is NOT treated as absence of an artist: an unknown leaves the finding
 * exactly as it was rather than promoting it, which is the mistake this codebase
 * has made four separate times.
 */
export function d8VerifyJointCredits(issues, exists) {
  const out = [];
  for (const i of issues || []) {
    if (!i?.verify_artist) { out.push(i); continue; }

    const answer = exists?.(i.verify_artist);

    // A real artist page settles it. Drop the finding entirely rather than
    // demoting it: there is nothing here for anyone to act on.
    if (answer === true) continue;

    if (answer === false) {
      // Nobody has this name as an artist, which corroborates the play-count
      // reading. Still a review, because a duo can be too obscure to be listed.
      out.push({
        ...i,
        confidence: Math.min(0.75, (i.confidence || 0.5) + 0.15),
        evidence: "no artist page under this name",
        suggest: i.suggest +
          ` No release database lists '${i.verify_artist}' as an artist either, ` +
          `which supports reading it as a collaboration rather than a name.`,
      });
      continue;
    }

    out.push(i);                        // unknown: unchanged, and said so
  }
  return out;
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

          // Gate 0, before the others: a digit-only difference is a different
          // entity, not a typo. Checked first because it is the cheapest and it
          // defeats the shared-title gate, which generic names satisfy trivially.
          if (digitsOnlyDiffer(a, b)) continue;

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

  /*
   * Members are the actual duplicated scrobbles, with a date and time.
   *
   * They used to be MONTHS, which told the reader nothing they could use: "1
   * probable duplicate scrobble, 2026-06" leaves you to find one scrobble in a
   * month of listening. Deleting a duplicate needs the artist, the track and the
   * timestamp, so those are what it shows now. Same mistake D5 was making.
   */
  const stamp = (uts) => new Date(uts * 1000)
    .toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const issues = [{
    detector: "D6", class: "error", confidence: 0.8,
    title: `${dupes.length.toLocaleString()} probable duplicate ` +
           `scrobble${dupes.length === 1 ? "" : "s"} ` +
           `(same track twice within ${windowSec}s)`,
    plays_affected: dupes.length,
    suggest:
      `Each one is listed below with the exact time of the SECOND scrobble, ` +
      `which is the one to remove. Almost always two scrobblers running at ` +
      `once rather than anything you did` +
      (dupes.length > 20
        ? `, so finding the cause is worth more than deleting ${dupes.length} ` +
          `entries by hand.`
        : `.`),
    members: dupes.slice(0, 30).map((d) => ({
      artist: d.artist, track: d.track, plays: 1,
      looks_like: stamp(d.uts),
      first: d.uts, last: d.uts,
    })),
    months: ranked(dupMonths).slice(0, 24).map(([month, plays]) => ({ month, plays })),
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
  /*
   * `exists(artist, title)` is THREE-STATE, and that is the whole point.
   *
   *   true      the release group exists
   *   false     it was looked up and genuinely is not there
   *   null      the lookup did not happen or failed
   *
   * It used to be coerced with Boolean(), so a FAILED lookup became "does not
   * exist" and the tool made a confident claim from missing data. That produced
   *
   *   "'Rolling Papers' exists as a real release for Wiz Khalifa but
   *    'Rolling Papers 2' does not"
   *
   * about an album that came out in 2018. The lookup had simply errored.
   *
   * This is the third time this exact shape has bitten: Spotify catalogue
   * caching, fetchCatalogue's error flag, and now here. Absence of an answer is
   * not a negative answer, and any code that conflates them will eventually
   * state something false with confidence.
   */
  const out = [];
  for (const issue of issues) {
    if (!issue.verify) { out.push(issue); continue; }
    const { artist, a, b } = issue.verify;
    // Name the library strings, not the extracted era names. MusicBrainz is
    // asked about the era name; the user is told about the album they have.
    const aA = issue.verify.aAlbum || a;
    const bA = issue.verify.bAlbum || b;
    const rawA = exists(artist, a);
    const rawB = exists(artist, b);

    // Unknown on either side means no asymmetry claim can be made. Keep the
    // finding as the neutral review it started as, and say why.
    if (rawA == null || rawB == null) {
      out.push({
        ...issue, confidence: 0.25, verify: undefined,
        suggest: `these differ only by a version or sequel marker, so they are ` +
                 `probably separate projects rather than a typo. Could not ` +
                 `check against a release database this run, so this is ` +
                 `unconfirmed either way. The two entries are '${aA}' and ` +
                 `'${bA}'.`,
      });
      continue;
    }

    const hasA = rawA === true;
    const hasB = rawB === true;

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

  // Artist MBIDs, harvested from the scrobbles themselves. Last.fm supplies these
  // on many scrobbles, and having one lets a MusicBrainz catalogue browse skip
  // the name-resolution call AND removes any chance of browsing the wrong
  // artist's discography.
  const mbids = new Map();
  for (const s of scrobbles) {
    if (s.artist_mbid && !mbids.has(norm(s.artist))) {
      mbids.set(norm(s.artist), s.artist_mbid);
    }
  }

  const jobs = new Map();   // key -> {artist, track, plays, kind, artist_mbid}
  const add = (artist, track, plays, kind) => {
    if (!artist || !track) return;
    const k = `${artist}␟${track}`.toLowerCase();
    const cur = jobs.get(k);
    if (cur) { cur.plays += plays; return; }
    jobs.set(k, { artist, track, plays, kind,
                  artist_mbid: mbids.get(norm(artist)) || null });
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

/* ------------------------------------------- D15: album-artist splits */

/** Names Last.fm uses for a compilation credit. */
const VA_NAMES = new Set(["various artists", "various", "va", "verschillende artiesten"]);

/**
 * D15: one album split across two ALBUM ARTISTS.
 *
 * ---------------------------------------------------------------------------
 * Why no existing detector can see this
 * ---------------------------------------------------------------------------
 * Last.fm's album entity is keyed by (album artist, album title). So when
 * Spotify re-credited Kanye's `Cruel Winter` from "Kanye West" to "Various
 * Artists", Last.fm gained a SECOND album with the same title, and the plays
 * divided between them.
 *
 * Nothing in this file could catch it, for a specific reason: album artist is a
 * different field from track artist, and `user.getRecentTracks` returns only the
 * TRACK artist. Both halves of a Cruel Winter split therefore look byte-identical
 * in the scrobble stream. Every grouping key in this file also begins with the
 * artist, so even a cross-album comparison would never have paired them.
 *
 * `user.getTopAlbums` is the missing piece: each entry there carries the album
 * artist and a play count, and it covers the WHOLE chart rather than just the
 * scanned window.
 *
 * ---------------------------------------------------------------------------
 * The false-positive problem, and the gate
 * ---------------------------------------------------------------------------
 * Shared album titles are extremely common: self-titled records, `Greatest
 * Hits`, `Live`, `Demos`. So a title match alone proves nothing, and this only
 * fires when the two album artists are demonstrably RELATED:
 *
 *   1. they share an album MBID          -> conclusive
 *   2. one side is a Various Artists credit -> the Cruel Winter shape exactly
 *   3. one artist name contains the other  -> "Kanye West" vs "Kanye West & Kid Cudi"
 *
 * Anything else is silent, even when the titles match exactly. A stage-name
 * change ("Ye" vs "Kanye West") is therefore missed, which is the accepted cost
 * of not reporting every band that ever released a self-titled album.
 *
 * `albums` is the shape `user.getTopAlbums` returns:
 *   { name, artist: { name, mbid }, mbid, playcount }
 */
export function d15AlbumArtistSplits(albums, { minPlays = 4 } = {}) {
  const byTitle = new Map();
  for (const a of albums || []) {
    const title = a?.name;
    const artist = a?.artist?.name ?? a?.artist;
    if (!title || !artist) continue;
    const k = norm(title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push({
      title, artist,
      plays: Number(a.playcount || 0),
      mbid: a.mbid || "",
      artist_mbid: a?.artist?.mbid || "",
    });
  }

  const contains = (a, b) => {
    const x = norm(a), y = norm(b);
    if (!x || !y || x === y) return false;
    // Word-boundary containment, so "Yeat" does not match "Wheatus".
    return ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `) ||
           x.startsWith(`${y} `) || y.startsWith(`${x} `);
  };
  const isVA = (n) => VA_NAMES.has(norm(n));

  const issues = [];
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;

    // Compare every pair, since a title can carry three credits.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (norm(a.artist) === norm(b.artist)) continue;
        if (a.plays + b.plays < minPlays) continue;

        let why = null, confidence = 0, cls = "split";
        if (a.mbid && b.mbid && a.mbid === b.mbid) {
          why = "MusicBrainz gives both the same release ID, so they are one album";
          confidence = 0.95; cls = "error";
        } else if (isVA(a.artist) || isVA(b.artist)) {
          why = "one is credited to Various Artists, which is how a compilation " +
                "re-credit usually shows up";
          confidence = 0.85;
        } else if (contains(a.artist, b.artist)) {
          why = "one artist credit contains the other, so this looks like a " +
                "credit change rather than two different records";
          confidence = 0.8;
        }
        // Rule 4: unrelated artists sharing a title prove nothing. Silent.
        if (!why) continue;

        const [hi, lo] = a.plays >= b.plays ? [a, b] : [b, a];
        issues.push({
          detector: "D15", class: cls, confidence,
          artist: hi.artist,
          album: hi.title,
          title: `'${hi.title}' is split across 2 album artists: ` +
                 `'${hi.artist}' and '${lo.artist}'`,
          plays_affected: a.plays + b.plays,
          /*
           * Deliberately NOT fed into chartImpact.
           *
           * chartImpact groups by TRACK artist plus album title, and the scrobble
           * stream carries only the track artist. So this split never existed in
           * our numbers: the corrected chart already shows the combined total.
           * Last.fm's chart is the one that divides it. Adding these plays to the
           * simulation would double-count them and break the conservation
           * invariant that chartImpact is tested against.
           *
           * The useful thing is to say so, so the reader knows which of the two
           * numbers in front of them is wrong.
           */
          chart_already_correct: true,
          suggest:
            `Last.fm keys an album on the album artist as well as the title, so ` +
            `these are two separate albums in YOUR LAST.FM chart and neither ` +
            `shows the full ${a.plays + b.plays} plays. ${why}. ` +
            `'${hi.artist}' has ${hi.plays}, '${lo.artist}' has ${lo.plays}. ` +
            `Re-crediting the smaller one on Last.fm merges them. Note the ` +
            `corrected chart above already counts all ${a.plays + b.plays}: ` +
            `Scrobble Drift groups on the track artist, so it never saw this ` +
            `split. Last.fm's own chart is the one to distrust here.`,
          members: [hi, lo].map((x) => ({
            album: x.title, artist: x.artist, plays: x.plays,
            looks_like: isVA(x.artist) ? "compilation credit" : "artist credit",
          })),
        });
      }
    }
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
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
 * Report order, most worth fixing first.
 *
 * Sorting by plays alone put whatever happened to be popular at the top, which
 * is not the same as what is worth doing. This order came from actually working
 * through a report end to end:
 *
 *   1. Blank albums     unambiguous, and now carries the album each one needs
 *   2. Album splits     the findings that actually distort the charts
 *   3. Title splits     same idea, one level down
 *   4. Artist names     real but rarer
 *   5. Scrobbler bugs   duplicates and impossible timestamps, not your doing
 *   6. Era consistency  mostly informational, and mostly already correct
 *
 * Plays still break ties within a tier, so the biggest problem of the most
 * important kind is the first thing on the page.
 */
export const DETECTOR_ORDER = [
  ["D5"],                            // scrobbles with no album
  ["D0", "D4", "D15"],               // album splits, including album-artist ones
  ["D8"],                            // one track split across title variants
  ["D1"],                            // artist name variants
  ["D11"],                           // Various Artists
  ["D6", "D12"],                     // duplicate and impossible scrobbles
  ["D14a", "D14c", "D14e", "D14f"],  // unreleased tagging, mostly review
  ["D16"],                           // stranded singles, always a style choice
];

const ORDER_RANK = new Map();
DETECTOR_ORDER.forEach((tier, i) => tier.forEach((d) => ORDER_RANK.set(d, i)));

/** Classes that represent something to actually do. */
const ACTIONABLE_CLASS = new Set(["error", "split"]);

/**
 * Is this a thing to fix, or a thing to know?
 *
 * Detector tier alone was not enough. D4 outranks D8, so a D4 finding the tool
 * had already decided was probably nothing — a 20% review saying "these look like
 * two different albums, nothing to fix" — was appearing above 80% D8 splits with
 * six times the plays. Sorting by "which detector found it" ignored "is it worth
 * reading", which is the actual question.
 *
 * `style_choice` counts as informational too: a deliberate tagging convention is
 * not a task.
 */
const actionRank = (i) =>
  (i.style_choice || !ACTIONABLE_CLASS.has(i.class)) ? 1 : 0;

/**
 * Report order.
 *
 *   1. actionable before informational
 *   2. then detector tier: blank albums, album splits, title splits, ...
 *   3. then confidence, in coarse bands
 *   4. then plays
 *
 * Confidence is banded to the nearest 0.25 rather than compared exactly, so a
 * 90% finding outranks a 70% one, but 0.72 versus 0.70 does not reorder anything
 * and plays still decide between comparable findings. Sorting on raw confidence
 * would let tiny modelling differences shuffle the list between runs.
 */
export const byImportance = (a, b) =>
  actionRank(a) - actionRank(b) ||
  (ORDER_RANK.get(a.detector) ?? 99) - (ORDER_RANK.get(b.detector) ?? 99) ||
  Math.round((b.confidence || 0) * 4) - Math.round((a.confidence || 0) * 4) ||
  (b.plays_affected || 0) - (a.plays_affected || 0);

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
  album_integrity:  ["D0", "D4", "D5", "D15"],
  artist_integrity: ["D1", "D8", "D11"],
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
/*
 * `review` scores ZERO, like `unfixable` and `style_choice`.
 *
 * It used to weigh 0.75, which meant a library whose ONLY findings were
 * low-confidence reviews — every one of them saying "this is probably nothing to
 * fix" — was capped below 100 and told it had "3 things you can fix". Found on a
 * real 329-scrobble library: three D4 reviews, two of them MusicBrainz-disproven,
 * and the report claimed three actionable items.
 *
 * That contradicts the one rule the score is built on: 100 means nothing left to
 * fix. A review is by definition not a task, so the three exclusions are now
 * uniform — unfixable, style_choice and review all cost nothing. What remains
 * driving the score is `error` and `split`, which is exactly the fixable debt it
 * claims to measure.
 */
const CLASS_WEIGHT = { error: 3, split: 2, review: 0, unfixable: 0 };

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

    /*
     * Hyperbolic, not linear. The previous form was
     *
     *     100 * (1 - min(penalty / (denom * 0.12), 1))
     *
     * a straight line clamped at zero, and the clamp is where it broke. On a
     * 1,500-string library it bottomed out at about 48 findings, so:
     *
     *     220 findings -> 0        110 findings -> 0        55 findings -> 0
     *
     * Fixing 165 of 220 problems, three quarters of the work, moved the overall
     * score from 75 to 75. A tool whose headline number is meant to track library
     * health gave no feedback at all for the majority of any real cleanup, and
     * could not tell a messy library from a catastrophic one.
     *
     * `100 * k / (penalty + k)` has no clamp and no saturation. It is monotonic
     * everywhere, so every single fix moves the number, and it approaches zero
     * without reaching it, which is honest: a library with 500 problems is worse
     * than one with 200, and the score should say so rather than calling both
     * hopeless.
     *
     * HALF_AT is the penalty that scores 50, expressed per album string so it
     * still scales with library size. 0.06 puts the midpoint at roughly 1 finding
     * per 17 album strings, which lands a handful of splits near the top of the
     * range and a few hundred near the bottom. That is the alarmism dial, and it
     * is still a judgement rather than a fact.
     */
    const HALF_AT = denom * 0.06;
    subscores[bucket] = penalty === 0
      ? 100
      // Floored at 1, not 0. The geometric mean below multiplies these, so a
      // single zero would zero the whole score no matter how clean everything
      // else was. The hyperbola never truly reaches zero anyway; this only stops
      // rounding from putting it there.
      : Math.max(1, Math.round(100 * HALF_AT / (penalty + HALF_AT)));
  }

  /*
   * Geometric mean, not arithmetic.
   *
   * The arithmetic mean let one catastrophic area be averaged away by three clean
   * ones: three buckets at 100 and album_integrity at 10 gave 78, which reads as
   * "pretty good" for a library with 220 fixable splits. It also meant the
   * headline number could never fall below 75 however bad one area got, so fixing
   * 55 of 220 problems still moved it by only 5 points.
   *
   * A geometric mean punishes imbalance, which is the correct behaviour here.
   * Being immaculate on artists and duplicates does not compensate for album data
   * being a mess, because they are different jobs and you have only done three of
   * them. The same four values now score 56 rather than 78.
   *
   * It stays 100 when every bucket is 100, so the "nothing left to fix" invariant
   * below is unaffected.
   */
  const vals = Object.values(subscores);
  let score = Math.round(
    Math.exp(vals.reduce((a, b) => a + Math.log(b), 0) / vals.length));

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


/* ------------------------------------------- D16: singles never re-scrobbled */
/**
 * A track you only ever played as a single, which has since landed on an album.
 *
 * The gap this fills. D4 finds a track sitting under two album names and D0 then
 * picks which one to consolidate into, but both need BOTH halves to exist in the
 * library. If you played the single on release and never played the album version
 * afterwards, there is only one album string, nothing to compare it against, and
 * every detector stays silent. The play is stranded on the single and your album
 * chart never sees it.
 *
 * Answered from Spotify and MusicBrainz, NOT from Last.fm's own `track.getInfo`.
 *
 * track.getInfo looked ideal: it returns Last.fm's canonical album for a track,
 * which is the exact string a re-tag has to match to merge in a Last.fm chart,
 * and it costs one call per candidate rather than eleven per artist. The flaw is
 * that Last.fm's track-to-album mapping is user-contributed. It carries plenty of
 * wrong and invented entries, and it is least reliable precisely where this
 * library is densest, on unreleased material that people tag however they like.
 * Using it as the source of truth would mean telling someone to move real plays
 * onto an album on the word of an anonymous edit.
 *
 * So the authority is the same lookup D0 already uses: Spotify first, MusicBrainz
 * as fallback, both returning release groups in one shape, both curated rather
 * than crowd-edited. The target rule is D0's, unchanged: earliest release group
 * of primary type Album with no Compilation secondary type.
 *
 * Last.fm is still consulted, but only as CORROBORATION, never as the target.
 * Agreement raises confidence; disagreement lowers it and is shown; Last.fm alone
 * still reports, at low confidence and labelled as such, because a weak signal
 * named as weak beats silence when the whole finding is a `review` anyway.
 *
 * Reported as `review` and never scored, deliberately. You did play the single,
 * so that tag is accurate history, and rewriting it is a preference about how you
 * want your chart to read rather than a defect. See `hygieneScore`.
 */

/*
 * No leading `\s*`, and the string is trimmed before matching.
 *
 * With the leading `\s*` this was quadratic: the pattern is unanchored, so the
 * engine tries every start position, and at each one the `\s*` consumes a whole
 * whitespace run before failing. Measured 109ms at 16k characters and 16 SECONDS
 * at 200k, on the main thread, over strings that arrive from other people's
 * libraries. That is the third time this exact shape has appeared in this file.
 *
 * Starting at a literal character class instead makes almost every start position
 * fail in constant time, so only positions actually holding a bracket or dash do
 * any work.
 */
const SINGLE_SUFFIX = /[-–—(\[]\s*(?:single|ep)\s*[)\]]?$/i;

/**
 * Does this album string look like a single rather than an album?
 *
 * Two shapes, both decidable from the library alone with no lookup, which is what
 * keeps the candidate list small enough to be worth spending API calls on:
 *
 *   "Octane"            album string equals the track title
 *   "Octane - Single"   explicitly labelled
 *
 * Deliberately NOT inferred from "this album string has only one track in your
 * library". A real album you have played exactly one track from looks identical
 * by that test, and there are far more of those than there are singles.
 */
export function singleShaped(album, track) {
  if (!album || !track) return false;
  const trimmed = album.trim();
  if (SINGLE_SUFFIX.test(trimmed)) return true;
  // "Octane" as the album of the track "Octane". Compared on the feature-stripped
  // base title so "Octane (feat. Cash Cobain)" still matches the album "Octane".
  const a = norm(trimmed.replace(SINGLE_SUFFIX, ""));
  return Boolean(a) && (a === norm(track) || a === norm(baseTitle(track)));
}

/**
 * Tracks worth asking Last.fm about, most-played first.
 *
 * Returns one entry per (artist, track, album) that looks single-shaped, carrying
 * the play count so a capped budget can be spent where it changes the chart most.
 */
export function d16Candidates(rest, { minPlays = 1 } = {}) {
  const seen = new Map();
  for (const s of rest || []) {
    if (!s.artist || !s.track || !s.album) continue;
    if (!singleShaped(s.album, s.track)) continue;
    const k = `${norm(s.artist)}␟${trackIdentity(s.track)}␟${norm(s.album)}`;
    const cur = seen.get(k) ||
      { artist: s.artist, track: s.track, album: s.album, plays: 0 };
    cur.plays++;
    seen.set(k, cur);
  }
  return [...seen.values()]
    .filter((c) => c.plays >= minPlays)
    .sort((a, b) => b.plays - a.plays);
}

/**
 * Turn resolved canonical albums into findings, grouped by target album.
 *
 * Grouped because ungrouped this floods. Most singles by an album artist end up
 * on an album eventually, so a library of any size produces hundreds of these,
 * and a report of hundreds of one-line cards is one nobody reads. One card per
 * destination album is also the shape of the actual decision: you re-tag a batch
 * of tracks onto one record, not each track in isolation.
 *
 * `lookup(artist, track)` is the SAME function D0 uses, returning
 * `{ groups: [{ title, primary, secondary, first_release }] }`. Sharing it means
 * this detector needs no new network path, no new cache and no new pacing: it
 * rides on the resolution phase that already exists.
 *
 * `owned` is the set of normalised album strings the library already has plays
 * of, which is the difference between a merge and an invention.
 */
export function d16StrandedSingles(
  candidates, lookup, { owned = new Set(), lastfm = null } = {},
) {
  const byTarget = new Map();

  for (const c of candidates || []) {
    const groups = lookup?.(c.artist, c.track)?.groups;

    /*
     * D0's rule, deliberately identical.
     *
     * Earliest release group of primary type Album, excluding compilations. A
     * greatest-hits record technically contains the track, and telling someone to
     * move a single onto a compilation would be worse than saying nothing.
     */
    const albums = (groups || []).filter((g) =>
      g.primary === "Album" && !(g.secondary || []).includes("Compilation"));
    const curated = albums[0]?.title || "";

    // Last.fm's own idea of the canonical album, if we asked and it knew.
    const lfmRaw = lastfm?.(c.artist, c.track)?.title || "";
    // Ignored when it just names the single back at us, which is common.
    const lfm = lfmRaw && norm(lfmRaw) !== norm(c.album) &&
                !singleShaped(lfmRaw, c.track) ? lfmRaw : "";

    if (!curated && !lfm) continue;        // nothing said anything: silent

    /*
     * `norm` already folds case, punctuation and diacritics, so "Life Of A Don"
     * and "Life of a DON" agree here. Only a genuinely different title counts as
     * the two sources disagreeing, which is the case worth being cautious about.
     */
    const agree = Boolean(curated && lfm) && norm(curated) === norm(lfm);
    const source = agree ? "both" : curated ? "curated" : "lastfm";

    /*
     * The curated title is the target whenever there is one.
     *
     * An earlier version preferred Last.fm's spelling when the two agreed, on the
     * theory that its string is what a chart is keyed on. That was wrong by
     * construction: `norm` folds case and punctuation, so the only differences
     * that branch could ever see were the ones it folds, and capitalisation is
     * not something a user can act on anyway. It was a choice between two strings
     * that differ in a way that does not matter, presented as a feature.
     */
    const target = curated || lfm;

    // The album string already IS the album. Nothing stranded.
    if (norm(target) === norm(c.album)) continue;
    // The target is itself single-shaped, so moving changes nothing.
    if (singleShaped(target, c.track)) continue;

    const k = `${norm(c.artist)}␟${norm(target)}`;
    const g = byTarget.get(k) || {
      artist: c.artist,
      album: target,
      released: albums[0]?.first_release || "",
      source,
      disagreed: Boolean(curated && lfm && !agree) ? lfm : "",
      tracks: [],
      plays: 0,
    };
    // A group inherits the WEAKEST evidence of its members, so one Last.fm-only
    // track cannot ride on the confidence earned by a corroborated one.
    if (source === "lastfm" || g.source === "lastfm") g.source = "lastfm";
    else if (source === "curated" || g.source === "curated") g.source = "curated";
    g.tracks.push({ artist: c.artist, track: c.track, album: c.album, plays: c.plays });
    g.plays += c.plays;
    byTarget.set(k, g);
  }

  const issues = [];
  for (const g of byTarget.values()) {
    /*
     * Whether the album is already in the library is the whole confidence story.
     *
     * If it is, your own listening already treats that record as the canonical
     * home and re-tagging merges into an entry you can see. If it is not, the
     * suggestion is to create a chart entry you have never had, off the back of
     * one play of one single, which is a much bigger claim on much less evidence.
     */
    const held = owned.has(norm(g.album));
    const n = g.tracks.length;

    /*
     * ONE table, keyed on both dimensions at once.
     *
     * Confidence here depends on two independent things: which sources agree, and
     * whether the album is already in the library. Expressed as two separate
     * ternary ladders they drifted apart and produced a `review` at 90%
     * confidence, which is how the D4 contradiction happened. A table cannot do
     * that, and it makes the reasoning readable in one glance.
     *
     * `lastfm|held` is not as weak as it looks: Last.fm's mapping is
     * user-editable, but the library ALREADY holding that album is independent
     * corroboration that the record is real and associated with this artist.
     */
    const EVIDENCE = {
      "both|true":     { confidence: 0.80, note: "Release data and Last.fm agree" },
      "both|false":    { confidence: 0.50, note: "Release data and Last.fm agree" },
      "curated|true":  { confidence: 0.70, note: "From release data" },
      "curated|false": { confidence: 0.35, note: "From release data" },
      "lastfm|true":   { confidence: 0.45, note: "From Last.fm only" },
      "lastfm|false":  { confidence: 0.20, note: "From Last.fm only" },
    };
    const ev = EVIDENCE[`${g.source}|${held}`];

    issues.push({
      detector: "D16",
      class: "review",
      style_choice: true,             // accurate history, not a defect
      confidence: ev.confidence,
      artist: g.artist,
      album: g.album,
      plays_affected: g.plays,
      /*
       * Never fed to chartImpact when the album is not already held.
       *
       * Adding plays to an album the library has no entry for invents a chart
       * position out of nothing, which is exactly the phantom merge target that
       * had Graduation's plays moving to a destination the user could not see.
       */
      chart_already_correct: !held,
      title: `${n} track${n === 1 ? "" : "s"} you only played as a single ` +
             `${n === 1 ? "is" : "are"} on '${g.album}'`,
      released: g.released,
      suggest:
        `${n === 1 ? "This track appears" : "These tracks appear"} on ` +
        `'${g.album}'${g.released ? ` (${g.released})` : ""}, but your ` +
        `${g.plays} play${g.plays === 1 ? "" : "s"} ` +
        `sit${g.plays === 1 ? "s" : ""} under the single instead, so the album ` +
        `never gets ${n === 1 ? "it" : "them"}. ` +
        (held
          ? `You already have plays on '${g.album}', so re-tagging merges into ` +
            `the entry you can see.`
          : `You have no plays on '${g.album}' yet, so this would create a new ` +
            `chart entry rather than merge into one. Worth doing only if you ` +
            `consider the album the real home for ${n === 1 ? "it" : "them"}.`) +
        ` Nothing here is wrong as history: you did play the single. This is ` +
        `about how you want the chart to read.` +
        (g.source === "lastfm"
          ? ` Worth knowing that this one comes from Last.fm's own album data, ` +
            `which anyone can edit, and no release database confirmed it. Treat ` +
            `it as a hint rather than a fact.`
          : "") +
        (g.disagreed
          ? ` Last.fm calls this album '${g.disagreed}' instead, so check which ` +
            `spelling your library already uses before re-tagging.`
          : ""),
      // Named so the reader can weigh it rather than having to trust a number.
      evidence: ev.note,
      evidence_source: g.source,
      members: g.tracks
        .sort((a, b) => b.plays - a.plays)
        .map((t) => ({ artist: t.artist, track: t.track, plays: t.plays,
                       looks_like: `tagged '${t.album}'` })),
    });
  }
  return issues.sort((a, b) => b.plays_affected - a.plays_affected);
}

/**
 * Every detector that can appear in a report must score somewhere.
 *
 * Checked at import time because the failure it prevents is silent: an
 * unbucketed detector does not error, it just never affects the score, which is
 * exactly the D14e bug that shipped. Cheap enough to run always.
 */
export const SCORED_DETECTORS = new Set(Object.values(BUCKETS).flat());

/*
 * D16 is deliberately in no bucket.
 *
 * It is always `review` and always `style_choice`, both of which weigh zero, so
 * bucketing it could not change a score even if it were listed. Naming the
 * omission here because the last unbucketed detector was an ACCIDENT (D14e scored
 * nothing at all and nobody noticed), and the test that guards against that
 * cannot tell a deliberate exclusion from a forgotten one unless it is written
 * down.
 *
 * The rule: a detector belongs in a bucket if it can ever emit `error` or
 * `split`. D16 cannot, because playing a single is not a defect.
 */
export const UNSCORED_BY_DESIGN = new Set(["D16"]);

/* --------------------------------------------------------- orchestration */

export function analyse(scrobbles, { official, topAlbums } = {}) {
  const total = scrobbles.length;
  // guard first, always. `official` lets verified real releases out of the
  // protected partition so they get checked for splits like any other album.
  const { era, rest } = partitionEra(scrobbles, { official });

  const splits = d4AlbumSplits(rest);
  const issues = [
    ...d14aFormatVariants(era),
    ...d14cTrackInTwoEras(era),
    ...d14fSingleBucket(era, { rest }),
    ...splits,
    ...d8FeatureCredits(rest),
    ...d1ArtistVariants(rest),
    ...d5MissingAlbum(rest),
    ...d6Duplicates(scrobbles),
    ...d11VariousArtists(rest),
    ...d12Impossible(scrobbles),
    // Needs the album chart, which carries the album artist. Absent when the
    // caller could not fetch it, in which case this simply contributes nothing.
    ...d15AlbumArtistSplits(topAlbums || []),
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

  issues.sort(byImportance);

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
