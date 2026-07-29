# Scrobble Drift

Finds metadata drift in a Last.fm listening history and shows how much it
distorts your stats.

Read-only. It never scrobbles, edits, or deletes anything.

---

## What it actually looks for

The problem this exists for is not typos. It is that **your metadata degrades
on its own, through no action of yours.** A single you played on release gets
absorbed into an album months later, so your plays end up split across two
album strings that share no characters and no string-matching tool will ever
connect. Catalogues get repackaged into compilations and reissues on the
label's schedule. Leaked tracks quietly get official releases years later.

Because it regenerates, this is a **monitor**, not a one-off cleanup. One deep
audit clears the backlog, then a monthly diff reports the few things that
changed. Three specific edits a month is a five-minute job. A 500-item backlog
never gets touched.

| Detector | What it finds |
|---|---|
| **D0** | Consolidation target for split tracks, resolved via MusicBrainz |
| **D4** | One track's plays spread across several album strings |
| **D8** | Feature-credit splits (`Knife Talk` vs `Knife Talk (with …)`) and artist fields polluted with features |
| **D14** | Era-tagged unreleased material, protected from every other detector |
| **D14a** | Inconsistent spelling of your own era convention |
| **D14c** | One track title filed under several eras (informational) |
| **D14e** | Unreleased material that now has an official release |
| **D1 / D3** | Artist name variants, MusicBrainz ID conflicts |
| **D5 / D6 / D11 / D12** | Missing albums, duplicate scrobbles, Various Artists, impossible timestamps |

**Two detectors are deliberately not run.** Both remain in the code so the
reasoning survives and re-enabling is one line.

**D2, canonical-name divergence.** It would compare your stored names against
Last.fm's canonical forms and recommend "fixing" them. With autocorrect off
that is backwards: it would tell you to rewrite `Travis Scott` as
`Travi$ Scott`. Divergence from Last.fm canonical is not an error.

**D7, casing-only variants.** `JAŸ-Z` and `Jaÿ-Z` really are the same artist,
but Last.fm cannot change just the casing of a name, so every finding is
unactionable. A report padded with work nobody can do is worse than a shorter
honest one. D1 also skips casing-only groups, so these are absent rather than
relabelled.

There is a community workaround if you ever want one of these badly enough:
rename the artist to something different, then rename it back with the casing
you want. Two edits, fiddly, and not worth automating.

### How artist matching decides

Three independent signals, because one is not enough:

1. **Exact after normalisation** — casing, accents, apostrophe style and
   punctuation removed. Catches `Melody's` versus `Melody’s`. Confidence 0.95.
2. **Similarity ratio** at 0.9 or above. Catches longer-name noise and
   reorderings. Confidence 0.75.
3. **Edit distance**, budget scaled to name length. Needed because the ratio
   is `2M/(n+m)` and so structurally cannot catch a one-character typo in a
   short name: `Yeat` versus `Teat` scores 0.75, `Sef` versus `Sez` scores
   0.667. Without this, typos in names under about ten characters were
   invisible. Confidence 0.6, since it is the weakest signal.

Candidates from 2 and 3 must then pass two gates: they must **share a track
title** (the same artist misspelled will, two different artists will not), and
their play counts must be **lopsided** (a typo is scrobbled a handful of times;
two real artists have comparable presence). The second gate is what stops
`Sef` and `Sez` being merged just because both released a track called `Intro`.

---

## Why MusicBrainz and not Last.fm

Last.fm's album data is user-generated: tracklists are often incomplete, wrong,
or missing, `releasedate` is unreliable, and there is no release-type field at
all. So Last.fm is used for exactly one thing here, **what you played and
when**, and every question about what a release *is* goes to MusicBrainz.

MusicBrainz has the right model. A **release group** is the abstract album; a
**release** is an edition of it (standard, deluxe, Japanese, remaster). Grouping
on release group collapses every edition variant at once, with no regex for
`(Deluxe Edition)`. Its style policy confirms the semantics: a reissue with
bonus tracks is not a compilation, so deluxe editions stay attached to their
parent album.

It also gives typed release groups (Album / Single / EP, plus stacking
secondary types including Compilation, Live, Remix, **Mixtape/Street** and
**Demo**), which matters for hip-hop libraries that Spotify does not model.

MusicBrainz enforces **1 request per second** with IP blocking for abuse. The
limiter is not optional, and lookups are cached permanently in
`data/mb-cache.json` because release dates do not change.

### Spotify first, MusicBrainz second

That 1/s limit is the slowest thing in a full scan by an order of magnitude:
4,000 distinct unreleased tracks is 67 minutes of wall clock. Spotify fixes it,
not by being faster per call, but by answering a **better-shaped question**.

