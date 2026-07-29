"""Detection logic for Scrobble Drift.

Everything here is a pure function over a list of scrobble dicts:

    {"uts": int, "artist": str, "artist_mbid": str,
     "album": str, "album_mbid": str, "track": str, "track_mbid": str}

No I/O, no database, no framework. That is deliberate: this module is the
actual asset and it needs to run unchanged on a GitHub Action today and in a
Cloudflare Worker later.

Issue classes:
    error     objectively wrong
    split     one thing recorded as several, distorts stats
    review    arguably legitimate, user's call
    unfixable real, but Last.fm cannot change it
    anomaly   points at a misconfigured scrobbler, not one bad record
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from typing import Any, Callable, Iterable

Scrobble = dict[str, Any]
Issue = dict[str, Any]

# --------------------------------------------------------------------------
# normalisation
# --------------------------------------------------------------------------

_APOSTROPHES = dict.fromkeys(map(ord, "‘’ʼ`´"), "'")
_PUNCT = re.compile(r"[^\w\s']", re.UNICODE)
_WS = re.compile(r"\s+")


def norm(text: str, *, drop_the: bool = False) -> str:
    """Loose key, for whether two names are the SAME THING spelled differently.

    Strips diacritics, so "Jaÿ-Z" and "Jay-Z" match. Do NOT use this to
    establish identity -- see norm_title().
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text).translate(_APOSTROPHES)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = _PUNCT.sub(" ", text.lower())
    text = _WS.sub(" ", text).strip()
    if drop_the and text.startswith("the "):
        text = text[4:]
    return text


