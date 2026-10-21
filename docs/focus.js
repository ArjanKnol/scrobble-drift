/**
 * Focus a report on one artist.
 *
 * Asked for on launch night: "I care about some artists more than others." A
 * whole-library report mixes the five artists someone lives in with hundreds
 * they played once, and the second group dominates by count. Focusing narrows
 * BOTH the findings and the lookups to one artist, so it is also cheaper.
 *
 * Works on scrobbles already in hand. It never refetches: the scan range still
 * decides how far back the history goes, so an artist's full history needs an
 * entire-history scan or a CSV import.
 */
import { norm } from "./drift.js";

const key = (s) => norm(s || "", { dropThe: true });

/*
 * Only the separators that clearly introduce a SECOND artist. A bare "&" or ","
 * is deliberately not here: "Simon & Garfunkel" and "Earth, Wind & Fire" are one
 * act, and splitting them would credit their plays to Simon and to Earth.
 */
const GUEST = /\s+(?:feat\.?|ft\.?|featuring|w\/)\s+/i;

/** The lead credit of an artist field: "A feat. B" is A. */
export function leadArtist(artist) {
  return String(artist || "").split(GUEST)[0].trim();
}

/** A predicate selecting one artist's scrobbles, tolerant of case, accents and "The". */
export function artistMatcher(name) {
  const want = key(name);
  if (!want) return () => true;
  return (s) => key(s?.artist) === want || key(leadArtist(s?.artist)) === want;
}

/**
 * The most played artists, with the spelling used most often for each.
 *
 * Grouped on the normalised lead credit, so "Beyoncé" and "Beyonce" are one row
 * here even though the report may flag them as a split. The overview answers
 * "who do I listen to", not "how is it spelled".
 */
export function topArtists(scrobbles, n = 25) {
  const groups = new Map();
  for (const s of scrobbles || []) {
    const lead = leadArtist(s?.artist);
    const k = key(lead);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { plays: 0, names: new Map() });
    g.plays++;
    g.names.set(lead, (g.names.get(lead) || 0) + 1);
  }
  return [...groups.values()]
    .map((g) => ({
      artist: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      plays: g.plays,
    }))
    .sort((a, b) => b.plays - a.plays || a.artist.localeCompare(b.artist))
    .slice(0, n);
}

/** Close matches for a name that found nothing, for a "did you mean". */
export function suggestArtists(name, scrobbles, n = 3) {
  const want = key(name);
  if (!want) return [];
  return topArtists(scrobbles, Infinity)
    .filter((a) => {
      const k = key(a.artist);
      return k.includes(want) || want.includes(k);
    })
    .slice(0, n)
    .map((a) => a.artist);
}

/** Count findings per artist, keyed the same way as topArtists. */
export function findingsByArtist(issues) {
  const out = new Map();
  for (const i of issues || []) {
    const k = key(leadArtist(i?.artist));
    if (k) out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

export { key as artistKey };
