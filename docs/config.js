/**
 * Where the API proxy lives.
 *
 * The frontend is static and hosted free on GitHub Pages. The proxy cannot be,
 * because Last.fm sends no CORS headers and the API key must stay server-side.
 * So the site runs at
 *
 *     https://<you>.github.io/scrobble-drift/
 *
 * and calls a Cloudflare Worker for data. Pages and the Worker are different
 * origins, so this must be the Worker's absolute URL: a relative "/api" would
 * resolve to github.io and 404.
 *
 * This is already set to the right value: the Workers subdomain on this
 * account is arjanknol-ak.workers.dev, and wrangler.toml names the Worker
 * scrobble-drift-api, so `npx wrangler deploy` will publish exactly here.
 * Nothing to edit unless you rename the Worker.
 */
export const API_BASE = "https://scrobble-drift-api.arjanknol-ak.workers.dev";

/** Sanity check, so the UI can explain itself instead of throwing CORS errors. */
export const isConfigured = () =>
  !API_BASE.includes("YOUR-SUBDOMAIN") && /^https:\/\//.test(API_BASE);

/**
 * Local override, so the site can be pointed at a dev Worker without editing
 * and committing this file:
 *
 *     localStorage.setItem("drift_api", "http://127.0.0.1:8787")
 */
export const apiBase = () => {
  try {
    return localStorage.getItem("drift_api") || API_BASE;
  } catch {
    return API_BASE;                    // storage blocked, fall back
  }
};
