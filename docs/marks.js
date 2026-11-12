/**
 * "Fixed" and "Ignore" on a finding, remembered per Last.fm username.
 *
 * Stored in this browser only, like everything else here. A mark is keyed on what
 * the finding is ABOUT (detector, artist, the names involved), never on play
 * counts or its position in the list, so it survives a new scan or a fresh export.
 *
 * Two states:
 *
 *   ignored  hidden from now on, until undone
 *   fixed    hidden too. If a LATER scan still finds it, it comes back with a
 *            note: either the edit did not take, the export predates it, or the
 *            same mistake has been scrobbled again since.
 */

const PREFIX = "drift_marks:";

/** Stable identity for a finding across scans. */
export function markKey(issue) {
  if (!issue?.detector) return "";
  const low = (s) => String(s ?? "").normalize("NFC").toLowerCase().trim();
  const names = new Set();
  for (const m of issue.members || []) {
    for (const f of ["artist", "album", "track", "era"]) {
      if (typeof m?.[f] === "string" && m[f]) names.add(`${f}:${low(m[f])}`);
    }
  }
  return [issue.detector, low(issue.artist), low(issue.track),
          [...names].sort().join("|")].join("␟");
}

const storageKey = (user) => PREFIX + String(user || "").toLowerCase().trim();

/** All marks for one user. Never throws: storage can be unavailable. */
export function loadMarks(user, storage = globalThis.localStorage) {
  if (!user) return {};
  try {
    const raw = storage?.getItem(storageKey(user));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveMarks(user, marks, storage = globalThis.localStorage) {
  if (!user) return false;
  try {
    storage?.setItem(storageKey(user), JSON.stringify(marks || {}));
    return true;
  } catch {
    return false;
  }
}

/**
 * Set or clear a mark. `scan` is the report's own timestamp, which is how a later
 * scan tells "marked during this scan" from "marked before, and still here".
 */
export function setMark(marks, issue, state, scan) {
  const key = markKey(issue);
  if (!key) return marks;
  const out = { ...marks };
  if (!state) delete out[key];
  else out[key] = { state, scan: Number(scan) || 0, at: Math.floor(Date.now() / 1000) };
  return out;
}

/**
 * How a finding should be shown, given the marks and the current report.
 *
 *   { state: null }                       not marked
 *   { state: "ignored", hidden: true }
 *   { state: "fixed", hidden: true }      marked during this scan
 *   { state: "fixed", back: true }        marked in an EARLIER scan and found again
 */
export function markState(marks, issue, scan) {
  const m = marks?.[markKey(issue)];
  if (!m) return { state: null, hidden: false, back: false };
  if (m.state === "fixed" && Number(scan) > Number(m.scan || 0)) {
    return { state: "fixed", hidden: false, back: true };
  }
  return { state: m.state, hidden: true, back: false };
}