MusicBrainz is asked per track. Spotify will hand over an artist's entire
official catalogue in two calls, so 4,000 tracks across 250 artists becomes
~800 calls instead of 4,000, at ~5/s instead of 1/s. Minutes, not hours.

The ordering is not interchangeable, and the asymmetry is the whole design:

| | Meaning | Action |
|---|---|---|
| **Present** in Spotify | Strong evidence it was released | Accept, skip MusicBrainz |
| **Absent** from Spotify | No evidence at all | Ask MusicBrainz |

Spotify's catalogue is a licensing artefact, not a discography: no bootlegs, no
unofficial releases, patchy pre-2000 coverage, and tracks vanish when a licence
lapses. Treating absence as a verdict would silently mark released tracks as
unreleased, which is worse than being slow. So absence is never acted on, and
the residual that reaches MusicBrainz is small precisely because it is the
genuinely unreleased material, which is exactly what MusicBrainz is better at.

Two accuracy caveats, both handled in code:

- Spotify's `release_date` is the date of **that edition**, not of the work. A
  2015 album reissued in 2021 reports 2021. Editions are collapsed by title with
  the edition qualifier stripped, and the earliest date within a group wins.
- Spotify has **no EP type**; EPs arrive as `album_type: "single"`. Track count
  recovers the distinction, which matters because `EP` is one of the three
  primary types the "released since" detector accepts as official.

Spotify albums are adapted into the MusicBrainz release-group shape **inside the
Worker**, so the detectors consume one contract and neither knows nor cares
where an answer came from. Adding a third source touches one function.

Spotify is optional. Without credentials the scan is slower and produces
identical findings.

---

## Hosting

Live at **<https://arjanknol.github.io/scrobble-drift/>** once Pages is enabled.

Two pieces, split by necessity rather than preference:

| Piece | Where | Why there |
|---|---|---|
| Frontend + detectors | **GitHub Pages** (free) | Static files. `docs/drift.js` runs the whole analysis in the visitor's browser. |
| API proxy | **Cloudflare Worker** (free) | Last.fm sends no `Access-Control-Allow-Origin` header, so a browser cannot call it. And the API key must never reach the client. |

It cannot be GitHub-only. Not a limitation of Pages, a property of Last.fm: no
CORS headers means no browser calls, full stop. Something server-side has to sit
in between, and the Worker free tier does it at no cost.

**Nothing is stored server-side.** The Worker proxies and forgets: it never
writes a scrobble anywhere, and analysis happens entirely in the visitor's
browser. There is no database to breach and no retention policy to write.

**Some things are stored client-side**, in the visitor's own browser via
IndexedDB, and the UI says so plainly rather than claiming otherwise:

| Stored | Why |
|---|---|
| Fetched scrobbles | So an interrupted scan resumes instead of starting over |
| MusicBrainz answers | Release dates and types are historical facts, so a repeat scan is instant rather than another hour at one lookup per second |
| Spotify catalogues | One artist's full title index, reused across every one of their tracks and across rescans |
| Scan position | Which user, how deep, which page to continue from |

Catalogue indexes store each album **once** and reference it by index from the
title map. Inlining the album onto every track measured near 150MB total, which
competes with the scrobble data for the same quota and fails a large scan.

The API key is **never** persisted, even when a visitor supplies their own. A
"Clear stored data" link wipes everything and reports current usage.

`localStorage` was not an option: it caps around 5MB and a 139,000-scrobble
history is closer to 100MB. Every storage call is best-effort, so a quota
failure or private-browsing mode degrades to an in-memory scan rather than
breaking it.

### Enabling Pages

Settings → Pages → Source **Deploy from a branch** → branch `main`, folder
**`/docs`**.

`docs/.nojekyll` stops Pages running the files through Jekyll, which would
otherwise ignore underscore-prefixed paths and add build latency for nothing.

### Deploying the Worker

```bash
cd worker
npx wrangler secret put LASTFM_API_KEY     # paste the key, never commit it
npx wrangler deploy
```

