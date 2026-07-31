/**
 * Scrobble Drift API proxy (Cloudflare Worker).
 *
 * Exists for exactly two reasons:
 *   1. Last.fm sends no Access-Control-Allow-Origin header, so a browser
 *      cannot call the API directly. No amount of frontend code fixes that.
 *   2. The API key must never reach the client.
 *
 * Deliberately NOT a scanner. It proxies, rate limits, and forgets. All
 * analysis happens in the visitor's browser, which means no scrobble data is
 * ever stored, logged, or transmitted anywhere except between Last.fm and the
 * person it belongs to. There is no data at rest, so no retention policy to
 * write, no deletion endpoint to build, and no breach surface.
 *
 * ---------------------------------------------------------------------------
 * RATE LIMITING: what is actually scarce
 * ---------------------------------------------------------------------------
 * Not Cloudflare requests. A 10k-scrobble scan is ~4 Worker requests but ~50
 * Last.fm calls. The scarce resource is upstream calls against ONE shared API
 * key, and Last.fm suspends keys it sees abused (error 26), which would break
 * the site for everybody at once.
 *
 * Community consensus puts Last.fm's tolerance near 5 requests/second per key.
 * A single in-flight scan fetching pages back-to-back already sits at roughly
 * that. So the danger is concurrency, and the defence is layered:
 *
 *   1. PACING      - upstream calls within one request are spaced out, so no
 *                    single scan can burst.
 *   2. PER-CLIENT  - burst + page budget per IP, so one person cannot hog.
 *   3. SHARED      - a ceiling on page fetches against the shared key.
 *   4. BREAKER     - if Last.fm actually pushes back (error 29 / HTTP 429),
 *                    stop immediately for a cooldown rather than hammering.
 *   5. CACHE       - repeat scans of the same user cost nothing upstream.
 *                    This matters most in exactly the viral case, where many
 *                    people scan the same handful of usernames.
 *   6. OWN KEY     - visitors can supply their own API key and bypass the
 *                    shared-key budget entirely. This is the only thing that
 *                    actually scales, because it removes the shared resource.
 *
 * Two honest limitations of layer 3, straight from Cloudflare's docs:
 *   - Rate limits are per Cloudflare location, NOT global. A "global" key is
 *     really per-datacentre, so worldwide traffic multiplies the ceiling.
 *   - The API is eventually consistent and "intentionally designed to not be
 *     used as an accurate accounting system". It will overshoot.
 * A true global counter needs Durable Objects, which are Workers Paid only.
 * Layers 1, 4, 5 and 6 are what carry the load; layer 3 is a coarse backstop.
 */

/*
 * A build marker, so "is the running Worker the code I am looking at?" is a
 * question with an answer.
 *
 * Three separate rounds of debugging were spent on a deployed build being older
 * than the source, and each time the symptom was indistinguishable from a real
 * bug: the Spotify limit fix appeared not to work, and a cached error response
 * appeared to be a failed deploy. Guessing from behaviour cannot settle it,
 * because behaviour is exactly what is in question.
 *
 * Bump this in the same commit as any Worker change. /api/health reports it.
 */
const BUILD = "2026-07-31-6-page-size-10-probe-removed";

const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const MB = "https://musicbrainz.org/ws/2";
const SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

// Only read methods. An allowlist, not a denylist: a proxy that forwards
// arbitrary methods is an open relay for someone else's credentials, and
// track.scrobble / track.love would let a caller write to accounts.
const ALLOWED = new Set([
  "user.getInfo",
  "user.getRecentTracks",
  "user.getTopAlbums",
  "user.getTopArtists",
  "user.getTopTracks",
  "artist.getInfo",
  "album.getInfo",
  "track.getInfo",
]);

const MAX_BATCH = 8;          // upstream pages per request (was 20)
const PACE_MS = 130;          // gap between upstream calls, ~7/s ceiling
const UPSTREAM_TTL = 1800;    // 30 min edge cache on Last.fm responses
const BREAKER_SECONDS = 120;  // cooldown after Last.fm pushes back
const USER_RE = /^[A-Za-z0-9_.-]{2,20}$/;
const KEY_RE = /^[a-f0-9]{32}$/i;   // Last.fm API keys are 32 hex chars

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          build: BUILD,
          configured: Boolean(env.LASTFM_API_KEY),
          spotify: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
          limiters: {
            burst: Boolean(env.RL_BURST),
            pages: Boolean(env.RL_PAGES),
            shared: Boolean(env.RL_SHARED),
            // MusicBrainz protection is reported separately, because it was
            // absent entirely for a while and "the limiters are configured" was
            // true the whole time. A single boolean that hides a missing layer
            // is worse than no boolean.
            mb_client: Boolean(env.RL_MB),
            mb_shared: Boolean(env.RL_MB_SHARED),
          },
          // Whether the shared MusicBrainz answer cache is wired up. Optional by
          // design, so this says which mode the Worker is really in rather than
          // leaving it to be inferred from response times.
          mb_cache: Boolean(env.MB_CACHE),
          mb_cache_rows: env.MB_CACHE
            ? await env.MB_CACHE.prepare("SELECT COUNT(*) AS n FROM mb_cache")
                .first("n").catch(() => null)
            : null,
          cooling_down: await breakerActive(),
          mb_cooling_down: await mbBreakerActive(),
        }, 200, cors);
      }

      // `return await`, not `return`, on every one of these.
      //
      // `return someAsyncFn()` hands back a PENDING promise. The try block then
      // completes, so when that promise later rejects there is no longer a catch
      // on the stack: the rejection escapes to the runtime and Cloudflare serves
      // its own error 1101 page. The handler's careful error handling below was
      // dead code for every route.
      //
      // It cost hours to find, because the symptom is a blank page with no
      // status, no body and no hint that your own code ever ran.
      if (url.pathname === "/api/lastfm") return await lastfm(url, env, cors);
      if (url.pathname === "/api/scrobbles") {
        return await scrobbles(url, request, env, cors);
      }
      if (url.pathname === "/api/mb/recording") {
        return await mbRecording(url, env, request, cors);
      }
      if (url.pathname === "/api/mb/artist-id") {
        return await mbArtistId(url, env, request, cors);
      }
      if (url.pathname === "/api/mb/artist-catalogue") {
        return await mbArtistCatalogue(url, env, request, cors);
      }
      if (url.pathname === "/api/mb/release-group") {
        return await mbReleaseGroup(url, env, request, cors);
      }

      if (url.pathname === "/api/spotify/artist-albums") {
        return await spArtistAlbums(url, env, cors);
      }
      if (url.pathname === "/api/spotify/album-tracks") {
        return await spAlbumTracks(url, env, cors);
      }
      /*
       * TEMPORARY diagnostic. Remove once the Spotify 400 is settled.
       *
       * Exists because narrowing this by redeploying one guess at a time is
       * slow and we have already lost time to that on this project. It tries
       * the same request with one variable changed at a time and reports the
       * status of each, so a single deploy identifies the offending parameter
       * instead of six.
       *
       * Read-only, no secrets in the output, and it spends a handful of
       * Spotify calls. Delete this block before it is forgotten.
       */

      if (url.pathname === "/api/spotify/album") {
        return await spAlbum(url, env, cors);
      }

      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      console.error(err?.stack || String(err));
      if (err instanceof Retryable) {
        return json({ error: err.message, retry_after: err.retryAfter }, 429,
                    { ...cors, "Retry-After": String(err.retryAfter),
                      "Cache-Control": "no-store" });
      }
      // A short, scrubbed reason. Without one, every upstream problem looked
      // identical from the client and could only be diagnosed with `wrangler
      // tail`, which is not available to anyone but the operator.
      //
      // Scrubbed because callLastfm puts the API key in a URL, and a fetch
      // error can quote that URL. Any 32-hex run is redacted before it leaves
      // the Worker, so a leak cannot happen by accident here.
      /*
       * `no-store`, because a cached error is a pinned error.
       *
       * Observed live: after the Spotify fix was deployed and provably working,
       * the same URL kept returning the old 400 while the identical URL with one
       * extra query parameter returned data. The failure had been cached and was
       * being served over a working Worker, which is indistinguishable from "the
       * fix did not deploy" and cost a round of confusion.
       *
       * Success responses are cacheable and say so individually. A failure never
       * is: it describes a moment, not a fact. This project has now been bitten
       * by a cached negative three times, twice in the Spotify catalogue and once
       * here.
       */
      return json({
        error: "upstream failure",
        reason: redact(`${err?.name || "Error"}: ${err?.message || err}`),
      }, 502, { ...cors, "Cache-Control": "no-store" });
    }
  },
};

