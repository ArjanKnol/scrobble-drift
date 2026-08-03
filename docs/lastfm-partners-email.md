# Draft: email to partners@last.fm

Not committed as part of the app. Delete once sent, or keep it as a record of what
was disclosed and when.

**Subject:** API approval request, non-commercial open-source tool (Scrobble Drift)

---

Hello,

I have built a free, non-commercial, open-source tool called Scrobble Drift and I
would like your approval before making it publicly available, per clause 2.7 of
the API Terms of Service.

**What it does.** It reads a Last.fm user's listening history and reports metadata
problems in it: one album split across two spellings, a single that later got
absorbed into an album, duplicate scrobbles, artist name variants. It is a
diagnostic tool. It suggests corrections for the user to make themselves on
Last.fm, and it cannot and does not modify anything.

**How it is built.**

- Read-only. It calls `user.getRecentTracks`, `user.getTopAlbums`,
  `user.getInfo`, `album.getInfo` and `artist.getInfo`, and nothing else. The
  proxy enforces this with an allowlist, so no write method can be reached even
  by a modified client.
- No login and no authentication. It never asks for a user's password or session,
  and it calls no authenticated method.
- All analysis runs in the visitor's own browser. Their scrobbles are held in
  their own browser storage and on no server of mine. There is no database of
  Last.fm data, no user accounts and no logging of listening data.
- The only server-side component is a thin proxy on Cloudflare Workers, which
  exists because the API sends no CORS headers and because the API key must not
  reach the client. It caches responses in line with the HTTP headers you send.
- Attribution and links are in place: a "Powered by Last.fm" credit in the
  footer, and every finding deep-links to the relevant page in the user's own
  library, or to the artist, album or track catalogue page.

Source: https://github.com/ArjanKnol/scrobble-drift
Site: https://scrobble-drift.pages.dev

**Three things I would like your guidance on.**

1. **Public access (2.7).** May I make the site publicly available? I intend to
   share it in music and Last.fm communities.

2. **Rate limits (4.4).** Today all traffic uses one API key. A full scan of a
   large history is a few hundred `getRecentTracks` pages, so concurrency is the
   thing that matters rather than any single scan. I have built in layered
   protection: per-request pacing, per-IP burst and page budgets, a shared-key
   ceiling, a circuit breaker that stops immediately on error 29 or HTTP 429,
   response caching so repeat scans of the same user cost nothing upstream, and
   an option for visitors to supply their own API key and bypass the shared
   budget entirely. If you would prefer that I require visitors to use their own
   key, or if you would rather set a specific ceiling, I will implement whatever
   you specify.

3. **Unreleased material (5.1.8).** Many Last.fm users tag unreleased or leaked
   recordings in their libraries, and the tool reports inconsistencies in how
   those entries are named, in the same way it does for commercial releases. It
   works only on scrobbles the user already has, it links only to Last.fm, and it
   neither hosts, distributes nor links to any audio. I am raising it explicitly
   so you can tell me if you would prefer that area removed.

I am happy to make any change you ask for, including removing the tool, and I
would rather agree the terms with you before it is public than after.

Kind regards,

Arjan Knol
arjan.knol@nowonline.com
