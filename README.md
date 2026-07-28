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
| **D14c** | One track filed under two different eras |
| **D14e** | Unreleased material that now has an official release |
| **D1 / D3 / D7** | Artist name variants, MBID conflicts, casing-only variants |
| **D5 / D6 / D11 / D12** | Missing albums, duplicate scrobbles, Various Artists, impossible timestamps |

**D2 is deliberately not run.** It would compare your stored names against
Last.fm's canonical forms and recommend "fixing" them. With autocorrect off
that is backwards: it would tell you to rewrite `Travis Scott` as
`Travi$ Scott`. Divergence from Last.fm canonical is not an error.

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

The upside of that split is that **nothing is ever stored**. The Worker proxies
and forgets; analysis happens in the visitor's tab and dies with it. No data at
rest means no retention policy, no deletion endpoint and no breach surface.

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

Python 3.12, no dependencies. Stdlib only, on purpose: nothing to pin, nothing
to audit, nothing to break in six months.

```bash
cp .env.example .env      # then put your key in it, it is git-ignored
python scripts/run.py                      # local detectors only, ~3 min
python scripts/run.py --resolve            # also resolve via MusicBrainz
python scripts/run.py --limit 5000         # quick smoke test
```

Then open `docs/index.html`, or serve it:

```bash
python -m http.server -d docs 8000
```

The first `--resolve` run is the slow one because the MusicBrainz cache is
empty. `--budget` caps lookups per run, and the busiest issues are resolved
first so a small budget still lands where it matters.

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
