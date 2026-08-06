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

Because it regenerates, rescanning occasionally beats one heroic cleanup. Lookup
answers are cached in your browser, so a repeat scan is fast and mostly shows you
what has changed since last time.

There was a scheduled GitHub Action that scanned one hardcoded username monthly
and committed the result to this repo. It is gone, for three reasons: it
published one person's listening history into a public repo permanently, it was
structurally single-tenant inside a tool meant for anyone, and its Node scanner
had no Spotify support, so the "official" monthly report used a slower and weaker
resolution path than the web app. That divergence is the same failure mode as the
Python copy before it.

| Detector | What it finds |
|---|---|
| **D0** | Consolidation target for split tracks, resolved via MusicBrainz |
| **D4** | One track's plays spread across several album strings |
| **D8** | Feature-credit splits (`Knife Talk` vs `Knife Talk (with …)`) and artist fields polluted with features |
| **D14** | Unreleased material, protected from every other detector |
| **D14a** | Inconsistent spelling of your own era convention (version markers excluded, see below) |
| **D14c** | One track title filed under several eras (informational) |
| **D14e** | Unreleased material that now has an official release (see caveat below) |
| **D14f** | A whole artist's unreleased output in one undifferentiated bucket (informational, unscored) |
| **D15** | One album split across two **album artists** (`Cruel Winter` by Kanye West and by Various Artists) |
| **D1** | Artist name variants |
| **D5 / D6 / D11 / D12** | Missing albums, duplicate scrobbles, Various Artists, impossible timestamps |

---

## Unreleased tagging: there is no standard

People tag unreleased music in at least six ways, and all of them are correct:

```
Unreleased (Rodeo Era)        the most common
Unreleased [Rodeo Era]        same, square brackets
Unreleased (Rodeo Sessions)   "sessions" instead of "era"
Rodeo Sessions                no "unreleased" marker at all
Unreleased (Rodeo)            bare parenthetical
Unreleased                    one bucket per artist, no era at all
```

All six are recognised, and the first five all resolve to the era name `Rodeo`
so they group together.

An earlier version understood only the first, and it failed in the worst
possible way: `Unreleased (Rodeo Sessions)` was classified as unreleased by the
`Unreleased` marker, so it was protected from every other detector, but yielded
**no era name**, so it was invisible to every era check. Tagged, protected, and
never examined. Silent, and worse than not supporting the form at all.

**Markers have two strengths, because some of these words title real albums.**

*Strong* markers are leak-culture vocabulary that essentially never titles a
commercial release: `unreleased`, `CDQ`, `OG file`, `reference track`. These
stand alone.

*Weak* markers are ordinary collection nouns: `leak(s)`, `snippet(s)`,
`outtake(s)`, `leftover(s)`, and a bare `X Sessions` / `X Era`. Lil Baby's
**The Leaks** is an officially released project. So is *Abbey Road Sessions*, and
*Spotify Sessions*. A weak marker only counts when **that same artist is strongly
marked somewhere else in the library**, which turns the convention into evidence
rather than a guess.

This matters more than a mislabelled row. The era guard **protects** whatever it
matches, excluding it from D0, D4 and D1 — so a real album classified as
unreleased silently stops being checked for splits, with no error anywhere. A
lost finding is worse than a visible mistake, and it is the failure mode this
whole area keeps producing.

**Version and sequel markers are never typos.** `Drip Season 1` and `Drip
Season 2` are two Gunna tapes; `Yandhi v1` and `Yandhi v2` are two leak packages.
These are dropped outright rather than reported at low confidence pending a
database ruling, which is what they used to do. In practice that ruling was
noise: it often could not be obtained at all, and MusicBrainz catalogues leaked
projects anyway, so both names frequently "existed" and nothing was settled. The
database check moved to the case where it can change the answer — a probable
typo like `Yandhi` versus `Yhandi`, which is now verified before being asserted.

**Report order is by what is worth fixing, not by play count.** Sorting by plays
put whatever happened to be popular at the top. The order below came from working
through a full report by hand:

1. Blank albums, which now carry the album each track should have
2. One track split across album strings, the findings that distort the charts
3. One track split across title variants
4. Artist name variants
5. Duplicate and impossible scrobbles, which are scrobbler bugs, not your doing
6. Unreleased tagging consistency, mostly informational

Plays break ties within a tier, so a four-play blank album now outranks a
580-play title split. `DETECTOR_ORDER` in `docs/drift.js` is the single place
that decides this, and a test asserts every detector has an explicit rank rather
than falling into the catch-all.

**MusicBrainz is a weak source for "has this leak been released", and only for
that question.** It documents music rather than commerce, so it catalogues leaked
and bootlegged projects as release groups. Kanye's `Yandhi` was never released
and is in there, so the detector once reported *"An official Album 'Yandhi'
(date unknown) contains a recording with this title"* for a track filed under
`Unreleased (Yandhi v2 Era)`. That is circular: it found the leak it was asked
about. Three guards:

