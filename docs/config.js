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

/**
 * Where to find the author. Rendered as icon links in the footer.
 *
 * Set `url` to null (or leave the placeholder) and that link is simply not
 * rendered, so this file can ship with entries filled in later without the page
 * ever showing a dead link. Order here is the order on the page.
 */
export const LINKS = [
  {
    id: "github",
    label: "GitHub",
    url: "https://github.com/ArjanKnol/scrobble-drift",
    // Simple, single-path icons. Inlined rather than loaded from a CDN: the whole
    // point of this site is that it makes no third-party requests it does not
    // need, and an icon font would be a tracking surface for nothing.
    path: "M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.7v-2.6c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7 0-.7 0-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.9 4.7 19 5 19 5c.6 1.6.2 2.9.1 3.2.7.8 1.2 1.9 1.2 3.2 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .4.2.8.8.7A12 12 0 0 0 12 .5Z",
  },
  {
    id: "youtube",
    label: "YouTube",
    url: "https://www.youtube.com/@highcharts40",
    path: "M23 7.5a3 3 0 0 0-2.1-2.1C19 4.9 12 4.9 12 4.9s-7 0-8.9.5A3 3 0 0 0 1 7.5C.5 9.4.5 12 .5 12s0 2.6.5 4.5a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.5-1.9.5-4.5.5-4.5s0-2.6-.5-4.5ZM9.8 15.6V8.4l6.2 3.6-6.2 3.6Z",
  },
  {
    id: "patreon",
    label: "Patreon",
    url: "https://www.patreon.com/HighCharts",
    path: "M15.4 2.1c-4.7 0-8.5 3.8-8.5 8.5 0 4.7 3.8 8.5 8.5 8.5 4.7 0 8.5-3.8 8.5-8.5 0-4.7-3.8-8.5-8.5-8.5ZM.2 22.9h4.2V2.1H.2v20.8Z",
  },
];

/** Only the links that actually have a URL. */
export const activeLinks = () =>
  LINKS.filter((l) => l.url && !/^https?:\/\/$/.test(l.url));
