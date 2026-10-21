/**
 * Runs the analysis off the main thread.
 *
 * On a full history (120,000 scrobbles measured) analyse() takes 15 to 35
 * seconds, most of it comparing every artist name with every other. On the main
 * thread that froze the whole tab: no scrolling, no Stop button, and a browser
 * offering to kill the page. In a worker the page stays usable and the progress
 * bar moves.
 *
 * The same drift.js runs here and in the page, so the two can never disagree
 * about what a finding is. Only plain data crosses the boundary: the scrobbles
 * in, the report out, progress messages in between.
 */
import { analyse } from "./drift.js";

self.onmessage = (e) => {
  const { scrobbles, official, topAlbums } = e.data || {};
  let last = 0;
  try {
    const report = analyse(scrobbles, {
      official: new Set(official || []),
      topAlbums: topAlbums || [],
      // Throttled: a message per 80ms is smooth for a bar and costs nothing.
      onProgress: (f, label) => {
        const now = Date.now();
        if (now - last < 80 && f < 1) return;
        last = now;
        self.postMessage({ type: "progress", f, label });
      },
    });
    self.postMessage({ type: "done", report });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