1. **A release date is required.** Commercial releases have dates; leaked
   material catalogued after the fact often does not. This alone removes every
   `(date unknown)` finding.
2. **The match must not be the era itself.** If a track is filed under
   `Unreleased (Yandhi v2 Era)` and the match is a release group called `Yandhi`,
   that is the same unreleased project, not proof it came out.
3. **Spotify outranks MusicBrainz here.** Presence on Spotify means commercially
   available today, which is the question actually being asked; the two are
   reported at different confidence and the wording says which source answered.

**The single-bucket convention is not a defect.** Many people file everything
under one `Unreleased` per artist. D14f mentions it, offers the era conventions
as an option, and states plainly that nothing is wrong. It is marked
`style_choice`, which excludes it from the score entirely: a deliberate
convention must never cap someone's score, and an earlier draft that docked
points for it was wrong.

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

---

## Two signals that were sitting unused

**MusicBrainz IDs.** Every scrobble carries `album_mbid` and `track_mbid`. Both
were ingested by the Worker, carried through the whole pipeline, and read by
**zero detectors** — while this README advertised a "D3 — MusicBrainz ID
conflicts" that had never been written.

That was the single biggest miss in the project, because an MBID is ground truth
for the question D4 spends the most effort guessing at:

| Evidence | Meaning | Effect |
|---|---|---|
| Same `album_mbid`, different album strings | Provably one release, two spellings | `error` at 0.97, no lookup needed |
| Different `album_mbid` | Provably different releases | Downgraded to `review` at 0.15 |
| Either side missing | No evidence | Falls through to the heuristics |

The second row is what kills the false positives. The Jackson 5's *Dancing
Machine* appears on both `Get It Together` and `Dancing Machine`, with two
different album MBIDs — demonstrably not a split, and no amount of string
cleverness was going to work that out.

One caveat keeps it from being conclusive in both directions: `album_mbid`
identifies a **release**, not a release group, so the standard and deluxe
pressings of one album carry different IDs. A mismatch therefore downgrades
rather than suppresses. A match has no such ambiguity.

**Album artist is a different field from track artist.** Last.fm keys an album
entity on **(album artist, album title)**, so when Spotify re-credited Kanye's
`Cruel Winter` from "Kanye West" to "Various Artists", Last.fm gained a *second*
album with the same title and the plays divided between them.

Nothing here could see it, for a precise reason: `user.getRecentTracks` returns
the **track** artist, so both halves of that split are byte-identical in the
scrobble stream. Every grouping key in `drift.js` also begins with the artist, so
no cross-artist comparison was possible either.

`user.getTopAlbums` is the missing piece — each entry carries the album artist
and a play count, and it covers the whole chart rather than just the scanned
window. D15 only fires when the two credits are demonstrably **related**:

1. they share an album MBID → conclusive
2. one side is a Various Artists credit → the `Cruel Winter` shape
3. one artist name contains the other → `Kanye West` vs `Kanye West & Kid Cudi`

Anything else is silent even when the titles match exactly, because shared album
titles are extremely common: self-titled records, `Greatest Hits`, `Live`. The
accepted cost is missing a pure stage-name change (`Ye` versus `Kanye West`),
which containment cannot catch.

---

## The hygiene score

**100 is reserved for a library with nothing left to fix.** Any actionable
finding caps it at 99. A headline number that says *perfect* above a list of ten
problems is not a tuning problem, it is a broken claim, and that is exactly what
shipped in the first version.

Two things were wrong with the original formula:

**It was play share.** 30 affected plays out of 139,000 is 0.02%, which rounds to
perfect no matter how many distinct things are actually wrong. So the score was
really measuring library *size*, and got easier to ace the more you listened.

**One detector was omitted.** D14e findings fell into no bucket, so "this leak
has since been released" scored nothing at all. That omission was silent, which
is why `SCORED_DETECTORS` now exists and a test asserts that every detector
`analyse()` can emit is scored.

The four areas are combined with a **weighted geometric mean**. Geometric, so one
ruined area cannot be averaged away by three clean ones: three at 100 and one at
10 scores 56, not 78. Weighted by **coverage**, so an area is worth what it
touches, which is why a library that is 8% unreleased gives era consistency about
3% of its score rather than a flat quarter, and one with no unreleased material at
all does not score it and is told so. `weight_share` reports what each area was
worth, because a weighted score that hides its weights is harder to trust than a
crude one.

Within each area: the number of distinct findings, weighted by severity
(`error` 3, `split` 2) and by plays affected on a log scale,
against the count of **album strings**, which is the unit that actually gets
curated. Plays still matter, as a modifier rather than the denominator, so a
split affecting 400 plays outweighs one affecting 2 without letting a single
popular album sink the whole score.

