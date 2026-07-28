"""Last.fm and MusicBrainz clients for Scrobble Drift.

Design notes:
  * Read-only. No authenticated Last.fm method is ever called, so no shared
    secret exists anywhere in this codebase. See README.
  * Last.fm sends no CORS headers, which is why all of this runs server-side
    in a GitHub Action rather than in the browser.
  * MusicBrainz enforces 1 request/second with IP blocking for abuse. The
    limiter below is not optional politeness.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterator

LASTFM_ROOT = "https://ws.audioscrobbler.com/2.0/"
MB_ROOT = "https://musicbrainz.org/ws/2"

# MusicBrainz requires a meaningful User-Agent identifying the application.
USER_AGENT = "ScrobbleDrift/0.1 (https://github.com/ArjanKnol/scrobble-drift)"


class RateLimiter:
    """Minimum-interval limiter. Blocks until the next slot is due."""

    def __init__(self, per_second: float) -> None:
        self.interval = 1.0 / per_second
        self._last = 0.0

    def wait(self) -> None:
        gap = time.monotonic() - self._last
        if gap < self.interval:
            time.sleep(self.interval - gap)
        self._last = time.monotonic()


def _get_json(url: str, *, headers: dict[str, str] | None = None,
              attempts: int = 4) -> dict[str, Any]:
    """GET with exponential backoff. Retries transient errors and 429s only."""
    last_err: Exception | None = None
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            # 4xx other than 429 will not fix themselves. Fail fast.
            if exc.code != 429 and 400 <= exc.code < 500:
                raise
            last_err = exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_err = exc
        time.sleep(2 ** attempt)
    raise RuntimeError(f"giving up on {url}: {last_err}")


class Lastfm:
    """Minimal read-only Last.fm client."""

    def __init__(self, api_key: str, per_second: float = 4.0) -> None:
        if not api_key:
            raise SystemExit(
                "LASTFM_API_KEY is not set. Locally: export it or use a .env "
                "file. In CI: add it as a GitHub Actions secret."
            )
        self.api_key = api_key
        self.limiter = RateLimiter(per_second)

    def call(self, method: str, **params: Any) -> dict[str, Any]:
        query = {
            "method": method,
            "api_key": self.api_key,
            "format": "json",
            # Autocorrect stays OFF everywhere. We need what was actually
            # stored, not Last.fm's opinion of it. Users who disable
            # autocorrection did so deliberately.
            "autocorrect": "0",
            **{k: v for k, v in params.items() if v is not None},
        }
        payload = _get_json(LASTFM_ROOT + "?" + urllib.parse.urlencode(query))
        if "error" in payload:
            raise RuntimeError(
                f"last.fm error {payload['error']}: {payload.get('message')}"
            )
        return payload

    def user_info(self, user: str) -> dict[str, Any]:
        return self.call("user.getInfo", user=user)["user"]

    def recent_tracks(self, user: str, *, from_uts: int | None = None,
                      progress: bool = True) -> Iterator[dict[str, Any]]:
        """Yield every scrobble, newest first.

        `from_uts` makes this incremental. The currently-playing track has no
        date field and is skipped: it is not a scrobble yet.
        """
        page, total_pages = 1, 1
        seen = 0
        while page <= total_pages:
            self.limiter.wait()
            block = self.call("user.getRecentTracks", user=user, limit=200,
                              page=page, **({"from": from_uts} if from_uts else {}))
            rt = block.get("recenttracks", {})
            attr = rt.get("@attr", {})
            total_pages = int(attr.get("totalPages") or 1)
            tracks = rt.get("track") or []
            if isinstance(tracks, dict):
                tracks = [tracks]
            for t in tracks:
                if t.get("@attr", {}).get("nowplaying") == "true":
                    continue
                if not t.get("date"):
                    continue
                yield t
                seen += 1
            if progress and (page % 25 == 0 or page == total_pages):
                print(f"    scrobbles: page {page}/{total_pages} ({seen:,})",
                      file=sys.stderr, flush=True)
            page += 1

    def artist_listeners(self, artist: str) -> int | None:
        """Global listener count. Used by the orphan-entity detector."""
        try:
            self.limiter.wait()
            info = self.call("artist.getInfo", artist=artist)
            return int(info["artist"]["stats"]["listeners"])
        except Exception:
            return None


class MusicBrainz:
    """Release-group resolution with a durable on-disk cache.

    MusicBrainz is the metadata authority here, not Last.fm, whose album data
    is user-generated and frequently wrong or absent. Release groups are what
    make this worthwhile: editions (deluxe, remaster, regional) share one
    release group, so grouping on it collapses edition variants without any
    string pattern matching.
    """

    def __init__(self, cache_path: Path, per_second: float = 1.0,
                 budget: int | None = None) -> None:
        self.limiter = RateLimiter(per_second)
        self.cache_path = cache_path
        self.cache: dict[str, Any] = {}
        self.spent = 0
        self.budget = budget
        if cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text("utf-8"))
            except json.JSONDecodeError:
                print("  warning: MB cache unreadable, starting fresh",
                      file=sys.stderr)

    def save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(
            json.dumps(self.cache, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )

    @property
    def exhausted(self) -> bool:
        return self.budget is not None and self.spent >= self.budget

    def recording(self, artist: str, track: str) -> dict[str, Any] | None:
        """Look up a recording and summarise every release group it appears on.

        Returns None on a cache miss when the budget is spent, so callers can
        distinguish "not found" from "not looked up yet".
        """
        key = f"rec::{artist.lower()}::{track.lower()}"
        if key in self.cache:
            return self.cache[key]
        if self.exhausted:
            return None

        query = f'artist:"{_lucene(artist)}" AND recording:"{_lucene(track)}"'
        url = (f"{MB_ROOT}/recording?query={urllib.parse.quote(query)}"
               f"&fmt=json&limit=25")
        self.limiter.wait()
        self.spent += 1
        try:
            data = _get_json(url)
        except Exception as exc:
            print(f"  MB lookup failed for {artist} - {track}: {exc}",
                  file=sys.stderr)
            return None

        groups: list[dict[str, Any]] = []
        for rec in data.get("recordings", []):
            for rel in rec.get("releases", []):
                rg = rel.get("release-group") or {}
                if not rg.get("id"):
                    continue
                groups.append({
                    "rg_id": rg["id"],
                    "title": rg.get("title"),
                    "primary": rg.get("primary-type"),
                    "secondary": rg.get("secondary-types") or [],
                    "first_release": rg.get("first-release-date"),
                    "status": rel.get("status"),
                    "recording_id": rec.get("id"),
                })

        # Deduplicate by release group, keeping the earliest dated instance.
        best: dict[str, dict[str, Any]] = {}
        for g in groups:
            cur = best.get(g["rg_id"])
            if cur is None or (g["first_release"] or "9999") < (cur["first_release"] or "9999"):
                best[g["rg_id"]] = g

        result = {"groups": sorted(best.values(),
                                   key=lambda g: g["first_release"] or "9999")}
        self.cache[key] = result
        return result


def _lucene(text: str) -> str:
    """Escape Lucene syntax so titles with punctuation do not break the query."""
    for ch in r'\+-!(){}[]^"~*?:/&|':
        text = text.replace(ch, "\\" + ch)
    return text


def load_env(path: Path = Path(".env")) -> None:
    """Load KEY=VALUE lines from a .env file without overriding real env vars."""
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))
