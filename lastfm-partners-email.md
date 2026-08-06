# Draft: email to partners@last.fm

Deliberately at the repo root, not in `docs/`. Everything in `docs/` is published by
Cloudflare Pages, and an earlier copy of this letter went live on the site.
Delete `docs/lastfm-partners-email.md`.

**Subject:** API approval request, non-commercial open-source tool (Scrobble Drift)

---

Hello,

I have built a free, non-commercial, open-source tool called Scrobble Drift, and I
would like your approval before making it publicly available, per clause 2.7 of the
API Terms of Service.

**What it does.** It reads a Last.fm user's listening history and reports metadata
problems in it: one album split across two spellings, a single that later got
absorbed into an album, duplicate scrobbles, artist name variants. It is a
diagnostic tool. It suggests corrections for the user to make themselves on
Last.fm, and it cannot and does not modify anything.

**How it is built.**

- Read-only. It calls `user.getRecentTracks`, `user.getTopAlbums`, `user.getInfo`,
  `album.getInfo` and `artist.getInfo`, and nothing else. The proxy enforces this
  with an allowlist, so no write method can be reached even by a modified client.
- No login and no authentication. It never asks for a password or session, and it
  calls no authenticated method.
- All analysis runs in the visitor's own browser. Their scrobbles stay in their own
  browser storage and on no server of mine. There is no database of Last.fm data,
  no user accounts, and no logging of listening data.
- The only server-side component is a thin proxy on Cloudflare Workers. It exists
  because the API sends no CORS headers and because the API key must not reach the
  client. It caches responses in line with the HTTP headers you send.
- Release dates and album membership come from MusicBrainz and Spotify, not from
  Last.fm, so those lookups place no load on your API.
- Attribution and links are in place: a "Powered by Last.fm" credit in the footer,
  and every finding deep-links to the relevant page in the user's own library, or
  to the artist, album or track catalogue page.

Source: https://github.com/ArjanKnol/scrobble-drift
Site: https://scrobble-drift.pages.dev

**Three things I would like your guidance on.**

1. **Public access (2.7).** May I make the site publicly available? I intend to
   share it in music and Last.fm communities.

2. **Rate limits (4.4).** All traffic currently uses one API key, so concurrency
   matters more than any single scan. The client paces itself deliberately: a
   complete scan of a 140,000-scrobble history takes about eleven minutes and
   sustains roughly **one page per second**, which I measured rather than
   estimated. On top of that there is per-IP burst and page budgeting, a
   shared-key ceiling, a circuit breaker that stops immediately on error 29 or
   HTTP 429, response caching so a repeat scan of the same user costs nothing
   upstream, and an option for visitors to supply their own API key and bypass the
   shared budget entirely.

   I would rather be told a number than guess at one. If you would prefer a
   specific ceiling, or that I require visitors to use their own key, I will
   implement whatever you specify.

   One observation you may find useful: while testing deep pagination I saw
   `user.getRecentTracks` return HTTP 500 fairly reliably around page 640 of 700
   when requests were sent in quick succession, and not at all once the client was
   paced to one page per second. It looked like load shedding rather than a bug,
   but I mention it in case it is useful signal.

3. **Unreleased material (5.1.8).** Many Last.fm users tag unreleased or leaked
   recordings in their own libraries, and the tool reports inconsistencies in how
   those entries are named, exactly as it does for commercial releases. It works
   only on scrobbles the user already has, it links only to Last.fm, and it
   neither hosts, distributes nor links to any audio. I am raising it explicitly
   so you can tell me if you would prefer that area removed.

I am happy to make any change you ask for, including removing the tool, and I would
rather agree terms with you before it is public than after.

Kind regards,

Arjan Knol
arjan.knol@nowonline.com