def norm_title(text: str) -> str:
    """Strict key, for whether two titles are the SAME TRACK.

    Identical to norm() except diacritics are PRESERVED, because artists use
    them deliberately. Yeat has both "Back Home" and "Back Homë"; they are
    different songs. Folding accents away merged them and produced a confident
    recommendation to consolidate two unrelated tracks.

    The lesson generalises: normalisation for fuzzy matching should be
    aggressive, normalisation for identity must be conservative. Using one
    function for both was the bug.

    NFC rather than NFKD so a precomposed "ë" and a decomposed "e" + combining
    diaeresis compare equal, without discarding the mark.

    Kept identical to normTitle() in docs/drift.js.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text).translate(_APOSTROPHES)
    text = _PUNCT.sub(" ", text.lower())
    return _WS.sub(" ", text).strip()


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def edit_distance(a: str, b: str, max_d: int = 2) -> int:
    """Levenshtein distance, abandoned early once it exceeds `max_d`.

    Needed because the similarity ratio alone cannot catch a single-character
    typo in a short name: 2M/(n+m) for 'yeat' vs 'teat' is 0.75, well under the
    0.9 threshold. Measured behaviour of a one-character typo by name length:

        'Sef' / 'Sez'                  0.667  missed
        'Yeat' / 'Teat'                0.750  missed
        'Woop' / 'Wopp'                0.750  missed
        'Gunna' / 'Gunnna'             0.909  caught
        'Playboi Carti' / '...Cartii'  0.963  caught

    So the ratio only works from roughly ten characters up. Short artist names
    are common, and a whole class of real typos was invisible.
    """
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_d:
        return max_d + 1
    if not a:
        return len(b)
    if not b:
        return len(a)

    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1,
                           cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        if min(cur) > max_d:
            return max_d + 1
        prev = cur
    return prev[len(b)]


def typo_budget(a: str, b: str) -> int:
    """Typo allowance scaled to name length: one char short, two long."""
    return max(1, max(len(a), len(b)) // 10)


# --------------------------------------------------------------------------
# era-tagged unreleased material (D14) -- runs FIRST, as a guard
# --------------------------------------------------------------------------

ERA_ALBUM = re.compile(
    r"unreleased|\(\s*[^)]*\bera\b[^)]*\)|\bleak(?:ed)?\b|\bsnippet\b"
    r"|\bOG\s*file\b|\bref(?:erence)?\s*track\b|\bCDQ\b",
    re.IGNORECASE,
)
ERA_NAME = re.compile(r"\(\s*(?P<era>[^)]*?)\s*era\s*\)", re.IGNORECASE)


def is_era_tagged(album: str) -> bool:
    return bool(album) and bool(ERA_ALBUM.search(album))


def era_name(album: str) -> str | None:
    m = ERA_NAME.search(album or "")
    return m.group("era").strip() if m else None


def partition_era(scrobbles: Iterable[Scrobble]) -> tuple[list[Scrobble], list[Scrobble]]:
    """Split into (protected era-tagged, everything else).

    Critical: the protected set must be excluded from D0, D4, D1 and D13.
    Those detectors would otherwise recommend consolidating deliberately
    distinct unreleased material into official releases, or flag every leak as
    a typo because it has no external database entry. Confidently damaging a
    carefully maintained taxonomy is the worst outcome available to this tool.
    """
    era, rest = [], []
    for s in scrobbles:
        (era if is_era_tagged(s["album"]) else rest).append(s)
    return era, rest


def d14_era_overview(era: list[Scrobble], total_plays: int) -> dict[str, Any]:
    albums = Counter(f'{s["artist"]}␟{s["album"]}' for s in era)
    eras_by_artist: dict[str, Counter] = defaultdict(Counter)
    for s in era:
        name = era_name(s["album"])
        if name:
            eras_by_artist[s["artist"]][name] += 1
    return {
        "plays": len(era),
        "share_of_all_plays": round(100 * len(era) / total_plays, 2) if total_plays else 0,
        "album_strings": len(albums),
        "artists": len(eras_by_artist),
        "distinct_eras": sum(len(v) for v in eras_by_artist.values()),
        "top_albums": [
            {"key": k, "plays": n} for k, n in albums.most_common(25)
        ],
        "eras_per_artist": {
            a: sorted(c) for a, c in
            sorted(eras_by_artist.items(), key=lambda kv: -sum(kv[1].values()))[:25]
        },
    }


def d14a_format_variants(era: list[Scrobble]) -> list[Issue]:
    """Inconsistent spelling of the user's own era convention.

    Compares whole album strings per artist rather than just the extracted era
    name. That matters: the era-name regex discards the literal "Era" token, so
    comparing names alone silently misses `(EALL era)` against `(EALL Era)` --
    which is exactly the deviation that shows up in real libraries.

    Casing-only differences are skipped: Last.fm cannot change the casing of a
    name, so telling someone to fix one is worse than staying quiet.
    """
    issues: list[Issue] = []
    albums: dict[str, Counter] = defaultdict(Counter)
    names: dict[str, Counter] = defaultdict(Counter)
    for s in era:
        albums[s["artist"]][s["album"]] += 1
        name = era_name(s["album"])
        if name:
            names[s["artist"]][name] += 1

    # (a) whole-string variants: brackets and spacing. Casing-only is skipped.
    for artist, strings in albums.items():
        buckets: dict[str, list[str]] = defaultdict(list)
        for raw in strings:
            buckets[norm(raw)].append(raw)
        for group in buckets.values():
            if len(group) < 2:
                continue
            ranked = sorted(group, key=lambda x: -strings[x])
            # Casing-only differences are skipped entirely. Last.fm cannot
            # change the casing of a name, so there is nothing to act on, and a
            # report padded with impossible work is worse than a shorter honest
            # one. Same reason D7 is not run.
            if len({g.lower() for g in group}) == 1:
                continue
            issues.append({
                "detector": "D14a",
                "class": "split",
                "confidence": 0.95,
                "artist": artist,
                "title": f"Era tag written {len(group)} ways for {artist}: "
                         + ", ".join(repr(g) for g in ranked),
                "plays_affected": sum(strings[g] for g in group),
                "suggest": f"standardise on '{ranked[0]}' "
                           f"({strings[ranked[0]]} plays).",
                "members": [{"album": g, "plays": strings[g]} for g in ranked],
            })

    # (b) probable typos in the era name itself, scoped to one artist so the
    # candidate set stays tiny and closed.
    #
    # The similarity floor is 0.82 rather than 0.90 because transpositions --
    # the most common typing error -- score low: 'Yandhi' against 'Yhandi' is
    # only 0.83. A loose floor alone would be noisy, so it is paired with a
    # play-count asymmetry requirement: a typo gets scrobbled a handful of
    # times, whereas two genuinely different eras tend to have comparable
    # counts. Both conditions must hold.
    for artist, counts in names.items():
        seen = list(counts)
        for i, a in enumerate(seen):
            for b in seen[i + 1:]:
                if norm(a) == norm(b) or similar(norm(a), norm(b)) < 0.82:
                    continue
                lo, hi = sorted((a, b), key=lambda n: counts[n])
                if counts[lo] > max(2, 0.25 * counts[hi]):
                    continue        # comparable usage: probably both real
                sequel = _differs_only_by_version(lo, hi)
                issues.append({
                    "detector": "D14a",
                    # Sequel-vs-typo cannot be decided from play counts. Marked
                    # so the MusicBrainz pass can settle it with evidence: if
                    # both era names exist as real release groups they are
                    # separate projects and the finding is dropped. See
                    # verify_era_names(). Key omitted entirely when not needed,
                    # matching the JS build, which drops undefined on serialise.
                    **({"verify": {"artist": artist, "a": lo, "b": hi}}
                       if sequel else {}),
                    # A trailing number or version token means these are very
                    # likely distinct projects, not a misspelling: 'Drip Season'
                    # and 'Drip Season 3' are two different Gunna tapes. Play
                    # count asymmetry cannot tell them apart from a typo, so
                    # downgrade to a review item rather than assert an error.
                    "class": "review" if sequel else "error",
                    "confidence": 0.35 if sequel else 0.7,
                    "artist": artist,
                    "title": (f"Similar era names for {artist}: '{lo}' vs '{hi}'"
                              if sequel else
                              f"Probable era-name typo for {artist}: "
                              f"'{lo}' vs '{hi}'"),
                    "plays_affected": counts[lo] + counts[hi],
                    "suggest": (
                        f"these differ only by a version or sequel marker, so "
                        f"they are probably separate projects rather than a "
                        f"typo. Checking MusicBrainz to confirm. "
                        f"'{hi}' has {counts[hi]} plays, '{lo}' has {counts[lo]}."
                        if sequel else
                        f"'{hi}' has {counts[hi]} plays against "
                        f"{counts[lo]}, so '{lo}' is likely the typo."
                    ),
                    "members": [{"era": n, "plays": counts[n]} for n in (lo, hi)],
                })
    return issues


_VERSION_TAIL = re.compile(
    r"\s*(?:v\.?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?|og|alt|final|deluxe|pt\.?\s*\d+)$",
    re.IGNORECASE,
)


def era_verification_plan(issues: list[Issue]) -> list[dict[str, str]]:
    """Era-name pairs awaiting a MusicBrainz ruling, flattened to lookups."""
    jobs: dict[str, dict[str, str]] = {}
    for i in issues:
        v = i.get("verify")
        if not v:
            continue
        for title in (v["a"], v["b"]):
            jobs[f'{v["artist"]}␟{title}'.lower()] = {
                "artist": v["artist"], "title": title,
            }
    return list(jobs.values())


def verify_era_names(issues: list[Issue],
                     exists: Callable[[str, str], bool]) -> list[Issue]:
    """Settle sequel-vs-typo era pairs with MusicBrainz instead of guessing.

    Play-count asymmetry cannot tell 'Drip Season' and 'Drip Season 3' (two real
    Gunna tapes) apart from 'Yandhi' and 'Yhandi' (a typo). Asking whether each
    name exists as a release group can.

    `exists(artist, title)` must be true only on an EXACT title match after
    normalisation. MusicBrainz search is fuzzy and returns 'Drip Season 3' when
    asked for 'Drip Season', so counting results would confirm everything.

    Honest caveat: absence from MusicBrainz is weak evidence, because era names
    routinely refer to projects that were never released and so have no release
    group at all. Only the asymmetric case is promoted to an error.

    Kept identical to verifyEraNames() in docs/drift.js.
    """
    out: list[Issue] = []
    for issue in issues:
        v = issue.get("verify")
        if not v:
            out.append(issue)
            continue
        artist, a, b = v["artist"], v["a"], v["b"]
        has_a, has_b = bool(exists(artist, a)), bool(exists(artist, b))

        if has_a and has_b:
            continue                    # both real projects, not worth a word

        base = {k: val for k, val in issue.items() if k != "verify"}
        if has_b and not has_a:
            out.append({**base, "class": "error", "confidence": 0.85,
                        "title": f"Era name not found in MusicBrainz for "
                                 f"{artist}: '{a}'",
                        "suggest": f"'{b}' exists as a real release for "
                                   f"{artist}; '{a}' does not. Likely a typo or "
                                   f"a wrong era name."})
        elif has_a and not has_b:
            out.append({**base, "class": "review", "confidence": 0.4,
                        "suggest": f"'{a}' exists as a real release for "
                                   f"{artist} but '{b}' does not, which is the "
                                   f"opposite of what a typo looks like. Worth "
                                   f"a look."})
        else:
            out.append({**base, "confidence": 0.3,
                        "suggest": f"neither '{a}' nor '{b}' exists as a "
                                   f"release in MusicBrainz, which is normal "
                                   f"for unreleased projects. Cannot tell a "
                                   f"sequel from a typo here, so this is "
                                   f"informational only."})
    return out


def _differs_only_by_version(a: str, b: str) -> bool:
    """True when two names are identical once a trailing version token is cut.

    Catches sequels ('Drip Season' / 'Drip Season 3'), numbered versions
    ('Luv Is Rage' / 'Luv Is Rage 2') and leak-scene markers
    ('Eternal Atake v1' / 'Eternal Atake OG'), all of which are routinely
    distinct releases rather than typos of each other.
    """
    sa, sb = _VERSION_TAIL.sub("", a).strip(), _VERSION_TAIL.sub("", b).strip()
    return norm(sa) == norm(sb) and (sa != a or sb != b)


def d14c_track_in_two_eras(era: list[Scrobble]) -> list[Issue]:
    """One track title filed under several eras.

    NOT an error. An earlier version of this claimed "one of these eras is
    wrong", which is simply false: songs routinely survive across album eras.
    They get recorded for one project, held back, reworked, and considered again
    for a later one. Kanye tracks in particular move between projects
    constantly, so a title appearing under both BULLY and Cuck is legitimate.

    What IS worth surfacing is that the two entries are indistinguishable in the
    listener's own data. If they are different versions, the track titles could
    say so; if they are the same file, one era tag is redundant. Both are the
    listener's call, so this is review and never an error.
    """
    # Grouped on the normalised track title, but the ORIGINAL spelling is kept
    # for display. Showing the normalised form leaked lowercased track names
    # into the report ("all the love" instead of "All the love").
    where: dict[tuple[str, str], dict[str, Any]] = {}
    for s in era:
        name = era_name(s["album"])
        if not name:
            continue
        k = (s["artist"], norm_title(s["track"]))
        rec = where.setdefault(k, {"track": s["track"], "eras": Counter()})
        rec["eras"][name] += 1

    issues: list[Issue] = []
    for (artist, _key), rec in where.items():
        track_key, eras = rec["track"], rec["eras"]
        if len(eras) < 2:
            continue
        # A version marker makes a carried-over song likelier still, so it is
        # reported with lower confidence.
        versioned = any(re.search(r"\bv\d+\b", e, re.I) for e in eras)
        issues.append({
            "detector": "D14c", "class": "review",
            "confidence": 0.3 if versioned else 0.45,
            "artist": artist,
            "title": f"{artist} - '{track_key}' is filed under {len(eras)} "
                     f"eras: " + ", ".join(sorted(eras)),
            "plays_affected": sum(eras.values()),
            "suggest": (
                "Often legitimate: songs get held back and reworked across "
                "projects, so the same title can genuinely belong to more than "
                "one era"
                + (", and a version marker here makes that likelier"
                   if versioned else "")
                + ". Nothing to fix if that is the case. If these are different "
                  "versions, consider putting that in the track title so the "
                  "two are distinguishable. If they are the same file, one era "
                  "tag is redundant."
            ),
            "members": [{"era": e, "plays": n} for e, n in eras.most_common()],
        })
    return issues


def d14e_released_since(era: list[Scrobble], resolve: Callable[[str, str], Any]
                        ) -> list[Issue]:
    """Unreleased material that now has an official release.

    The most rewarding check here: it tells you something you want to know as a
    fan, not as a librarian. Deliberately does NOT recommend consolidation. A
    leak is frequently a different recording from the official release, so the
    pre/post split may be correct rather than accidental.

    Title matching is weaker here than anywhere else: leaks circulate under
    working titles and get released under different ones, with no duration or
    fingerprint fallback. Precision over recall, always "verify".
    """
    tracks: dict[tuple[str, str], dict[str, Any]] = {}
    for s in era:
        key = (s["artist"], s["track"])
        rec = tracks.setdefault(key, {"plays": 0, "first": s["uts"],
                                      "last": s["uts"], "eras": Counter()})
        rec["plays"] += 1
        rec["first"] = min(rec["first"], s["uts"])
        rec["last"] = max(rec["last"], s["uts"])
        name = era_name(s["album"])
        if name:
            rec["eras"][name] += 1

    issues: list[Issue] = []
    # Busiest first, so a capped budget is spent where it matters most.
    for (artist, track), rec in sorted(tracks.items(),
                                       key=lambda kv: -kv[1]["plays"]):
        found = resolve(artist, track)
        if not found:
            continue
        official = [
            g for g in found.get("groups", [])
            if g.get("status") == "Official"
            and g.get("primary") in {"Album", "Single", "EP"}
            and "Bootleg" not in (g.get("secondary") or [])
        ]
        if not official:
            continue
        best = official[0]
        issues.append({
            "detector": "D14e", "class": "split", "confidence": 0.45,
            "artist": artist,
            "title": f"Possibly released since: {artist} - {track}",
            "plays_affected": rec["plays"],
            "suggest": (
                f"An official {best['primary']} '{best['title']}' "
                f"({best.get('first_release') or 'date unknown'}) contains a "
                f"recording with this title. Verify it is the same version "
                f"before doing anything: the leak may be a different mix. "
                f"Your plays run {_d(rec['first'])} to {_d(rec['last'])}."
            ),
            "members": [{"era": e, "plays": n} for e, n in rec["eras"].most_common()],
            "external": best,
            "no_auto_action": True,
        })
    return issues


def _d(uts: int) -> str:
    import datetime as _dt
    return _dt.datetime.utcfromtimestamp(uts).strftime("%b %Y")


# --------------------------------------------------------------------------
# album splits (D4) and canonical resolution (D0)
# --------------------------------------------------------------------------

EDITION = re.compile(
    r"\s*[\(\[\-]\s*(deluxe|expanded|remaster(?:ed)?|anniversary|bonus"
    r"|special|complete|extended|super\s*deluxe|japanese|uk|us|explicit"
    r"|clean|alternate)\b[^\)\]]*[\)\]]?\s*$",
    re.IGNORECASE,
)
COMPILATION = re.compile(
    r"greatest\s+hits|best\s+of|\bhits\b|anthology|collection|compilation"
    r"|now\s+that'?s\s+what\s+i\s+call|essential|retrospective",
    re.IGNORECASE,
)


def d4_album_splits(rest: list[Scrobble], min_plays: int = 2) -> list[Issue]:
    """One track's plays spread across several album strings.

    Finds splits. D0 resolves them. Feeds D0 its candidate list.
    """
    groups: dict[tuple[str, str], dict[str, Any]] = defaultdict(
        lambda: {"albums": Counter(), "first": {}, "last": {}, "track": ""}
    )
    for s in rest:
        g = groups[(norm(s["artist"]), norm_title(s["track"]))]
        album = s["album"] or "(no album)"
        g["albums"][album] += 1
        g["first"][album] = min(g["first"].get(album, s["uts"]), s["uts"])
        g["last"][album] = max(g["last"].get(album, s["uts"]), s["uts"])
        g["track"] = g["track"] or s["track"]
        g["artist"] = s["artist"]

    issues: list[Issue] = []
    for (_, _), g in groups.items():
        albums = g["albums"]
        if len(albums) < 2 or sum(albums.values()) < min_plays:
            continue
        members = [
            {"album": a, "plays": n,
             "first": g["first"][a], "last": g["last"][a],
             "looks_like": _classify_album_string(a, g["track"])}
            for a, n in albums.most_common()
        ]
        structural = is_structural_title(g["track"])
        temporal = _temporal_signature(members, g["track"])
        migration = bool(temporal and temporal["migration"])

        issues.append({
            "detector": "D4",
            # A structural title almost certainly means several distinct tracks,
            # so it is a question rather than a finding.
            "class": "review" if structural else "split",
            "confidence": 0.25 if structural else (0.9 if migration else 0.7),
            "artist": g["artist"],
            # Carried as structured fields, never re-parsed out of `title`.
            # Doing that broke on any track containing an apostrophe.
            "track": g["track"],
            "title": (
                f"{g['artist']} - '{g['track']}' appears on {len(albums)} albums"
                if structural else
                f"{g['artist']} - '{g['track']}' split across "
                f"{len(albums)} album strings"
            ),
            "plays_affected": sum(albums.values()),
            "suggest": (
                f"'{g['track']}' is a structural track title, so these are "
                f"almost certainly different recordings, one per album, rather "
                f"than one track split in two. Nothing to fix unless you know "
                f"otherwise."
                if structural else
                "candidate for consolidation, see D0 for the target"
            ),
            "members": members,
            # The temporal note is suppressed for structural titles: the
            # chronology is real but says nothing useful about two albums.
            "temporal": None if structural else temporal,
        })
    return sorted(issues, key=lambda i: -i["plays_affected"])


def _classify_album_string(album: str, track: str) -> str:
    if album == "(no album)":
        return "missing"
    if norm_title(album) == norm_title(track):
        return "single (album titled after the track)"
    if re.search(r"\s*[-–]\s*(single|ep)$", album, re.I):
        return "single or EP"
    if COMPILATION.search(album):
        return "compilation"
    if EDITION.search(album):
        return "edition variant"
    return "album"


STRUCTURAL_TITLE = re.compile(
    r"^(intro|outro|interlude|skit|prelude|epilogue|intermission|reprise"
    r"|untitled|hidden track|bonus track|instrumental)\s*\d*$",
    re.IGNORECASE,
)


def is_structural_title(track: str) -> bool:
    """Track titles that recur across an artist's albums by design.

    "Intro" on one album and "Intro" on another are two different recordings,
    not one track split in two. Grouping on artist plus title cannot tell them
    apart, so these are handled separately rather than reported as splits.
    """
    return bool(STRUCTURAL_TITLE.match(norm_title(track)))


def _plausible_pre_release(earlier: str, later: str, track: str) -> bool:
    """Could `earlier` be a pre-album release of this track?

    A clean chronological handover is not by itself evidence of a single being
    absorbed into an album: two unrelated albums played in sequence produce the
    same shape. J. Cole's "Intro" on Cole World and on the 2014 Forest Hills
    Drive anniversary edition looked like a textbook migration and is nothing of
    the kind.
    """
    e, l, t = norm_title(earlier), norm_title(later), norm_title(track)
    if not e or not l:
        return False
    if e == t or t in e:                                   # single named for the track
        return True
    if re.search(r"\s[-–]\s(single|ep)$", earlier, re.I):   # explicitly a single/EP
        return True
    if e in l or l in e:                                   # edition of the same album
        return True
    return similar(norm(earlier), norm(later)) >= 0.60      # near-identical titles


def _temporal_signature(members: list[dict[str, Any]],
                        track: str) -> dict[str, Any] | None:
    """Detect the single-to-album migration pattern.

    The chronology is provable: if all plays of string A predate all plays of
    string B, the track moved between releases at a point in time. But the
    CAUSAL claim needs more than chronology, so it is only made when the earlier
    string plausibly looks like a pre-album release.
    """
    if len(members) != 2:
        return None
    a, b = sorted(members, key=lambda m: m["first"])
    if a["last"] > b["first"]:
        return None

    migration = _plausible_pre_release(a["album"], b["album"], track)
    return {
        "pattern": "clean_handover" if migration else "sequential_unrelated",
        "migration": migration,
        "earlier": a["album"], "later": b["album"],
        "boundary": b["first"],
        "note": (
            (f"every play of '{a['album']}' predates every play of "
             f"'{b['album']}'. Classic single-absorbed-into-album migration "
             f"around {_d(b['first'])}.")
            if migration else
            # Same chronology, no causal claim.
            (f"every play of '{a['album']}' predates every play of "
             f"'{b['album']}' ({_d(b['first'])}), but the two look like "
             f"different releases rather than one absorbing the other.")
        ),
    }


def d0_resolve(splits: list[Issue], resolve: Callable[[str, str], Any]) -> list[Issue]:
    """Pick a consolidation target for each split using MusicBrainz.

    Target = earliest release group of primary type Album without a
    Compilation secondary type. That resolves singles forward into their album
    and compilations back to the original studio release, which are opposite
    directions handled by one rule.
    """
    out: list[Issue] = []
    for issue in splits:
        # Use the structured field. Previously this parsed the track name out of
        # the human-readable title by splitting on apostrophes, which returned
        # garbage for any track containing one -- "I CAN'T WAIT" became
        # "T WAIT" and resolved against the wrong recording entirely.
        track = issue.get("track") or ""
        if not track:
            continue
        found = resolve(issue["artist"], track)
        if not found or not found.get("groups"):
            continue
        groups = found["groups"]
        albums = [g for g in groups
                  if g.get("primary") == "Album"
                  and "Compilation" not in (g.get("secondary") or [])]
        target = (albums or groups)[0]
        out.append({
            **issue,
            "detector": "D0",
            "confidence": 0.9 if issue.get("temporal") else 0.75,
            "suggest": (
                f"consolidate to '{target['title']}' "
                f"({target.get('primary')}, "
                f"{target.get('first_release') or 'date unknown'})"
            ),
            "external": target,
            "candidates": groups[:8],
        })
    return out


# --------------------------------------------------------------------------
# feature credits (D8)
# --------------------------------------------------------------------------

# Only strips a BRACKETED trailing credit. An unbracketed "with" appears in
# real titles ("Dancing With Myself", "With You"), and merging genuinely
# different songs is the worst failure this tool can produce.
FEAT_SUFFIX = re.compile(
    r"\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with|w/)\s+[^\)\]]*[\)\]]\s*$",
    re.IGNORECASE,
)
ARTIST_FEAT = re.compile(
    r"\s+(?:feat\.?|ft\.?|featuring|with|w/|,|&|\bx\b)\s+", re.IGNORECASE
)


def base_title(track: str) -> str:
    prev = None
    out = track or ""
    while out != prev:
        prev = out
        out = FEAT_SUFFIX.sub("", out).strip()
    return out


def d8_feature_credits(rest: list[Scrobble]) -> list[Issue]:
    issues: list[Issue] = []

    # (a) same track, title sometimes carrying the credit and sometimes not.
    variants: dict[tuple[str, str], dict[str, Any]] = {}
    for s in rest:
        k = (norm(s["artist"]), norm_title(base_title(s["track"])))
        v = variants.setdefault(k, {"artist": s["artist"], "titles": Counter()})
        v["titles"][s["track"]] += 1
    for v in variants.values():
        artist, titles = v["artist"], v["titles"]
        if len(titles) < 2:
            continue
        canonical = titles.most_common(1)[0][0]
        issues.append({
            "detector": "D8", "class": "split", "confidence": 0.8,
            # The artist is carried AND named in the title. Without it the
            # report said things like "'Make It Work' scrobbled under 2 title
            # variants", which does not identify whose track it is, and left the
            # issue with no artist for the library deep links to use.
            "artist": artist,
            "track": canonical,
            "title": f"{artist} - '{base_title(canonical)}' scrobbled under "
                     f"{len(titles)} title variants",
            "plays_affected": sum(titles.values()),
            "suggest": f"standardise on '{canonical}' "
                       f"({titles[canonical]} plays). Check MusicBrainz for "
                       f"the official credit style before assuming 'feat.': "
                       f"many releases use 'with'.",
            "members": [{"track": t, "plays": n} for t, n in titles.most_common()],
        })

    # (b) artist field polluted with the feature. Worse than an album split:
    # it invents a phantom artist that competes with the real one and steals
    # plays from the artist chart.
    counts = Counter(s["artist"] for s in rest)
    primaries = {norm(a) for a in counts if not ARTIST_FEAT.search(a)}
    for artist, n in counts.items():
        if not ARTIST_FEAT.search(artist):
            continue
        head = ARTIST_FEAT.split(artist)[0].strip()
        if norm(head) in primaries and norm(head) != norm(artist):
            issues.append({
                "detector": "D8", "class": "error", "confidence": 0.9,
                "artist": artist,
                "title": f"Artist field contains a feature credit: '{artist}'",
                "plays_affected": n,
                "suggest": (f"artist should be '{head}', with the feature moved "
                            f"into the track title. This phantom artist is "
                            f"competing with '{head}' in your artist chart."),
                "members": [{"artist": artist, "plays": n},
                            {"artist": head, "plays": counts.get(head, 0)}],
            })
    return sorted(issues, key=lambda i: -i["plays_affected"])


# --------------------------------------------------------------------------
# string-similarity and duplicate family (D1, D3, D5, D6, D7, D11, D12)
# --------------------------------------------------------------------------

def d1_artist_variants(rest: list[Scrobble]) -> list[Issue]:
    """Near-duplicate artist names.

    Fuzzy matches are gated on a shared track title: the same artist misspelled
    will share tracks, two different artists will not. Without that gate this
    detector produces confident nonsense.
    """
    plays = Counter(s["artist"] for s in rest)
    tracks: dict[str, set[str]] = defaultdict(set)
    for s in rest:
        tracks[s["artist"]].add(norm_title(s["track"]))

    buckets: dict[str, list[str]] = defaultdict(list)
    for artist in plays:
        buckets[norm(artist, drop_the=True)].append(artist)

    issues: list[Issue] = []
    seen: set[frozenset[str]] = set()

    for key, names in buckets.items():
        if len(names) > 1:
            # Casing-only groups belong to D7, which owns the unfixable bucket.
            # Reporting them here too just pads the list with the same finding.
            if len({n.lower() for n in names}) == 1:
                continue
            issues.append(_variant_issue(names, plays, "exact after normalisation",
                                         0.95))
            seen.add(frozenset(names))

    # ACCURACY OVER SPEED: every pair is compared. An earlier version blocked
    # candidates by first character, which was much faster but silently stopped
    # catching typos in the first character. This runs offline, so there is no
    # reason to trade recall for latency.
    #
    # The length gate is not a heuristic, it is implied by the threshold:
    # Ratcliff/Obershelp similarity is 2M/(n+m) with M <= min(n,m), so a pair
    # whose lengths differ by more than 3 cannot reach 0.9 at these string
    # lengths. Skipping them loses nothing.
    #
    # Kept identical to docs/drift.js so the two implementations agree.
    keys = list(buckets)
    for i, ka in enumerate(keys):
        for kb in keys[i + 1:]:
            if abs(len(ka) - len(kb)) > 3:
                continue

            # Two independent candidate rules. The ratio catches reorderings and
            # longer-name noise; the edit distance catches short-name typos the
            # ratio structurally cannot reach. Confidence differs so the weaker
            # signal is labelled as such rather than presented as equally sure.
            ratio = similar(ka, kb)
            by_ratio = ratio >= 0.90
            budget = typo_budget(ka, kb)
            by_edit = not by_ratio and edit_distance(ka, kb, budget) <= budget
            if not by_ratio and not by_edit:
                continue

            for a in buckets[ka]:
                for b in buckets[kb]:
                    pair = frozenset((a, b))
                    if pair in seen:
                        continue
                    shared = tracks[a] & tracks[b]
                    # Gate 1: same artist misspelled shares tracks; two
                    # different artists do not.
                    if not shared:
                        continue
                    # Gate 2: play-count asymmetry. A typo is scrobbled a
                    # handful of times; two real artists have comparable
                    # presence. Matters most for short names, where edit
                    # distance alone would pair unrelated artists sharing a
                    # generic title like "Intro".
                    lo = min(plays[a], plays[b])
                    hi = max(plays[a], plays[b])
                    if lo > 0.4 * hi:
                        continue
                    seen.add(pair)
                    issues.append(_variant_issue(
                        [a, b], plays,
                        (f"fuzzy match ({ratio * 100:.0f}% similar) confirmed by "
                         f"{len(shared)} shared track title(s)") if by_ratio else
                        (f"one-character difference confirmed by {len(shared)} "
                         f"shared track title(s)"),
                        0.75 if by_ratio else 0.6))
    return sorted(issues, key=lambda i: -i["plays_affected"])


def _variant_issue(names: list[str], plays: Counter, why: str,
                   conf: float) -> Issue:
    ranked = sorted(names, key=lambda n: -plays[n])
    only_case = len({n.lower() for n in names}) == 1
    return {
        "detector": "D1",
        "class": "unfixable" if only_case else "split",
        "confidence": conf,
        "title": f"Artist variants: {', '.join(repr(n) for n in ranked)}",
        "plays_affected": sum(plays[n] for n in names),
        "suggest": (
            "casing-only difference. Last.fm cannot merge these, so this is "
            "informational."
            if only_case else
            f"consolidate to '{ranked[0]}' ({plays[ranked[0]]} plays). "
            f"Matched by {why}."
        ),
        "members": [{"artist": n, "plays": plays[n]} for n in ranked],
    }


def d3_mbid_conflicts(rest: list[Scrobble]) -> list[Issue]:
    by_name: dict[str, set[str]] = defaultdict(set)
    by_mbid: dict[str, set[str]] = defaultdict(set)
    plays = Counter(s["artist"] for s in rest)
    for s in rest:
        if s["artist_mbid"]:
            by_name[norm(s["artist"])].add(s["artist_mbid"])
            by_mbid[s["artist_mbid"]].add(s["artist"])

    issues: list[Issue] = []
    for name, mbids in by_name.items():
        if len(mbids) > 1:
            issues.append({
                "detector": "D3", "class": "split", "confidence": 0.6,
                "title": f"Artist '{name}' carries {len(mbids)} MusicBrainz IDs",
                "plays_affected": sum(n for a, n in plays.items()
                                      if norm(a) == name),
                "suggest": "an upstream artist split or merge has fragmented "
                           "this artist. Informational.",
                "members": [{"mbid": m} for m in sorted(mbids)],
            })
    return issues


def d5_missing_album(rest: list[Scrobble]) -> list[Issue]:
    """Blank album strings, clustered by month to identify the culprit client."""
    blanks = [s for s in rest if not s["album"]]
    if not blanks:
        return []
    import datetime as dt
    months = Counter(
        dt.datetime.utcfromtimestamp(s["uts"]).strftime("%Y-%m") for s in blanks
    )
    worst = months.most_common(6)
    return [{
        "detector": "D5", "class": "error", "confidence": 0.9,
        "title": f"{len(blanks):,} scrobbles have no album",
        "plays_affected": len(blanks),
        "suggest": ("concentrated in "
                    + ", ".join(f"{m} ({n})" for m, n in worst)
                    + ". A cluster usually means one misbehaving scrobbler "
                      "rather than scattered mistakes."),
        "members": [{"month": m, "plays": n} for m, n in months.most_common(24)],
    }]


def d6_duplicates(scrobbles: list[Scrobble], window: int = 30) -> list[Issue]:
    """Same track twice within `window` seconds, plus systematic double-scrobbling.

    A whole period where most scrobbles are doubled means two clients running
    at once. Nobody detects that today and it silently inflates entire spans of
    history.
    """
    ordered = sorted(scrobbles, key=lambda s: s["uts"])
    dupes = []
    for prev, cur in zip(ordered, ordered[1:]):
        if (cur["uts"] - prev["uts"] <= window
                and norm_title(cur["track"]) == norm_title(prev["track"])
                and norm(cur["artist"]) == norm(prev["artist"])):
            dupes.append(cur)
    if not dupes:
        return []

    import datetime as dt
    months = Counter(
        dt.datetime.utcfromtimestamp(s["uts"]).strftime("%Y-%m") for s in dupes
    )
    all_months = Counter(
        dt.datetime.utcfromtimestamp(s["uts"]).strftime("%Y-%m") for s in ordered
    )
    systemic = sorted(
        ((m, n, all_months[m]) for m, n in months.items()
         if all_months[m] >= 50 and n / all_months[m] > 0.25),
        key=lambda t: -t[1] / t[2],
    )

    issues: list[Issue] = [{
        "detector": "D6", "class": "error", "confidence": 0.8,
        "title": f"{len(dupes):,} probable duplicate scrobbles "
                 f"(same track within {window}s)",
        "plays_affected": len(dupes),
        "suggest": "usually two scrobblers running at once.",
        "members": [{"month": m, "plays": n} for m, n in months.most_common(24)],
    }]
    if systemic:
        issues.append({
            "detector": "D6", "class": "anomaly", "confidence": 0.85,
            "title": f"Systematic double-scrobbling in {len(systemic)} month(s)",
            "plays_affected": sum(n for _, n, _ in systemic),
            "suggest": ("over 25% of scrobbles duplicated in "
                        + ", ".join(f"{m} ({n}/{t})" for m, n, t in systemic[:8])
                        + ". Two clients were almost certainly active. These "
                          "months inflate every stat you have."),
            "members": [{"month": m, "dupes": n, "total": t}
                        for m, n, t in systemic],
        })
    return issues


def d7_casing(rest: list[Scrobble]) -> list[Issue]:
    plays = Counter(s["artist"] for s in rest)
    groups: dict[str, set[str]] = defaultdict(set)
    for a in plays:
        groups[a.lower()].add(a)
    return [{
        "detector": "D7", "class": "unfixable", "confidence": 0.99,
        "title": f"Casing-only variants: {', '.join(repr(x) for x in sorted(v))}",
        "plays_affected": sum(plays[x] for x in v),
        "suggest": "Last.fm stores names in a way that makes case-only edits "
                   "impossible. Listed so you know it is not worth trying.",
        "members": [{"artist": x, "plays": plays[x]} for x in sorted(v)],
    } for v in groups.values() if len(v) > 1]


def d11_various_artists(rest: list[Scrobble]) -> list[Issue]:
    va = [s for s in rest if norm(s["artist"]) in {"various artists", "va",
                                                   "various"}]
    if not va:
        return []
    return [{
        "detector": "D11", "class": "error", "confidence": 0.9,
        "title": f"{len(va):,} scrobbles credited to Various Artists",
        "plays_affected": len(va),
        "suggest": "the real performing artist is recoverable for most of "
                   "these. They currently pollute your artist chart.",
        "members": [{"album": a, "plays": n} for a, n in
                    Counter(s["album"] for s in va).most_common(20)],
    }]


def d12_impossible(scrobbles: list[Scrobble], now: int) -> list[Issue]:
    issues: list[Issue] = []
    future = [s for s in scrobbles if s["uts"] > now + 3600]
    if future:
        issues.append({
            "detector": "D12", "class": "anomaly", "confidence": 0.99,
            "title": f"{len(future)} scrobbles dated in the future",
            "plays_affected": len(future),
            "suggest": "a client clock was wrong or a bulk import was malformed.",
            "members": [{"uts": s["uts"], "track": s["track"]} for s in future[:20]],
        })
    hours = Counter(s["uts"] // 3600 for s in scrobbles)
    bursts = [(h, n) for h, n in hours.items() if n > 60]
    if bursts:
        import datetime as dt
        issues.append({
            "detector": "D12", "class": "anomaly", "confidence": 0.7,
            "title": f"{len(bursts)} hour(s) contain physically impossible "
                     f"scrobble counts",
            "plays_affected": sum(n for _, n in bursts),
            "suggest": "more than 60 scrobbles in one hour is not listening. "
                       "Likely a bulk import or a stuck client.",
            "members": [
                {"hour": dt.datetime.utcfromtimestamp(h * 3600)
                    .strftime("%Y-%m-%d %H:00"), "plays": n}
                for h, n in sorted(bursts, key=lambda t: -t[1])[:20]
            ],
        })
    return issues


# --------------------------------------------------------------------------
# impact simulation and hygiene score
# --------------------------------------------------------------------------

def chart_impact(rest: list[Scrobble], splits: list[Issue],
                 top_n: int = 25) -> dict[str, Any]:
    """What the album chart would look like with splits merged.

    This is the point of a read-only tool. "You have 47 duplicate names" is a
    chore list. "Your real number one is not the one Last.fm shows you" is
    worth reading.
    """
    reported = Counter(f'{s["artist"]}␟{s["album"]}'
                       for s in rest if s["album"])

    merged = Counter(reported)
    for issue in splits:
        members = [m for m in issue.get("members", []) if m.get("album")]
        if len(members) < 2:
            continue
        target = issue.get("external", {}).get("title") or members[0]["album"]
        artist = issue.get("artist", "")
        sink = f"{artist}␟{target}"
        for m in members:
            key = f'{artist}␟{m["album"]}'
            if key == sink:
                continue
            moved = min(merged.get(key, 0), m["plays"])
            if moved:
                merged[key] -= moved
                merged[sink] += moved

    before = [k for k, _ in reported.most_common(200)]
    after = [k for k, _ in merged.most_common(200)]
    pos_before = {k: i + 1 for i, k in enumerate(before)}
    pos_after = {k: i + 1 for i, k in enumerate(after)}

    movers = []
    for k in set(before[:120]) | set(after[:120]):
        b, a = pos_before.get(k), pos_after.get(k)
        if b and a and b != a:
            movers.append({"album": k, "from": b, "to": a, "delta": b - a,
                           "plays_before": reported[k], "plays_after": merged[k]})
    movers.sort(key=lambda m: -abs(m["delta"]))

    return {
        "reported_top": [{"album": k, "plays": reported[k]} for k in before[:top_n]],
        "corrected_top": [{"album": k, "plays": merged[k]} for k in after[:top_n]],
        "biggest_movers": movers[:20],
        "number_one_changes": bool(before and after and before[0] != after[0]),
    }


def hygiene_score(total_plays: int, issues: list[Issue]) -> dict[str, Any]:
    """0-100, with subscores. Penalties are share-of-plays based, capped."""
    def affected(*detectors: str) -> int:
        return sum(i["plays_affected"] for i in issues
                   if i["detector"] in detectors and i["class"] != "unfixable")

    if not total_plays:
        return {"score": 100, "subscores": {}}

    parts = {
        "album_integrity": affected("D0", "D4", "D5"),
        "artist_integrity": affected("D1", "D3", "D8", "D11"),
        "duplicate_rate": affected("D6", "D12"),
        "era_consistency": affected("D14a", "D14c"),
    }
    subs = {}
    for name, n in parts.items():
        # A play can be counted by several detectors, so `share` can exceed 1.
        # The 2.0 multiplier is a tuning knob, not a truth: it decides how
        # alarmist the score is. Revisit once there is real data to calibrate.
        share = n / total_plays
        subs[name] = max(0, round(100 * (1 - min(share * 2.0, 1.0))))
    score = round(sum(subs.values()) / len(subs))
    return {"score": score, "subscores": subs,
            "plays_affected": parts, "total_plays": total_plays}
