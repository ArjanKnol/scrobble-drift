#!/usr/bin/env python3
"""Scrobble Drift scanner.

    python scripts/run.py                 # local detectors only, fast (~3 min)
    python scripts/run.py --resolve       # also resolve against MusicBrainz
    python scripts/run.py --resolve --budget 400
    python scripts/run.py --limit 5000    # quick smoke test on recent history

Writes docs/report.json (served by GitHub Pages) and appends a snapshot to
data/history/ so the next run can diff against it.

Stdlib only, deliberately: no pip install step in CI, nothing to pin, nothing
to audit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import detectors as D  # noqa: E402
from api import Lastfm, MusicBrainz, load_env  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "docs" / "report.json"
HISTORY = ROOT / "data" / "history"
MB_CACHE = ROOT / "data" / "mb-cache.json"


def flatten(track: dict) -> dict:
    """Last.fm's nested JSON into a flat scrobble record."""
    artist = track.get("artist") or {}
    album = track.get("album") or {}
    return {
        "uts": int(track["date"]["uts"]),
        "artist": (artist.get("#text") or artist.get("name") or "").strip(),
        "artist_mbid": artist.get("mbid") or "",
        "album": (album.get("#text") or "").strip(),
        "album_mbid": album.get("mbid") or "",
        "track": (track.get("name") or "").strip(),
        "track_mbid": track.get("mbid") or "",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resolve", action="store_true",
                    help="resolve splits and era tracks against MusicBrainz "
                         "(slow: 1 req/s)")
    ap.add_argument("--budget", type=int, default=300,
                    help="max MusicBrainz lookups this run (default 300)")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after N scrobbles (smoke testing)")
    args = ap.parse_args()

    load_env(ROOT / ".env")
    user = os.environ.get("LASTFM_USER")
    key = os.environ.get("LASTFM_API_KEY", "")
    if not user:
        raise SystemExit("LASTFM_USER is not set.")

    started = time.time()
    fm = Lastfm(key)

    print(f"* profile: {user}", file=sys.stderr)
    info = fm.user_info(user)
    expected = int(info.get("playcount") or 0)
    print(f"  {expected:,} scrobbles reported by last.fm", file=sys.stderr)

    print("* ingesting", file=sys.stderr)
    scrobbles: list[dict] = []
    for track in fm.recent_tracks(user):
        try:
            scrobbles.append(flatten(track))
        except (KeyError, TypeError, ValueError):
            continue
        if args.limit and len(scrobbles) >= args.limit:
            break
    print(f"  {len(scrobbles):,} scrobbles ingested", file=sys.stderr)
    if not scrobbles:
        raise SystemExit("no scrobbles returned; check the username")

    total = len(scrobbles)
    now = int(time.time())

    # D14 guard runs FIRST. Era-tagged material is protected from every
    # detector that would otherwise recommend destroying the taxonomy.
    era, rest = D.partition_era(scrobbles)
    print(f"* era-tagged (protected): {len(era):,} plays "
          f"({100 * len(era) / total:.1f}%)", file=sys.stderr)

    print("* detecting", file=sys.stderr)
    issues: list[dict] = []
    issues += D.d14a_format_variants(era)
    issues += D.d14c_track_in_two_eras(era)
    splits = D.d4_album_splits(rest)
    issues += D.d8_feature_credits(rest)
    issues += D.d1_artist_variants(rest)
    issues += D.d3_mbid_conflicts(rest)
    issues += D.d5_missing_album(rest)
    issues += D.d6_duplicates(scrobbles)
    issues += D.d7_casing(rest)
    issues += D.d11_various_artists(rest)
    issues += D.d12_impossible(scrobbles, now)

    # D2 (canonical name divergence) is intentionally not run. This project
    # keeps autocorrect off, which makes Last.fm's canonical opinion actively
    # misleading rather than merely unhelpful. See the spec, section 3c.

    resolved: list[dict] = []
    era_released: list[dict] = []
    mb_used = 0
    if args.resolve:
        mb = MusicBrainz(MB_CACHE, budget=args.budget)
        print(f"* resolving via MusicBrainz (budget {args.budget}, 1 req/s)",
              file=sys.stderr)
        # Busiest splits first so a capped budget is spent where it matters.
        resolved = D.d0_resolve(splits[:args.budget // 2], mb.recording)
        era_released = D.d14e_released_since(era, mb.recording)
        mb.save()
        mb_used = mb.spent
        print(f"  {mb_used} lookups used, cache now {len(mb.cache):,} entries",
              file=sys.stderr)

    issues += resolved or splits
    issues += era_released

    impact = D.chart_impact(rest, resolved or splits)
    score = D.hygiene_score(total, issues)
    overview = D.d14_era_overview(era, total)

    issues.sort(key=lambda i: (-i.get("plays_affected", 0),
                               i.get("detector", "")))

    by_detector: dict[str, dict] = {}
    for i in issues:
        d = by_detector.setdefault(i["detector"],
                                   {"count": 0, "plays_affected": 0})
        d["count"] += 1
        d["plays_affected"] += i.get("plays_affected", 0)

    report = {
        "generated": now,
        "took_seconds": round(time.time() - started, 1),
        "user": user,
        "profile": {
            "scrobbles_ingested": total,
            "scrobbles_reported": expected,
            "registered": info.get("registered", {}).get("unixtime"),
            "distinct_artists": len({s["artist"] for s in scrobbles}),
            "distinct_albums": len({f'{s["artist"]}␟{s["album"]}'
                                    for s in scrobbles if s["album"]}),
            "distinct_tracks": len({f'{s["artist"]}␟{s["track"]}'
                                    for s in scrobbles}),
        },
        "hygiene": score,
        "era": overview,
        "impact": impact,
        "summary_by_detector": by_detector,
        "musicbrainz_lookups": mb_used,
        "resolved": bool(args.resolve),
        # Cap what ships to the browser. The full set stays in history.
        "issues": issues[:600],
        "issues_total": len(issues),
    }

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=1),
                      encoding="utf-8")

    HISTORY.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m", time.gmtime(now))
    (HISTORY / f"{stamp}.json").write_text(
        json.dumps({k: report[k] for k in
                    ("generated", "profile", "hygiene", "era",
                     "summary_by_detector", "issues_total")},
                   ensure_ascii=False, indent=1),
        encoding="utf-8")

    print(f"\n  hygiene score : {score['score']}/100", file=sys.stderr)
    for k, v in score.get("subscores", {}).items():
        print(f"    {k:18}: {v}", file=sys.stderr)
    print(f"  issues        : {len(issues):,}", file=sys.stderr)
    print(f"  era share     : {overview['share_of_all_plays']}% of plays, "
          f"{overview['album_strings']:,} album strings, "
          f"{overview['distinct_eras']:,} distinct eras", file=sys.stderr)
    if impact.get("number_one_changes"):
        print("  NOTE: your true #1 album differs from what last.fm shows",
              file=sys.stderr)
    print(f"\n  wrote {REPORT.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
