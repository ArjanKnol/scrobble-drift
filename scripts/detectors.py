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
    """Aggressive comparison key: casing, accents, apostrophe style, punctuation."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text).translate(_APOSTROPHES)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = _PUNCT.sub(" ", text.lower())
    text = _WS.sub(" ", text).strip()
    if drop_the and text.startswith("the "):
        text = text[4:]
    return text


def similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


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

    Separates casing-only differences from the rest, because Last.fm cannot
    change casing at all. Telling someone to fix an unfixable string is worse
    than staying quiet.
    """
    issues: list[Issue] = []
    albums: dict[str, Counter] = defaultdict(Counter)
    names: dict[str, Counter] = defaultdict(Counter)
    for s in era:
        albums[s["artist"]][s["album"]] += 1
        name = era_name(s["album"])
        if name:
            names[s["artist"]][name] += 1

    # Dominant global shape, so the suggestion can name the house style.
    shapes = Counter()
    for s in era:
        m = ERA_NAME.search(s["album"] or "")
        if m:
            shapes[m.group(0).strip()[-4:-1]] += 1        # "Era" vs "era"
    dominant = shapes.most_common(1)[0][0] if shapes else "Era"

    # (a) whole-string variants: casing, brackets, spacing.
    for artist, strings in albums.items():
        buckets: dict[str, list[str]] = defaultdict(list)
        for raw in strings:
            buckets[norm(raw)].append(raw)
        for group in buckets.values():
            if len(group) < 2:
                continue
            ranked = sorted(group, key=lambda x: -strings[x])
            case_only = len({g.lower() for g in group}) == 1
            issues.append({
                "detector": "D14a",
                "class": "unfixable" if case_only else "split",
                "confidence": 0.95,
                "artist": artist,
                "title": f"Era tag written {len(group)} ways for {artist}: "
                         + ", ".join(repr(g) for g in ranked),
                "plays_affected": sum(strings[g] for g in group),
                "suggest": (
                    f"casing-only difference against your usual '{dominant}' "
                    f"style. Last.fm cannot change casing, so this one is "
                    f"informational rather than actionable."
                    if case_only else
                    f"standardise on '{ranked[0]}' ({strings[ranked[0]]} plays)."
                ),
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
                issues.append({
                    "detector": "D14a", "class": "error", "confidence": 0.7,
                    "artist": artist,
                    "title": f"Probable era-name typo for {artist}: "
                             f"'{lo}' vs '{hi}'",
                    "plays_affected": counts[lo] + counts[hi],
                    "suggest": f"'{hi}' has {counts[hi]} plays against "
                               f"{counts[lo]}, so '{lo}' is likely the typo.",
                    "members": [{"era": n, "plays": counts[n]} for n in (lo, hi)],
                })
    return issues


def d14c_track_in_two_eras(era: list[Scrobble]) -> list[Issue]:
    """One track filed under two different eras. An internal contradiction.

    The closest achievable thing to genuine wrong-era detection, since it needs
    no external ground truth. Reported as a conflict rather than an error: with
    V2-style projects the same song legitimately exists in two eras as
    different versions.
    """
    where: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for s in era:
        name = era_name(s["album"])
        if name:
            where[(s["artist"], norm(s["track"]))][name] += 1

    issues: list[Issue] = []
    for (artist, track_key), eras in where.items():
        if len(eras) < 2:
            continue
        versioned = any(re.search(r"\bv\d+\b", e, re.I) for e in eras)
        issues.append({
            "detector": "D14c", "class": "review" if versioned else "error",
            "confidence": 0.5 if versioned else 0.8,
            "artist": artist,
            "title": f"{artist} - '{track_key}' appears in {len(eras)} eras: "
                     + ", ".join(sorted(eras)),
            "plays_affected": sum(eras.values()),
            "suggest": ("a V2-style project is involved, so these may be "
                        "genuinely different versions. Verify before merging."
                        if versioned else
                        "one of these eras is wrong. Pick the correct one."),
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
        g = groups[(norm(s["artist"]), norm(s["track"]))]
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
        issues.append({
            "detector": "D4", "class": "split",
            "confidence": 0.85,
            "artist": g["artist"],
            "title": f"{g['artist']} - '{g['track']}' split across "
                     f"{len(albums)} album strings",
            "plays_affected": sum(albums.values()),
            "suggest": "candidate for consolidation, see D0 for the target",
            "members": members,
            "temporal": _temporal_signature(members),
        })
    return sorted(issues, key=lambda i: -i["plays_affected"])


def _classify_album_string(album: str, track: str) -> str:
    if album == "(no album)":
        return "missing"
    if norm(album) == norm(track):
        return "single (album titled after the track)"
    if re.search(r"\s*[-–]\s*(single|ep)$", album, re.I):
        return "single or EP"
    if COMPILATION.search(album):
        return "compilation"
    if EDITION.search(album):
        return "edition variant"
    return "album"


def _temporal_signature(members: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Detect the single-to-album migration pattern.

    Provable rather than inferred: if all plays of string A predate all plays
    of string B, the track moved from one release to the other at a point in
    time. That is the release history of the record reconstructed from the
    user's own listening, not a string similarity guess.
    """
    if len(members) != 2:
        return None
    a, b = sorted(members, key=lambda m: m["first"])
    if a["last"] <= b["first"]:
        return {
            "pattern": "clean_handover",
            "earlier": a["album"], "later": b["album"],
            "boundary": b["first"],
            "note": (f"every play of '{a['album']}' predates every play of "
                     f"'{b['album']}'. Classic single-absorbed-into-album "
                     f"migration around {_d(b['first'])}."),
        }
    return None


def d0_resolve(splits: list[Issue], resolve: Callable[[str, str], Any]) -> list[Issue]:
    """Pick a consolidation target for each split using MusicBrainz.

    Target = earliest release group of primary type Album without a
    Compilation secondary type. That resolves singles forward into their album
    and compilations back to the original studio release, which are opposite
    directions handled by one rule.
    """
    out: list[Issue] = []
    for issue in splits:
        track = issue["title"].split("'")[1] if "'" in issue["title"] else ""
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
    variants: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for s in rest:
        variants[(norm(s["artist"]), norm(base_title(s["track"])))][s["track"]] += 1
    for (_, _), titles in variants.items():
        if len(titles) < 2:
            continue
        canonical = titles.most_common(1)[0][0]
        issues.append({
            "detector": "D8", "class": "split", "confidence": 0.8,
            "title": f"'{base_title(canonical)}' scrobbled under "
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
        tracks[s["artist"]].add(norm(s["track"]))

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

    keys = sorted(buckets)
    for i, ka in enumerate(keys):
        for kb in keys[i + 1:]:
            if abs(len(ka) - len(kb)) > 3 or similar(ka, kb) < 0.90:
                continue
            for a in buckets[ka]:
                for b in buckets[kb]:
                    pair = frozenset((a, b))
                    if pair in seen or not (tracks[a] & tracks[b]):
                        continue
                    seen.add(pair)
                    issues.append(_variant_issue(
                        [a, b], plays,
                        f"fuzzy match confirmed by "
                        f"{len(tracks[a] & tracks[b])} shared track titles",
                        0.75))
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
                and norm(cur["track"]) == norm(prev["track"])
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