Three deliberate exclusions:

- `unfixable` findings score zero. Last.fm gives you no way to act on them.
- `style_choice` findings score zero. A valid convention is not a defect.
- `review` findings score zero, and are not counted as actionable.

The last one was a third bug of the same family. `review` used to weigh 0.75, so
a library whose only findings were reviews — every one of them saying *probably
nothing to fix* — was capped below 100 and told it had "3 things you can fix".
Found on a real 329-scrobble library with three D4 reviews, two of them
MusicBrainz-**disproven** at 0.15 confidence. A maybe is not a task, and quantity
does not turn one into a task, so reviews are now reported and not scored.

The denominator has a floor of 80 album strings. Without it, a small library
bottoms out a whole bucket on a single finding, which is noise rather than
information.

`12` (the penalty a bucket absorbs per album string before hitting zero) and the
class weights are judgement calls about how alarmist to be, not facts. They are
the numbers to change if the score ever feels wrong.

---

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
limiter is not optional, and answers are cached permanently in the visitor's
own browser because release dates do not change.

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

The key goes into the Worker as a secret and nowhere else. It is never committed
and never reaches the browser.

### 2. Deploy the Worker

See **Deploying the Worker** above.

### 3. Enable GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder
**`/docs`**

Nothing is generated or committed. The site is static files plus the Worker.

---

## Running locally

Any static server. There is no build step, no bundler and no dependencies:
`docs/` is plain ES modules that browsers load directly.

```bash
npx http-server docs -p 8000
```

`docs/config.js` points at the Worker, so a local page still needs a deployed
Worker (or `npx wrangler dev` from `worker/`).

Tests, no dependencies and no network:

```bash
node scripts/test-era.mjs       # tagging conventions, era names, D14f
node scripts/test-score.mjs     # the 100-means-clean invariant, weighting
node scripts/test-spotify.mjs   # catalogue indexing, match tiers, editions
node scripts/test-worker.mjs    # release-type mapping, normaliser agreement
```

Then serve the frontend:

```bash
npx http-server docs -p 8000    # or any static server
```

The first deep scan is the slow one because the lookup cache is empty. Everything
after that reuses it.

---

## Design notes

**Detectors are pure functions over a list of scrobbles.** `docs/drift.js` does
no I/O and touches no DOM, network or framework. That is deliberate: the
detection logic is the actual asset, so it stays independent of where it runs and
every rule is testable offline with no API key and no fixtures.

**The era guard runs first.** Era-tagged unreleased material is partitioned out
before anything else, and D0, D4 and D1 never see it. Otherwise D0 would
resolve `Unreleased (Rodeo Era)` against MusicBrainz, find `Rodeo`, and
confidently recommend merging them, destroying a deliberate distinction.

This paragraph used to also name a **D13 orphan detector**, which would have
flagged strings with near-zero global listeners as probable typos. It was never
written, so the guard was documented as protecting against nothing. It is
deliberately not being built: it needs one `getInfo` call per distinct string,
which is impossible across 15,000 album strings, and capping it would inspect
only the popular strings, which are the least likely to be typos. D1, D4 and D8
already catch typos by comparing strings against each other inside the library.
If revisited, the honest form is a listener-count signal that **ranks** existing
findings rather than generating new ones. Confidently damaging a carefully maintained
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
- **Last.fm sends no CORS headers**, so a browser cannot call the API directly.
  A Cloudflare Worker proxies it, which is also what keeps the key off the
  frontend. The analysis itself still runs entirely in the browser.
- **Title matching for unreleased material is weak.** Leaks circulate under
  working titles and get released under different ones, with no duration or
  fingerprint fallback. D14e says "possibly released, verify" and means it.

---

## Sharing this with other people

Two of the three original blockers are designed out rather than mitigated:

**Other people's listening history.** There is nowhere to put it. The Worker
proxies and forgets, and the analysis runs in the visitor's own browser with
results stored only in their own IndexedDB. No database, so no lawful basis to
establish, no retention policy to write, no deletion endpoint to build and no
breach surface. This is why the scheduled scan that committed a report to this
repo was removed: it was the one component that published anything.

**A shared API key means a shared rate limit**, and one suspension takes
everybody down. Mitigated in layers rather than solved: pacing, per-IP budgets, a
shared ceiling, a circuit breaker on upstream pushback, edge caching, and a
bring-your-own-key path that removes the shared resource entirely. Two of those
layers are per-Cloudflare-location rather than global, which is documented above
and not pretended otherwise.

**Still outstanding: Last.fm asks to be contacted at partners@last.fm before
commercial or large-scale use.** That email belongs before the second user, not
after.

---

## Licence

MIT