/* ---------------------------------------------------------------- helpers */

class Retryable extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/**
 * Strip anything that looks like a credential from a string bound for a client.
 *
 * 32 hex characters is a Last.fm API key. Spotify tokens are long base64-ish
 * runs. Neither should ever appear in an error message, and the cheapest way to
 * guarantee that is to redact at the boundary rather than audit every throw
 * site for what it might interpolate.
 */
function redact(s) {
  return String(s)
    .replace(/[a-f0-9]{32}/gi, "[redacted-key]")
    .replace(/Bearer\s+[\w.-]+/gi, "Bearer [redacted]")
    .replace(/[\w-]{40,}/g, "[redacted-token]")
    .slice(0, 300);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = (env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allow.includes("*") || allow.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientId(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/**
 * Circuit breaker, backed by the Cache API rather than KV.
 *
 * Deliberate: KV's free tier allows 100k reads and only 1k writes per day, and
 * checking a breaker on every request would consume the entire read budget.
 * The Cache API is free, has no quota, and is per-location -- which is the
 * right scope anyway, since upstream pushback we observe in one location is
 * evidence about that location's traffic.
 */
const BREAKER_URL = "https://scrobble-drift.internal/breaker";

async function breakerActive() {
  const hit = await caches.default.match(new Request(BREAKER_URL));
  return Boolean(hit);
}

async function tripBreaker() {
  await caches.default.put(
    new Request(BREAKER_URL),
    new Response("cooling down", {
      headers: { "Cache-Control": `max-age=${BREAKER_SECONDS}` },
    }),
  );
}

/* ------------------------------------------------------- MusicBrainz load --
 * MusicBrainz asks for ONE request per second per application and says plainly
 * what happens otherwise: "If you impact the server by making more than one
 * call per second, your IP address may be blocked preventing all further access
 * to MusicBrainz."
 *
 * The pacing that existed was a Pacer in each visitor's browser at 1/s. That is
 * per TAB. Thirty people scanning at once is thirty calls a second, arriving from
 * Cloudflare IPs under one User-Agent, and the thing that gets blocked is shared
 * by everyone. The `cf.cacheTtl` on each fetch helped, but Cloudflare's cache is
 * per LOCATION, so the same artist can still be fetched once per datacentre, and
 * a cache does nothing at all about the rate when the requests are for different
 * artists.
 *
 * Three layers, in order of how much they actually help:
 *
 *   1. SHARED CACHE  - one D1 row per answer, global and persistent, so an artist
 *                      any visitor has ever looked up is never fetched again.
 *                      This is the real fix. Listening is heavily power-law
 *                      distributed, so a few thousand artists cover most users
 *                      and the hit rate climbs steeply with traffic. It also
 *                      collapses demand ACROSS locations, which the edge cache
 *                      cannot do.
 *   2. BREAKER       - if MusicBrainz pushes back, stop for a cooldown instead of
 *                      continuing to knock. Separate from the Last.fm breaker:
 *                      they are different quotas and conflating them would let
 *                      one service's trouble silence the other.
 *   3. PER-IP BUDGET - one visitor cannot spend the whole allowance.
 *
 * What this does NOT do is make exceeding 1/s impossible. Only a single global
 * queue draining at exactly one per second could promise that, and that needs
 * Durable Objects plus an asynchronous first-scan experience. This reduces the
 * load by a large factor and stops the runaway cases; it is a mitigation, not a
 * guarantee, and it should not be described as one.
 */
const MB_UA = "ScrobbleDrift/0.1 (+https://github.com/ArjanKnol/scrobble-drift)";
const MB_BREAKER_URL = "https://scrobble-drift.internal/mb-breaker";
const MB_BREAKER_SECONDS = 60;
const MB_TTL_DAYS = 30;        // artist catalogues change slowly

/** Upstream said no. Thrown, never returned, so a failure is never cached. */
export class Upstream extends Error {}

async function mbBreakerActive() {
  return Boolean(await caches.default.match(new Request(MB_BREAKER_URL)));
}

async function tripMbBreaker() {
  await caches.default.put(
    new Request(MB_BREAKER_URL),
    new Response("cooling down", {
      headers: { "Cache-Control": `max-age=${MB_BREAKER_SECONDS}` },
    }),
  );
}

/** Per-visitor MusicBrainz budget. Missing binding fails open, as elsewhere. */
export async function chargeMb(env, ip) {
  if (env.RL_MB) {
    const { success } = await env.RL_MB.limit({ key: ip });
    if (!success) {
      throw new Retryable(
        "You have looked up a lot of releases in the last minute. MusicBrainz " +
        "allows one request per second in total, shared by everyone using this " +
        "site, so this pauses briefly.", 60);
    }
  }
  if (env.RL_MB_SHARED) {
    const { success } = await env.RL_MB_SHARED.limit({ key: "mb" });
    if (!success) {
      throw new Retryable(
        "Release lookups are busy right now. Your findings are unaffected: " +
        "this step only adds release dates. Try again in a minute.", 60);
    }
  }
}

/**
 * One fetch to MusicBrainz, with the mandatory User-Agent and consistent
 * handling of pushback.
 *
 * Every handler used to inline its own copy of the headers, and they had drifted:
 * two checked for 503 and two did not, so half of MusicBrainz's "slow down"
 * responses were reported to the visitor as a generic 502 while we carried on
 * requesting at the same rate. 429 was checked nowhere.
 */
async function mbFetch(path) {
  if (await mbBreakerActive()) {
    throw new Retryable(
      "Pausing release lookups: MusicBrainz asked us to slow down.",
      MB_BREAKER_SECONDS);
  }
  const res = await fetch(`${MB}${path}`, {
    headers: { "User-Agent": MB_UA, Accept: "application/json" },
    cf: { cacheTtl: MB_TTL_DAYS * 86400, cacheEverything: true },
  });
  if (res.status === 503 || res.status === 429) {
    await tripMbBreaker();
    throw new Retryable("MusicBrainz is rate limiting us.", 5);
  }
  return res;
}

/**
 * Answer from the shared cache, or produce the answer and store it.
 *
 * `produce` must THROW on failure rather than returning an error body, so that a
 * transient outage is never written to the cache and served for thirty days. A
 * negative answer is different: "MusicBrainz has never heard of this" is a real
 * and stable result, and genuinely unreleased material is exactly what this tool
 * is about, so those are cached deliberately.
 *
 * Every cache fault is swallowed. A cache is an optimisation, and a broken one
 * must degrade to "ask MusicBrainz" rather than break the request. If the D1
 * binding is absent entirely, this is a pass-through, so the Worker deploys and
 * works before the database exists.
 */
export async function mbShared(env, key, produce) {
  const db = env.MB_CACHE;
  const cutoff = Math.floor(Date.now() / 1000) - MB_TTL_DAYS * 86400;

  if (db) {
    try {
      const row = await db
        .prepare("SELECT v FROM mb_cache WHERE k = ?1 AND created > ?2")
        .bind(key, cutoff).first();
      if (row?.v) return { body: JSON.parse(row.v), shared: true };
    } catch (err) {
      console.error("mb_cache read failed: " + (err?.message || err));
    }
  }

  const body = await produce();

  if (db) {
    try {
      await db.prepare(
        "INSERT INTO mb_cache (k, v, created) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, created = excluded.created")
        .bind(key, JSON.stringify(body), Math.floor(Date.now() / 1000)).run();
    } catch (err) {
      console.error("mb_cache write failed: " + (err?.message || err));
    }
  }
  return { body, shared: false };
}

/**
 * Charge the limiters for one upstream page fetch.
 *
 * Missing bindings fail OPEN so a fresh deploy still works. That is a
 * deliberate tradeoff for first-run convenience and it means an unconfigured
 * Worker has NO protection: configure all three before sharing the URL.
 * /api/health reports which are live.
 */
async function chargePage(env, ip) {
  if (env.RL_PAGES) {
    const { success } = await env.RL_PAGES.limit({ key: ip });
    if (!success) {
      throw new Retryable(
        "You have scanned a lot in the last minute. Give it 60 seconds, or " +
        "supply your own Last.fm API key for unlimited scanning.", 60);
    }
  }
  if (env.RL_SHARED) {
    const { success } = await env.RL_SHARED.limit({ key: "shared-key" });
    if (!success) {
      throw new Retryable(
        "Scrobble Drift is busy, a lot of people are scanning right now. " +
        "Try again in a minute, or supply your own Last.fm API key to skip " +
        "the shared budget entirely.", 60);
    }
  }
}

/** One check per scan request, so a client cannot open many scans at once. */
async function chargeBurst(env, ip) {
  if (!env.RL_BURST) return;
  const { success } = await env.RL_BURST.limit({ key: ip });
  if (!success) {
    throw new Retryable(
      "Too many scan requests at once. Wait a few seconds.", 10);
  }
}

function requireKey(env, supplied) {
  // A visitor-supplied key is used as-is and never stored or logged. It only
  // exists in memory for the lifetime of the request.
  if (supplied) {
    if (!KEY_RE.test(supplied)) throw new Error("malformed api key");
    return { key: supplied, shared: false };
  }
  if (!env.LASTFM_API_KEY) {
    throw new Error("LASTFM_API_KEY secret is not set on this Worker");
  }
  return { key: env.LASTFM_API_KEY, shared: true };
}

async function callLastfm(params, apiKey) {
  const qs = new URLSearchParams({
    ...params,
    api_key: apiKey,
    format: "json",
    // Autocorrect stays off. We need what the user actually stored, not
    // Last.fm's opinion of it.
    autocorrect: "0",
  });
  const res = await fetch(`${LASTFM}?${qs}`, {
    headers: { "User-Agent": "ScrobbleDrift/0.1 (+https://github.com/ArjanKnol/scrobble-drift)" },
    // Long TTL is a rate-limiting measure as much as a speed one: in the viral
    // case many people scan the same few usernames, and those cost nothing.
    cf: { cacheTtl: UPSTREAM_TTL, cacheEverything: true },
  });

  // Last.fm pushing back is the strongest possible signal. Trip the breaker
  // rather than continuing to hammer a key that is already in trouble.
  if (res.status === 429) {
    await tripBreaker();
    throw new Retryable("Last.fm is rate limiting us. Pausing briefly.",
                        BREAKER_SECONDS);
  }
  if (!res.ok) throw new Error(`last.fm http ${res.status}`);

  const data = await res.json();
  if (data.error) {
    // 29 = rate limit exceeded, 26 = suspended key. Both mean stop now.
    if (data.error === 29 || data.error === 26) {
      await tripBreaker();
      throw new Retryable(
        data.error === 26
          ? "The shared API key has been suspended. Supply your own key to " +
            "keep scanning."
          : "Last.fm is rate limiting us. Pausing briefly.",
        BREAKER_SECONDS);
    }
    const e = new Error(data.message || "last.fm error");
    e.lastfm = data.error;
    throw e;
  }
  return data;
}

/* ----------------------------------------------------------------- routes */

/** Single passthrough call, for user.getInfo and metadata lookups. */
async function lastfm(url, env, cors) {
  const method = url.searchParams.get("method");
  if (!ALLOWED.has(method)) {
    return json({ error: `method not allowed: ${method}` }, 400, cors);
  }
  const params = {};
  for (const [k, v] of url.searchParams) {
    // Never let a caller inject their own api_key here or flip autocorrect.
    if (["api_key", "format", "autocorrect", "key"].includes(k)) continue;
    params[k] = v;
  }
  if (params.user && !USER_RE.test(params.user)) {
    return json({ error: "invalid username" }, 400, cors);
  }
  const { key } = requireKey(env, url.searchParams.get("key"));
  try {
    return json(await callLastfm(params, key), 200, cors);
  } catch (err) {
    if (err instanceof Retryable) throw err;
    return json({ error: err.message, lastfm: err.lastfm ?? null },
                err.lastfm === 6 ? 404 : 502, cors);
  }
}

/**
 * Batched scrobble pages. The client walks pages; this fetches up to
 * MAX_BATCH per request, paced, and flattens to the detector shape.
 */
async function scrobbles(url, request, env, cors) {
  const user = url.searchParams.get("user") || "";
  if (!USER_RE.test(user)) {
    return json({ error: "invalid username" }, 400, cors);
  }

  const { key, shared } = requireKey(env, url.searchParams.get("key"));
  const ip = clientId(request);

  // Own-key callers skip the breaker and both shared-key budgets: their
  // traffic spends their own quota and cannot hurt anyone else.
  if (shared) {
    if (await breakerActive()) {
      throw new Retryable(
        "Pausing briefly, Last.fm asked us to slow down. Try again shortly, " +
        "or supply your own Last.fm API key to scan immediately.",
        BREAKER_SECONDS);
    }
    await chargeBurst(env, ip);
  }

  const from = Math.max(1, Number(url.searchParams.get("from") || 1));
  const count = Math.min(MAX_BATCH,
                         Math.max(1, Number(url.searchParams.get("count") || 5)));

  const out = [];
  let totalPages = 1, totalScrobbles = 0, fetched = 0;

  for (let i = 0; i < count; i++) {
    const page = from + i;

    // Charge before spending, so a rejected request has not already cost an
    // upstream call.
    if (shared) await chargePage(env, ip);

    // Sequential and paced. Hammering Last.fm with concurrent requests is how
    // a shared key gets suspended, and one unpaced scan is enough to do it.
    if (i > 0) await sleep(PACE_MS);

    let data;
    try {
      data = await callLastfm(
        { method: "user.getRecentTracks", user, limit: "200", page: String(page) },
        key);
    } catch (err) {
      if (err instanceof Retryable) {
        // Return what we already have so the client can keep partial results
        // and resume, rather than losing the whole scan.
        if (out.length) break;
        throw err;
      }
      if (err.lastfm === 6) return json({ error: "no such user" }, 404, cors);
      throw err;
    }

    const rt = data.recenttracks || {};
    const attr = rt["@attr"] || {};
    totalPages = Number(attr.totalPages || 1);
    totalScrobbles = Number(attr.total || 0);
    let tracks = rt.track || [];
    if (!Array.isArray(tracks)) tracks = [tracks];
    for (const t of tracks) {
      // The now-playing track has no date and is not a scrobble yet.
      if (t?.["@attr"]?.nowplaying === "true" || !t?.date?.uts) continue;
      out.push({
        uts: Number(t.date.uts),
        artist: (t.artist?.["#text"] || t.artist?.name || "").trim(),
        artist_mbid: t.artist?.mbid || "",
        album: (t.album?.["#text"] || "").trim(),
        album_mbid: t.album?.mbid || "",
        track: (t.name || "").trim(),
        track_mbid: t.mbid || "",
      });
    }
    fetched = page;
    if (page >= totalPages) break;
  }

  return json({
    scrobbles: out,
    next: fetched < totalPages ? fetched + 1 : null,
    total_pages: totalPages,
    total_scrobbles: totalScrobbles,
    shared_key: shared,
  }, 200, cors);
}

/**
 * MusicBrainz recording lookup, summarised to release groups.
 *
 * MusicBrainz enforces 1 request/second with IP blocking. This proxies one
 * lookup per request and leans on Cloudflare's cache; the client paces itself.
 * Release dates never change, so a long TTL costs nothing and protects
 * MusicBrainz from us.
 */
/**
 * Does a release group with this title exist for this artist?
 *
 * Used to settle era-name disputes with evidence instead of a heuristic. When
 * a library contains both "Drip Season" and "Drip Season 3", asking whether
 * each one exists as a real Gunna release group is far better than guessing
 * from play counts whether one is a typo of the other.
 *
 * CRITICAL: MusicBrainz search is fuzzy and will happily return "Drip Season 3"
 * when asked for "Drip Season". Returning results is therefore not evidence of
 * existence. The response reports `exact`, set only when a returned title
 * matches after normalisation, and callers must use that rather than counting
 * results.
 */
async function mbReleaseGroup(url, env, request, cors) {
  const artist = (url.searchParams.get("artist") || "").slice(0, 200);
  const title = (url.searchParams.get("title") || "").slice(0, 200);
  if (!artist || !title) {
    return json({ error: "artist and title required" }, 400, cors);
  }
  await chargeMb(env, clientId(request));
  const { body, shared } = await mbShared(
    env, `rg:${spNorm(artist)}\u241f${spNorm(title)}`, async () => {
  const esc = (s) => s.replace(/[\\+\-!(){}\[\]^"~*?:/&|]/g, (c) => "\\" + c);
  const query = `artist:"${esc(artist)}" AND releasegroup:"${esc(title)}"`;
  const res = await mbFetch(
    `/release-group?query=${encodeURIComponent(query)}&fmt=json&limit=25`);
  if (!res.ok) throw new Upstream(`musicbrainz http ${res.status}`);
  const data = await res.json();

  // Normalise the same way the detectors do, so "Drip Season" and
  // "drip  season" agree but "Drip Season 3" does not.
  const norm = (s) => (s || "").toLowerCase()
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const want = norm(title);

  const groups = (data["release-groups"] || []).map((g) => ({
    title: g.title,
    primary: g["primary-type"] || null,
    secondary: g["secondary-types"] || [],
    first_release: g["first-release-date"] || null,
    exact: norm(g.title) === want,
  }));

  return {
    exists: groups.some((g) => g.exact),
    matches: groups.filter((g) => g.exact).slice(0, 5),
    near: groups.filter((g) => !g.exact).slice(0, 5),
  };
  });
  return json({ ...body, shared }, 200,
              { ...cors, "Cache-Control": "public, max-age=86400" });
}

/**
 * MusicBrainz artist catalogue: every official release WITH its tracklist.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The Spotify catalogue trick cut per-track lookups to per-artist ones and made
 * that phase ~5x faster. The same idea was never applied to MusicBrainz, where it
 * is worth far more, because MusicBrainz allows only ONE request per second. A
 * residual of 300 tracks is 5 minutes of wall clock; the same 300 tracks belong
 * to maybe 40 artists, which is a handful of calls.
 *
 * The endpoint is `browse`, not `search`:
 *
 *   /ws/2/release?artist=<MBID>&inc=recordings&status=official
 *
 * Two things had to be checked in the docs rather than assumed:
 *
 *  - Browsing RECORDINGS by artist cannot include releases: the only `inc`
 *    values are artist-credits and isrcs. So recording titles alone would say
 *    "this artist has a track called X" without saying whether it was ever
 *    released, which is precisely the question. Browsing RELEASES does support
 *    `inc=recordings`, so that is the right direction.
 *  - `status=official` is supported here, so bootlegs never enter the response.
 *    That matters: MusicBrainz catalogues leaked projects, and filtering at the
 *    source is cheaper and safer than filtering after.
 *
 * Paging is unusual and the docs are explicit: releases are capped so a response
 * holds at most ~500 tracks, so you may get fewer than `limit`. The offset must
 * be advanced by the number of releases ACTUALLY RETURNED, not by the limit, or
 * pages get silently skipped.
 */
async function mbArtistCatalogue(url, env, request, cors) {
  const mbid = (url.searchParams.get("mbid") || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(mbid)) {
    return json({ error: "valid mbid required" }, 400, cors);
  }
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  await chargeMb(env, clientId(request));

  /*
   * The most valuable row in the cache by a wide margin.
   *
   * One request returns an artist's whole official catalogue with tracklists, it
   * is identical for every visitor, and it barely changes. Two people who both
   * listen to Kanye West should cost MusicBrainz one lookup between them, not
   * two, and with a persistent shared cache they cost one lookup ever.
   */
  const { body, shared } = await mbShared(env, `cat:${mbid}:${offset}`, async () => {
  const res = await mbFetch(
    `/release?artist=${mbid}&inc=recordings&status=official` +
    `&limit=100&offset=${offset}&fmt=json`);
  if (!res.ok) throw new Upstream(`musicbrainz http ${res.status}`);
  const data = await res.json();

  const releases = [];
  for (const rel of data.releases || []) {
    if (!rel?.id) continue;
    const rg = rel["release-group"] || {};
    const tracks = [];
    for (const medium of rel.media || []) {
      for (const t of medium.tracks || []) {
        const title = t.title || t.recording?.title;
        if (title) tracks.push(title);
      }
    }
    releases.push({
      // Keyed on the release GROUP where available, so the many pressings of one
      // album collapse rather than each looking like a separate release.
      rg_id: rg.id ? `mb:${rg.id}` : `mbrel:${rel.id}`,
      title: rg.title || rel.title,
      primary: rg["primary-type"] || null,
      secondary: rg["secondary-types"] || [],
      // The release-group date is the earliest across pressings, which is what
      // "when did this come out" means. Falls back to this release's own date.
      first_release: rg["first-release-date"] || rel.date || null,
      status: rel.status || "Official",
      source: "musicbrainz",
      tracks,
    });
  }

  // Advance by releases RETURNED, per the docs, not by the limit.
  const got = (data.releases || []).length;
  const total = Number(data["release-count"] ?? 0);
  return {
    releases,
    next_offset: got > 0 && offset + got < total ? offset + got : null,
    total,
  };
  });
  return json({ ...body, shared }, 200,
              { ...cors, "Cache-Control": "public, max-age=86400" });
}

/**
 * Resolve an artist name to a MusicBrainz ID.
 *
 * Only needed when the scrobble carries no artist_mbid, which Last.fm often
 * omits. Exact normalised match required, for the same reason as the Spotify
 * artist search: silently browsing the wrong artist's catalogue would produce
 * confident, wrong answers rather than no answer.
 */
async function mbArtistId(url, env, request, cors) {
  const name = (url.searchParams.get("artist") || "").slice(0, 200);
  if (!name) return json({ error: "artist required" }, 400, cors);
  await chargeMb(env, clientId(request));

  // Keyed on the NORMALISED name, so "Playboi Carti" and "playboi  carti" share
  // one row rather than each costing a lookup.
  const { body, shared } = await mbShared(env, `aid:${spNorm(name)}`, async () => {
    const esc = (x) => x.replace(/[\\+\-!(){}\[\]^"~*?:/&|]/g, (c) => "\\" + c);
    const res = await mbFetch(
      `/artist?query=artist:"${encodeURIComponent(esc(name))}"&limit=5&fmt=json`);
    if (!res.ok) throw new Upstream(`musicbrainz http ${res.status}`);
    const data = await res.json();

    const want = spNorm(name);
    const hit = (data.artists || []).find((a) => spNorm(a.name) === want);
    // `found: false` is cached deliberately: an artist MusicBrainz has never
    // heard of will not appear next week, and this tool exists for exactly that
    // kind of catalogue.
    return {
      found: Boolean(hit),
      mbid: hit?.id || null,
      name: hit?.name || null,
      near: (data.artists || []).slice(0, 3).map((a) => a.name),
    };
  });
  return json({ ...body, shared }, 200,
              { ...cors, "Cache-Control": "public, max-age=86400" });
}

async function mbRecording(url, env, request, cors) {
  const artist = (url.searchParams.get("artist") || "").slice(0, 200);
  const track = (url.searchParams.get("track") || "").slice(0, 200);
  if (!artist || !track) {
    return json({ error: "artist and track required" }, 400, cors);
  }
  await chargeMb(env, clientId(request));
  const { body, shared } = await mbShared(
    env, `rec:${spNorm(artist)}\u241f${spNorm(track)}`, async () => {
  const esc = (s) => s.replace(/[\\+\-!(){}\[\]^"~*?:/&|]/g, (c) => "\\" + c);
  const query = `artist:"${esc(artist)}" AND recording:"${esc(track)}"`;
  const res = await mbFetch(
    `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`);
  if (!res.ok) throw new Upstream(`musicbrainz http ${res.status}`);
  const data = await res.json();

  const best = new Map();
  for (const rec of data.recordings || []) {
    for (const rel of rec.releases || []) {
      const rg = rel["release-group"];
      if (!rg?.id) continue;
      const g = {
        rg_id: rg.id,
        title: rg.title,
        primary: rg["primary-type"],
        secondary: rg["secondary-types"] || [],
        first_release: rg["first-release-date"] || null,
        status: rel.status || null,
        recording_id: rec.id,
      };
      const cur = best.get(g.rg_id);
      if (!cur || (g.first_release || "9999") < (cur.first_release || "9999")) {
        best.set(g.rg_id, g);
      }
    }
  }
  const groups = [...best.values()].sort(
    (a, b) => (a.first_release || "9999").localeCompare(b.first_release || "9999"),
  );
  return { groups };
  });
  return json({ ...body, shared }, 200,
              { ...cors, "Cache-Control": "public, max-age=86400" });
}

/* ---------------------------------------------------------------- Spotify */
/**
 * Why Spotify at all, when MusicBrainz already answers these questions?
 *
 * Throughput, and nothing else. MusicBrainz enforces a hard 1 request/second
 * with IP blocking, so a library with 4,000 distinct unreleased tracks needs
 * over an hour of wall clock just to ask "has this been released yet". Spotify
 * tolerates roughly two orders of magnitude more, and it answers by CATALOGUE
 * rather than by track: one artist fetch returns every title that artist has
 * officially released, so all 300 of a given artist's tracks resolve from a
 * handful of calls instead of 300.
 *
 * MusicBrainz is still the authority and still runs. The chain is:
 *
 *   Spotify says released   -> done, no MusicBrainz call
 *   Spotify says not found  -> ask MusicBrainz, which catalogues bootlegs,
 *                              regional releases and pre-streaming material
 *                              that Spotify has never had
 *
 * That ordering matters and is not interchangeable. Spotify's absence is weak
 * evidence (it has no bootlegs, loses tracks to licensing, and is missing much
 * of pre-2000 music), so absence must never be treated as a verdict. Spotify's
 * PRESENCE is strong evidence, and presence is the only thing we act on.
 *
 * Two accuracy caveats encoded below:
 *
 *  1. `release_date` on Spotify is the date of THAT edition, not the earliest
 *     release of the work. A 2015 album reissued in 2021 reports 2021. We
 *     therefore collapse editions by normalised title and keep the earliest
 *     date seen, and we never present a Spotify date as authoritative when
 *     MusicBrainz has an opinion.
 *  2. Search is fuzzy in both directions. Asking for artist "Sef" returns
 *     "Sefyu". Every artist match is verified by exact normalised name, and
 *     callers get `exact` flags rather than result counts.
 */

const SP_TOKEN_CACHE = "https://scrobble-drift.internal/spotify-token";
const SP_ALBUM_CAP = 100;    // albums per artist, keeps subrequests bounded

/*
 * Albums per page: 10, which is the highest value Spotify accepts here.
 *
 * Probed rather than assumed, because the documented behaviour is wrong for this
 * app. 6, 8 and 10 are accepted; 15 and 50 are refused with
 * {"status":400,"message":"Invalid limit"}; and omitting the parameter yields
 * pages of 5, not the documented default of 20. So the real ceiling sits between
 * 10 and 15 and the default is a quarter of what the docs claim.
 *
 * Worth the probe: at 5 per page Björk's 145 releases were 29 requests, and the
 * 100-album cap was 20. At 10 it is half that. Combined with fetching pages
 * concurrently rather than one at a time, this went from the slowest part of a
 * scan to a rounding error.
 */
const SP_PAGE = 10;
const SP_TTL = 604800;       // 7 days. Catalogues change; release dates do not.
const SP_BATCH = 10;         // albums per tracklist call, see SP_MARKET below

/**
 * Every Spotify request pins a market, and this is not about regional content.
 *
 * Spotify omits the `available_markets` array from a response whenever a market
 * is specified. That array is ~180 country codes PER TRACK, so a 20-album batch
 * carries roughly 200,000 redundant strings, and JSON.parse on that alone
 * exceeded the free plan's 10ms CPU budget. The Worker threw, returned 500, and
 * the frontend logged "Lookup failed, retrying" forever while resolving zero
 * tracks. Pinning a market shrinks the payload by well over an order of
 * magnitude and is the difference between this working and not.
 *
 * The cost is that a track unavailable in this market is reported as absent,
 * which is safe here: absence from Spotify is never acted on, it only routes the
 * track to MusicBrainz. NL because the deployment is Dutch; any single market
 * would do.
 */
const SP_MARKET = "NL";

/**
 * Client-credentials token, cached at the edge.
 *
 * Client credentials grant no user scope whatsoever: this token can read the
 * public catalogue and nothing else. It cannot see or touch any Spotify
 * account, which keeps it in the same read-only category as everything else
 * here. Cached because the token endpoint is itself rate limited and a fresh
 * token per request would be the bottleneck.
 */
async function spotifyToken(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new Error("spotify credentials not configured");
  }
  const key = new Request(SP_TOKEN_CACHE);
  const hit = await caches.default.match(key);
  if (hit) return (await hit.json()).access_token;

  const res = await fetch(SPOTIFY_TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // btoa is fine here: these are ASCII credentials.
      authorization: "Basic " +
        btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`spotify token http ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("spotify token missing");

  // Expire a minute early so an in-flight request never uses a dead token.
  const ttl = Math.max(60, Number(data.expires_in || 3600) - 60);
  await caches.default.put(
    key,
    new Response(JSON.stringify({ access_token: data.access_token }), {
      headers: {
        "content-type": "application/json",
        "Cache-Control": `max-age=${ttl}`,
      },
    }),
  );
  return data.access_token;
}

async function spFetch(path, env) {
  const token = await spotifyToken(env);
  const res = await fetch(`${SPOTIFY_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cf: { cacheTtl: SP_TTL, cacheEverything: true },
  });
  if (res.status === 429) {
    // Spotify always sends Retry-After on 429. Honour it exactly rather than
    // guessing, and do NOT trip the Last.fm breaker: these are separate quotas
    // and stalling scrobble fetching over a Spotify limit would be wrong.
    const wait = Number(res.headers.get("Retry-After") || 5);
    throw new Retryable("Spotify is rate limiting us.", Math.min(wait, 60));
  }
  if (res.status === 401) {
    // Token rejected despite the cache. Drop it so the next call re-mints.
    await caches.default.delete(new Request(SP_TOKEN_CACHE));
    throw new Error("spotify token rejected");
  }
  if (!res.ok) {
    /*
     * Include Spotify's own message.
     *
     * This threw the response body away, so a 400 reached the client as the
     * bare string "spotify http 400" with no indication of WHICH parameter
     * Spotify objected to. Diagnosing one cost a whole round of guesswork:
     * the shape was valid per the documentation, a fresh artist failed
     * identically so it was not a poisoned cache, and the token was provably
     * fine because another endpoint answered with it.
     *
     * Spotify sends `{"error":{"status":400,"message":"..."}}`. That message is
     * the entire answer, and it was one line of code away the whole time.
     * Truncated because it reaches the browser, and passed through redact()
     * by the top-level handler in case a URL with a key is ever quoted back.
     */
    const detail = await res.text().catch(() => "");
    throw new Error(`spotify http ${res.status}` +
      (detail ? `: ${detail.replace(/\s+/g, " ").slice(0, 300)}` : ""));
  }
  return res.json();
}

/**
 * Normalise for comparison. Mirrors norm() in docs/drift.js deliberately.
 *
 * Exported, along with spAlbumToGroup, purely so scripts/test-worker.mjs can
 * assert them without duplicating the logic. Cloudflare only reads the default
 * export, so extra named exports cost nothing at runtime, and the alternative
 * (a second copy of the release-type rules living in a test file) is exactly the
 * duplication this project already removed once.
 */
export const spNorm = (s) => (s || "").toLowerCase()
  .normalize("NFKD").replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Map a Spotify album object onto the MusicBrainz release-group shape.
 *
 * The whole point: the detectors in docs/drift.js consume ONE shape. Adapting
 * at the boundary means d0Resolve and d14eReleasedSince need no knowledge of
 * where an answer came from, and adding a third source later touches only this
 * function. The alternative, branching on source inside the detectors, would
 * duplicate the release-type logic per source and rot immediately.
 *
 * The mapping is lossy in one direction worth naming: Spotify's "single"
 * album_type covers both singles and EPs, since it has no EP type at all. A
 * 5-track "single" is an EP in every sense MusicBrainz recognises, so track
 * count is used to recover the distinction. It is a heuristic, and it is marked
 * as one via `source`.
 */
export function spAlbumToGroup(al) {
  if (!al) return null;         // defence in depth; callers filter first
  const type = al.album_type || "album";
  const n = Number(al.total_tracks || 0);
  let primary = "Album";
  const secondary = [];
  if (type === "single") primary = n >= 4 && n <= 8 ? "EP" : "Single";
  else if (type === "compilation") secondary.push("Compilation");

  return {
    rg_id: `spotify:${al.id}`,
    title: al.title ?? al.name,
    primary,
    secondary,
    first_release: al.release_date || null,
    // Everything on Spotify is a licensed commercial release. That is exactly
    // what MusicBrainz means by Official, and it is what D14e filters on.
    status: "Official",
    total_tracks: n || null,
    url: al.external_urls?.spotify || null,
    source: "spotify",
  };
}

/**
 * Resolve an artist name to their album list.
 *
 * Two subrequests in the common case (search, then one album page), never more
 * than five, which keeps this far inside the free plan's 50-subrequest ceiling
 * and its 10ms CPU budget. Tracklists are deliberately NOT fetched here: doing
 * both in one request would blow the CPU budget on JSON parsing for prolific
 * artists. The browser pipelines the two calls instead.
 */
async function spArtistAlbums(url, env, cors) {
  const artist = (url.searchParams.get("artist") || "").slice(0, 200);
  if (!artist) return json({ error: "artist required" }, 400, cors);

  const found = await spFetch(
    `/search?type=artist&limit=5&market=${SP_MARKET}` +
    `&q=${encodeURIComponent(artist)}`, env);

  const want = spNorm(artist);
  const items = found.artists?.items || [];
  // Exact normalised match only. Spotify happily returns "Sefyu" for "Sef",
  // and silently analysing the wrong artist's catalogue is worse than no
  // answer at all: it would produce confident, wrong "already released" claims.
  const hit = items.find((a) => spNorm(a.name) === want);
  if (!hit) {
    return json({ found: false, artist, near: items.slice(0, 3).map((a) => a.name) },
                200, { ...cors, "Cache-Control": "public, max-age=86400" });
  }

  /*
   * No `limit` parameter, and paging by `offset` rather than by following
   * `page.next`.
   *
   * Spotify rejects an explicit limit above 5 on this endpoint with
   * {"status":400,"message":"Invalid limit"} - including limit=20, which is the
   * DEFAULT it applies when the parameter is omitted. So the parameter is being
   * validated, not the number, and the fix is to stop sending it. Confirmed by
   * probing one variable at a time: market and include_groups are both fine and
   * were never mentioned in any error.
   *
   * This is why Spotify resolved 0 of 289 tracks. Every catalogue call 400ed, so
   * every lookup fell through to MusicBrainz at one per second, which is the
   * whole reason release lookups took hours.
   *
   * `page.next` cannot be used to page, because Spotify builds that URL WITH the
   * limit it used, so following it would 400 on the second page - a failure that
   * would only appear for artists with more than 20 releases, which is exactly
   * the case that matters. Offsets are computed here instead, advancing by the
   * number of items actually returned.
   */
  const albums = [];
  const albumPage = (offset) =>
    `/artists/${hit.id}/albums?include_groups=album,single,compilation` +
    `&limit=${SP_PAGE}&market=${SP_MARKET}` +
    (offset ? `&offset=${offset}` : "");
  // `appears_on` is excluded on purpose. It pulls in every playlist-style
  // compilation and other artists' records that merely feature this artist,
  // which would make almost any track look "officially released".
  const collect = (page) => {
    for (const al of page.items || []) {
      // Spotify puts nulls in result arrays for unmatched or region-restricted
      // entries. One null used to throw on al.id and take the request down.
      if (!al?.id) continue;
      albums.push({
        id: al.id,
        name: al.name,
        album_type: al.album_type,
        total_tracks: al.total_tracks,
        release_date: al.release_date,
        url: al.external_urls?.spotify || null,
      });
    }
  };

  /*
   * One page, then the rest CONCURRENTLY.
   *
   * Spotify serves 5 items per page to this app and refuses any explicit limit
   * above that, so a 45-release artist is 9 requests and the 100-album cap is 20.
   * Fetched one after another that is several seconds per artist, and a library
   * with a few hundred artists spends most of its scan waiting on round trips
   * rather than on anything useful.
   *
   * Page one reports `total`, which is enough to compute every remaining offset
   * up front instead of discovering them one reply at a time. They then go out in
   * small groups: bounded, not all at once, because a burst of twenty per artist
   * multiplied by concurrent visitors is how you collect 429s. The client already
   * paces artists; this only stops each artist being needlessly serial.
   */
  const first = await spFetch(albumPage(0), env);
  collect(first);

  const total = Math.min(Number(first.total ?? 0), SP_ALBUM_CAP);
  const step = (first.items || []).length;
  if (step > 0 && total > step) {
    const offsets = [];
    for (let o = step; o < total; o += step) offsets.push(o);

    const CONCURRENCY = 4;
    for (let k = 0; k < offsets.length; k += CONCURRENCY) {
      const batch = offsets.slice(k, k + CONCURRENCY);
      const pages = await Promise.all(
        batch.map((o) => spFetch(albumPage(o), env)));
      for (const pg of pages) collect(pg);
    }
  }

  // Offsets were computed from `total`, so pages can overlap if the catalogue
  // shifts mid-read, and a null-heavy page can leave gaps. De-duplicate on id
  // rather than trusting arithmetic against a live catalogue.
  const seen = new Set();
  const unique = albums.filter((a) => !seen.has(a.id) && seen.add(a.id));
  albums.length = 0;
  albums.push(...unique.slice(0, SP_ALBUM_CAP));

  return json({
    found: true,
    artist_id: hit.id,
    artist_name: hit.name,
    albums,
    truncated: Number(first.total ?? 0) > SP_ALBUM_CAP,
    page_size: step,
  }, 200, { ...cors, "Cache-Control": "public, max-age=86400" });
}

/**
 * Tracklists for up to 20 albums in ONE upstream call.
 *
 * This is where the throughput comes from. An artist with 40 releases needs two
 * calls to yield every title they have ever officially put out, and that single
 * answer resolves every one of that artist's tracks in the library at once. The
 * per-track search approach would have cost one call per track.
 */
async function spAlbumTracks(url, env, cors) {
  const ids = (url.searchParams.get("ids") || "")
    .split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]{10,30}$/.test(s));
  if (!ids.length) return json({ error: "ids required" }, 400, cors);
  if (ids.length > SP_BATCH) {
    return json({ error: `max ${SP_BATCH} ids` }, 400, cors);
  }

  const data = await spFetch(
    `/albums?ids=${ids.join(",")}&market=${SP_MARKET}`, env);

  const out = [];
  for (const al of data.albums || []) {
    if (!al) continue;                       // Spotify returns null for bad ids
    const group = spAlbumToGroup(al);
    for (const t of al.tracks?.items || []) {
      out.push({
        title: t.name,
        // Carried so the caller can tell "Drake feat. 21 Savage" apart from a
        // Drake solo cut without a second lookup. D8 needs exactly this.
        artists: (t.artists || []).map((a) => a.name),
        disc: t.disc_number || 1,
        n: t.track_number || null,
        album: group,
      });
    }
  }
  // The album endpoint caps embedded tracklists at 50 per album. Beyond that a
  // separate paginated call would be needed; flagged rather than silently
  // truncating, because a missing track would read as "never released".
  const partial = (data.albums || []).some(
    (al) => al && Number(al.total_tracks || 0) > (al.tracks?.items?.length || 0));

  return json({ tracks: out, partial }, 200,
              { ...cors, "Cache-Control": "public, max-age=86400" });
}

/**
 * Does an album with this title exist for this artist?
 *
 * The Spotify-side answer to the same question mbReleaseGroup answers, used
 * first when settling era names like "Drip Season" versus "Drip Season 3".
 * Same contract, same `exists` / `matches` / `near` shape, so the caller can
 * treat the two sources interchangeably and fall through on a miss.
 */
async function spAlbum(url, env, cors) {
  const artist = (url.searchParams.get("artist") || "").slice(0, 200);
  const title = (url.searchParams.get("title") || "").slice(0, 200);
  if (!artist || !title) {
    return json({ error: "artist and title required" }, 400, cors);
  }

  const q = `album:${JSON.stringify(title)} artist:${JSON.stringify(artist)}`;
  const data = await spFetch(
    // No `limit`: see the note in spArtistAlbums. Spotify's default for search
    // is 20, which is what this asked for explicitly and was refused for.
    `/search?type=album&market=${SP_MARKET}&q=${encodeURIComponent(q)}`,
    env);

  const wantTitle = spNorm(title);
  const wantArtist = spNorm(artist);
  const groups = (data.albums?.items || []).filter((al) => al?.id).map((al) => ({
    ...spAlbumToGroup(al),
    // Both must match. Title alone is not enough: a search for a rare era name
    // can surface a same-titled record by a different artist entirely.
    exact: spNorm(al.name) === wantTitle &&
           (al.artists || []).some((a) => spNorm(a.name) === wantArtist),
  }));

  return json({
    exists: groups.some((g) => g.exact),
    matches: groups.filter((g) => g.exact).slice(0, 5),
    near: groups.filter((g) => !g.exact).slice(0, 5),
  }, 200, { ...cors, "Cache-Control": "public, max-age=86400" });
}
