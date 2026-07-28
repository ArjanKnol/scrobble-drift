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
 * person it belongs to. That is a real privacy property, not a shortcut:
 * there is no data at rest, so there is no retention policy to write, no
 * deletion endpoint to build, and no breach surface.
 *
 * Free-plan constraint that shapes the design: a Worker request may make at
 * most 50 subrequests. A 140k-scrobble history needs ~700 Last.fm calls, so
 * the client drives pagination and this proxies a bounded batch per request.
 */

const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const MB = "https://musicbrainz.org/ws/2";

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

const MAX_BATCH = 20;        // Last.fm calls per request, well under the 50 cap
const RATE_LIMIT = 900;      // requests per IP per hour
const USER_RE = /^[A-Za-z0-9_.-]{2,20}$/;

export default {
  async fetch(request, env) {
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
        return json({ ok: true, configured: Boolean(env.LASTFM_API_KEY) }, 200, cors);
      }

      const limited = await rateLimit(request, env);
      if (limited) return json({ error: limited }, 429, cors);

      if (url.pathname === "/api/lastfm") return lastfm(url, env, cors);
      if (url.pathname === "/api/scrobbles") return scrobbles(url, env, cors);
      if (url.pathname === "/api/mb/recording") return mbRecording(url, cors);

      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      // Never leak internals or the key to the client.
      console.error(err?.stack || String(err));
      return json({ error: "upstream failure" }, 502, cors);
    }
  },
};

/* ---------------------------------------------------------------- helpers */

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request, env) {
  // ALLOWED_ORIGINS is a comma-separated list. Unset means same-origin only
  // in practice, which is the safe default for a fresh deploy.
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

/**
 * Per-IP hourly cap, backed by KV. Degrades to allow-all if KV is not bound
 * so a first deploy works, but a public deployment must bind it: this proxy
 * spends someone's real API key, and a suspended key (Last.fm error 26) takes
 * every user down at once.
 */
async function rateLimit(request, env) {
  if (!env.RATE) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = `rl:${ip}:${Math.floor(Date.now() / 3.6e6)}`;
  const used = Number((await env.RATE.get(bucket)) || 0);
  if (used >= RATE_LIMIT) return "rate limit exceeded, try again later";
  // Best-effort counter. A lost increment under concurrency is acceptable
  // here; exactness would need a Durable Object and is not worth it.
  await env.RATE.put(bucket, String(used + 1), { expirationTtl: 7200 });
  return null;
}

function requireKey(env) {
  if (!env.LASTFM_API_KEY) {
    throw new Error("LASTFM_API_KEY secret is not set on this Worker");
  }
  return env.LASTFM_API_KEY;
}

async function callLastfm(params, env) {
  const qs = new URLSearchParams({
    ...params,
    api_key: requireKey(env),
    format: "json",
    // Autocorrect stays off. We need what the user actually stored, not
    // Last.fm's canonical opinion of it.
    autocorrect: "0",
  });
  const res = await fetch(`${LASTFM}?${qs}`, {
    headers: { "User-Agent": "ScrobbleDrift/0.1 (+https://github.com/ArjanKnol/scrobble-drift)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`last.fm http ${res.status}`);
  const data = await res.json();
  if (data.error) {
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
    // Never let a caller inject their own api_key or flip autocorrect.
    if (["api_key", "format", "autocorrect"].includes(k)) continue;
    params[k] = v;
  }
  if (params.user && !USER_RE.test(params.user)) {
    return json({ error: "invalid username" }, 400, cors);
  }
  try {
    return json(await callLastfm(params, env), 200, cors);
  } catch (err) {
    return json({ error: err.message, lastfm: err.lastfm ?? null },
                err.lastfm === 6 ? 404 : 502, cors);
  }
}

/**
 * Batched scrobble pages. The client walks pages; this fetches up to
 * MAX_BATCH per request and flattens to the shape the detectors expect.
 */
async function scrobbles(url, env, cors) {
  const user = url.searchParams.get("user") || "";
  if (!USER_RE.test(user)) {
    return json({ error: "invalid username" }, 400, cors);
  }
  const from = Math.max(1, Number(url.searchParams.get("from") || 1));
  const count = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("count") || 5)));

  const pages = [];
  for (let i = 0; i < count; i++) pages.push(from + i);

  // Sequential, not parallel: hammering Last.fm with 20 concurrent requests
  // is how a shared key gets suspended.
  const out = [];
  let totalPages = 1, totalScrobbles = 0;
  for (const page of pages) {
    let data;
    try {
      data = await callLastfm(
        { method: "user.getRecentTracks", user, limit: "200", page: String(page) },
        env,
      );
    } catch (err) {
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
    if (page >= totalPages) break;
  }

  return json({
    scrobbles: out,
    next: from + pages.length <= totalPages ? from + pages.length : null,
    total_pages: totalPages,
    total_scrobbles: totalScrobbles,
  }, 200, cors);
}

/**
 * MusicBrainz recording lookup, summarised to release groups.
 *
 * MusicBrainz enforces 1 request/second with IP blocking. This proxies one
 * lookup per request and leans on Cloudflare's cache; the client is
 * responsible for pacing itself. Release dates never change, so a long TTL
 * costs nothing and protects MusicBrainz from us.
 */
async function mbRecording(url, cors) {
  const artist = (url.searchParams.get("artist") || "").slice(0, 200);
  const track = (url.searchParams.get("track") || "").slice(0, 200);
  if (!artist || !track) {
    return json({ error: "artist and track required" }, 400, cors);
  }
  const esc = (s) => s.replace(/[\\+\-!(){}\[\]^"~*?:/&|]/g, (c) => "\\" + c);
  const query = `artist:"${esc(artist)}" AND recording:"${esc(track)}"`;
  const res = await fetch(
    `${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`,
    {
      headers: {
        "User-Agent": "ScrobbleDrift/0.1 (+https://github.com/ArjanKnol/scrobble-drift)",
        Accept: "application/json",
      },
      cf: { cacheTtl: 2592000, cacheEverything: true },   // 30 days
    },
  );
  if (!res.ok) return json({ error: `musicbrainz http ${res.status}` }, 502, cors);
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
  return json({ groups }, 200, { ...cors, "Cache-Control": "public, max-age=86400" });
}
