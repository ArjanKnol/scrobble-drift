/**
 * Runs the real Worker handler in Node against stubbed Spotify responses.
 *
 * The Worker is a plain ES module with a default export, so it can be imported
 * and invoked directly. Only three globals need providing: `caches`, `fetch` and
 * the `env` bindings.
 *
 * WHAT THIS CAN FIND: logic errors, null handling, unhandled rejections, and
 * anything that depends on response shape.
 *
 * WHAT IT CANNOT FIND: Cloudflare-runtime-specific restrictions, notably which
 * operations the real Cache API refuses. Those are simulated separately below
 * rather than assumed away.
 *
 * Run: node scripts/debug-worker.mjs
 */

const ORIGIN = "https://scrobble-drift.pages.dev";

/* ------------------------------------------------------------ cache stub */
function makeCaches({ putThrows = false } = {}) {
  const store = new Map();
  return {
    default: {
      async match(req) {
        const url = typeof req === "string" ? req : req.url;
        const hit = store.get(url);
        return hit ? new Response(hit, {
          headers: { "content-type": "application/json" },
        }) : undefined;
      },
      async put(req, res) {
        if (putThrows) {
          // Mirrors the real API's failure mode: it throws rather than
          // returning an error, so an unawaited put takes the request down.
          throw new TypeError("Cannot cache response (simulated)");
        }
        const url = typeof req === "string" ? req : req.url;
        store.set(url, await res.text());
      },
      async delete(req) {
        const url = typeof req === "string" ? req : req.url;
        return store.delete(url);
      },
    },
    _store: store,
  };
}

/* -------------------------------------------------- Spotify response stubs */
const album = (over = {}) => ({
  id: "6ByLIWiPtIYAaCiSSSbjWn",
  name: "Rodeo",
  album_type: "album",
  total_tracks: 14,
  release_date: "2015-09-04",
  external_urls: { spotify: "https://open.spotify.com/album/x" },
  artists: [{ name: "Travis Scott", id: "0Y5tJX1MQlPlqiwlOH1tJY" }],
  ...over,
});

const track = (over = {}) => ({
  name: "Antidote",
  artists: [{ name: "Travis Scott" }],
  disc_number: 1,
  track_number: 5,
  ...over,
});

function spotifyRouter(scenario) {
  return async (url, opts) => {
    const u = String(url);

    if (u.startsWith("https://accounts.spotify.com")) {
      if (scenario.tokenFails) {
        return new Response("nope", { status: 400 });
      }
      return new Response(JSON.stringify({
        access_token: "FAKE_TOKEN", token_type: "Bearer", expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (u.includes("/search") && u.includes("type=artist")) {
      return new Response(JSON.stringify({
        artists: { items: scenario.artistItems ?? [
          { id: "0Y5tJX1MQlPlqiwlOH1tJY", name: "Travis Scott" },
        ] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (u.includes("/search") && u.includes("type=album")) {
      return new Response(JSON.stringify({
        albums: { items: scenario.albumSearchItems ?? [album()] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (u.includes("/albums?ids=")) {
      return new Response(JSON.stringify({
        albums: scenario.albumsByIds ?? [{ ...album(), tracks: { items: [track()] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (u.includes("/albums")) {   // artist album list
      return new Response(JSON.stringify({
        items: scenario.artistAlbums ?? [album()],
        next: scenario.nextPage ?? null,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unstubbed " + u }), { status: 404 });
  };
}

/* ------------------------------------------------------------------ runner */
const env = {
  SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret",
  LASTFM_API_KEY: "0".repeat(32),
  ALLOWED_ORIGINS: ORIGIN,
};

async function probe(label, path, scenario = {}, cacheOpts = {}) {
  globalThis.caches = makeCaches(cacheOpts);
  globalThis.fetch = spotifyRouter(scenario);

  // Fresh import each time so module-level state cannot leak between probes.
  const mod = await import(
    `../worker/src/index.js?bust=${Math.random()}`);

  let out;
  try {
    const res = await mod.default.fetch(
      new Request(`https://w.example${path}`, { headers: { Origin: ORIGIN } }),
      env, {});
    const body = await res.text();
    out = `HTTP ${res.status}  ${body.slice(0, 150)}`;
  } catch (err) {
    // THE important branch. Reaching here means the handler let an exception
    // escape, which is precisely what Cloudflare reports as error 1101.
    out = `!! UNCAUGHT (this is a 1101): ${err.constructor.name}: ${err.message}`;
  }
  console.log(`  ${label.padEnd(42)} ${out}`);
  return out;
}

console.log("\n=== baseline: everything healthy ===");
await probe("health", "/api/health");
await probe("artist-albums, artist found", "/api/spotify/artist-albums?artist=Travis%20Scott");
await probe("artist-albums, artist NOT found",
            "/api/spotify/artist-albums?artist=zzq", { artistItems: [] });
await probe("album search", "/api/spotify/album?artist=Travis%20Scott&title=Rodeo");
await probe("album-tracks", "/api/spotify/album-tracks?ids=6ByLIWiPtIYAaCiSSSbjWn");

console.log("\n=== hypothesis 1: null entries in Spotify arrays ===");
await probe("album search with a null item",
            "/api/spotify/album?artist=X&title=Y", { albumSearchItems: [null, album()] });
await probe("artist album list with a null item",
            "/api/spotify/artist-albums?artist=Travis%20Scott", { artistAlbums: [null, album()] });
await probe("albums?ids with a null (documented!)",
            "/api/spotify/album-tracks?ids=6ByLIWiPtIYAaCiSSSbjWn",
            { albumsByIds: [null, { ...album(), tracks: { items: [track()] } }] });

console.log("\n=== hypothesis 2: Cache API put() throws ===");
await probe("health (breaker match only)", "/api/health", {}, { putThrows: true });
await probe("artist-albums, token put throws",
            "/api/spotify/artist-albums?artist=Travis%20Scott", {}, { putThrows: true });
await probe("album, token put throws",
            "/api/spotify/album?artist=X&title=Y", {}, { putThrows: true });

console.log("\n=== hypothesis 3: token endpoint fails ===");
await probe("artist-albums, token http 400",
            "/api/spotify/artist-albums?artist=Travis%20Scott", { tokenFails: true });

console.log("\n=== hypothesis 4: missing tracks object ===");
await probe("album-tracks, album with no tracks key",
            "/api/spotify/album-tracks?ids=6ByLIWiPtIYAaCiSSSbjWn",
            { albumsByIds: [{ ...album(), tracks: undefined }] });

console.log("\n=== hypothesis 5: pagination ===");
await probe("artist-albums with a next page",
            "/api/spotify/artist-albums?artist=Travis%20Scott",
            { nextPage: "https://api.spotify.com/v1/artists/x/albums?offset=50&limit=50" });

console.log();