Optional, for the faster resolution path. Without these the scan is slower and
produces identical findings, so they are safe to skip:

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler deploy
```

Get them from <https://developer.spotify.com/dashboard>. The Worker uses the
**client-credentials** flow, which grants no user scope at all: the token can
read the public catalogue and cannot see or touch any Spotify account. There is
no redirect URI to configure and no user ever logs in. `/api/health` reports
whether the frontend can see them.

Paste the URL it prints into `docs/config.js`, replacing the
`YOUR-SUBDOMAIN` placeholder. Until you do, the site loads and explains exactly
what is missing rather than throwing a CORS error at whoever opened it.

**Before sharing the URL with anyone, two non-optional steps:**

1. **Bind the KV namespace for rate limiting.** Uncomment the block in
   `wrangler.toml` after `npx wrangler kv namespace create RATE`. The Worker
   degrades to allow-all without it, which is fine for a first deploy and
   reckless in public: this proxy spends a real API key, and Last.fm error 26
   (suspended key) takes every user down at once.
2. **Check `ALLOWED_ORIGINS`.** It must list your Pages origin and nothing
   loose. `"*"` lets any website on the internet spend your key.

---

## Cost

Everything is free tier, with no card required:

| Piece | Plan | Relevant limit |
|---|---|---|
| GitHub repo + Pages | Free | Public repos only for Pages on Free |
| GitHub Actions | Free | Unlimited minutes for public repos |
| Cloudflare Workers | Free | 100,000 requests/day, 10ms CPU/request |
| Workers Rate Limiting binding | Free | No additional charge; billed only as normal requests |
| Cloudflare Cache API | Free | Used for the circuit breaker |
| Last.fm API | Free | Contact partners@last.fm before commercial or large-scale use |
| MusicBrainz | Free | 1 request/second, IP blocking for abuse |
| Spotify Web API | Free | Client-credentials only, no user scope. No published rate number; 429 carries `Retry-After` |

**Deliberately avoided:** Durable Objects (Workers Paid for the KV-backed
kind) and Workers KV (its 1,000 writes/day free ceiling made it useless for a
breaker). The Cache API replaced KV entirely, which also removed a setup step.

**What the request cap means in practice.** A scan at the default 2,000 depth
is 10 pages, batched 8 per request, so ~2 Worker requests. That is roughly
50,000 scans/day inside the free tier. At 10,000 depth it is ~7 requests, so
~14,000 scans/day. Cloudflare is not the constraint; the shared Last.fm key is.

Exceeding the free Workers tier returns errors rather than a bill. Nothing here
can silently start costing money.

---

## Rate limiting

Written for the case where this gets posted somewhere busy.

**The scarce resource is not Cloudflare requests, it is upstream Last.fm calls
against one shared key.** A 10,000-scrobble scan is ~7 Worker requests but 50
Last.fm calls. Last.fm suspends keys it sees abused (error 26), which would
break the site for everyone at once. Community consensus puts its tolerance
near 5 requests/second per key, and a single scan fetching pages back-to-back
already sits at about that. So the danger is concurrency.

Six layers, in order of how much work they actually do:

1. **Pacing** — 130ms between upstream calls inside a request, so no single
   scan can burst.
2. **Circuit breaker** — on Last.fm error 29 or HTTP 429, stop for 120s rather
   than hammering a key already in trouble. Backed by the Cache API.
3. **Edge cache** — 30 minutes on upstream responses. Matters most in exactly
   the viral case, where many people scan the same handful of usernames.
4. **Own key** — visitors can paste their own API key and bypass the shared
   budget and breaker entirely. The only layer that genuinely scales, because
   it removes the shared resource.
5. **Per-client limits** — 6 scan requests/10s and 120 pages/min per IP.
6. **Shared ceiling** — 240 pages/min against the shared key.

Two honest limits of layer 6, straight from Cloudflare's docs: counters are
**per Cloudflare location, not global**, so worldwide traffic multiplies the
ceiling; and the API is eventually consistent and "intentionally designed to
not be used as an accurate accounting system". It overshoots. A true global
counter needs Durable Objects — now possible on Free if declared as
`new_sqlite_classes`, which is the upgrade path if per-location proves too
loose.

**The Worker fails OPEN if a limiter binding is missing**, so an unprotected
deployment looks identical to a protected one. `/api/health` reports which
limiters are live, and the frontend shows a warning banner when any are
missing. Check that banner is absent before sharing the URL.

---

## Setup

### 1. Get a Last.fm API key

<https://www.last.fm/api/account/create>

You are issued an API key **and a shared secret**. **Keep only the key and
discard the secret.** The secret exists solely to sign authenticated and write
methods, and this project calls none of them. If it never enters the system it
cannot leak, and its absence makes it structurally impossible for this codebase
to write to your account.

### 2. Add it as a repository secret

Settings → Secrets and variables → Actions

- **Secret** `LASTFM_API_KEY` = your key
- **Variable** `LASTFM_USER` = your Last.fm username

Never put the key in a file in this repo.

### 3. Enable GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder
**`/docs`**

The scan commits `docs/report.json`, so Pages picks it up with no deploy step.

### 4. Run it

Actions → **scan** → Run workflow. Or wait for the 1st of the month.

---

## Running locally

Node 20, **zero dependencies**. Nothing to pin, nothing to audit, nothing to
break in six months. `fetch` is built in.

```bash
cp .env.example .env      # then put your key in it, it is git-ignored
node scripts/scan.mjs                      # local detectors only, ~3 min
node scripts/scan.mjs --resolve            # also resolve via MusicBrainz
node scripts/scan.mjs --resolve --budget 300
node scripts/scan.mjs --limit 5000         # quick smoke test
```

The scanner **imports its detectors straight from `docs/drift.js`**, the same
file the browser loads. There is one implementation, so the monthly run and the
web app cannot disagree. An earlier version kept a parallel Python copy and they
drifted within days: a bug fixed in one stayed live in the other.

Tests, also no dependencies and no network:

```bash
node scripts/test-spotify.mjs   # catalogue indexing, match tiers, editions
node scripts/test-worker.mjs    # release-type mapping, normaliser agreement
```

Then serve the frontend:

```bash
npx http-server docs -p 8000    # or any static server
```

The first `--resolve` run is the slow one because the lookup cache is empty.
`--budget` caps lookups per run, and the busiest issues are resolved first so a
small budget still lands where it matters.

---

## Design notes

**Detectors are pure functions over a list of scrobbles.** `detectors.py` does
no I/O and touches no database or framework. That is deliberate: the detection
logic is the actual asset, and it needs to run unchanged in a GitHub Action
today and in a Cloudflare Worker later.

**The era guard runs first.** Era-tagged unreleased material is partitioned out
before anything else, and D0, D4, D1 and D13 never see it. Otherwise D0 would
resolve `Unreleased (Rodeo Era)` against MusicBrainz, find `Rodeo`, and
confidently recommend merging them, destroying a deliberate distinction. And
the orphan detector would flag every leak as a typo, since leaks have near-zero
listeners and no database entry. Confidently damaging a carefully maintained
taxonomy is the worst thing this tool could do.

**D14e never recommends an action.** A leak is frequently a different recording
from the official release, so the pre-release and post-release split may be
correct rather than accidental. It reports the dates and counts and leaves the
decision alone.

**Era findings are settled with evidence, not guesses.** Two era names differing
only by a trailing number could be a typo (`Yandhi` / `Yhandi`) or two real
projects (`Drip Season` / `Drip Season 3`), and play counts cannot separate
them. The MusicBrainz phase looks up whether each name exists as a release
group; if both do, the finding is dropped entirely. MusicBrainz search is fuzzy
and returns `Drip Season 3` when asked for `Drip Season`, so the Worker reports
an `exact` flag based on normalised title equality and the detector trusts only
that. Absence is treated as weak evidence, because era names often refer to
projects that were never released at all.

**A track under several eras is not an error.** This originally reported "one of
these eras is wrong", which is false. Songs routinely survive across album eras:
recorded for one project, held back, reworked, reconsidered for a later one. A
Kanye track filed under both `BULLY` and `Cuck` is legitimate. The tool now says
only that the two entries are indistinguishable in your data, and leaves it to
you whether to differentiate the track titles or drop a redundant era tag.

**Fuzzy artist matching is gated on shared track titles.** Two real artists can
differ by one character. The same artist misspelled will share tracks; two
different artists will not.

**Feature-credit stripping only fires on bracketed trailing clauses.** An
unbracketed `with` appears in real titles (`Dancing With Myself`, `With You`),
and merging genuinely different songs is the worst failure available here.

---

## Limits

- **Last.fm has no API for editing or deleting scrobbles.** It never has.
  Editing is also a paid Last.fm Pro feature. So this reports and you fix by
  hand, which is why the output gives exact before and after strings.
- **Case-only differences cannot be fixed by anyone**, due to how Last.fm
  stores names. They are reported in their own `unfixable` bucket so the list
  is not padded with impossible work.
- **Last.fm sends no CORS headers**, so this cannot run in a browser against
  the API. That is why the compute lives in a GitHub Action, and it is also why
  your key never reaches the frontend.
- **Title matching for unreleased material is weak.** Leaks circulate under
  working titles and get released under different ones, with no duration or
  fingerprint fallback. D14e says "possibly released, verify" and means it.

---

## Sharing this with other people

The current design works because it is one repo, one key, one user's public
data. Multi-user breaks it in three specific ways:

1. **A public repo cannot hold other people's listening history.** Your own is
   already public on Last.fm; theirs may not be, and it is personal data under
   GDPR regardless. That needs a lawful basis, retention limits and a working
   delete path, designed in rather than retrofitted.
2. **A shared API key means a shared rate limit** and one suspension takes
   everybody down.
3. **Last.fm asks to be contacted at partners@last.fm before commercial or
   large-scale use.** That email comes before the second user, not after.

The migration path is Cloudflare: Workers as the API proxy holding the key
server-side (which also solves CORS), D1 for per-user storage, Pages for the
frontend, which unlike GitHub Pages supports private repos on the free tier.
`detectors.py` ports across untouched, which is the whole reason it has no
dependencies.

---

## Licence

MIT
