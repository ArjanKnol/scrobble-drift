#!/usr/bin/env node
/**
 * Scrobble Drift scanner, Node build.
 *
 *   node scripts/scan.mjs                    # local detectors only (~3 min)
 *   node scripts/scan.mjs --resolve          # also resolve via MusicBrainz
 *   node scripts/scan.mjs --resolve --budget 400
 *   node scripts/scan.mjs --limit 5000       # quick smoke test
 *
 * WHY THIS REPLACED THE PYTHON SCANNER
 *
 * The detection logic used to exist twice, once in scripts/detectors.py for the
 * scheduled monitor and once in docs/drift.js for the browser. They were
 * verified identical by hand, repeatedly, and every fix had to be made twice.
 * That is a trap: the two would eventually disagree and nobody would notice
 * which one was right.
 *
 * This imports docs/drift.js directly, so there is now exactly one
 * implementation of every detector and threshold. The browser and the monthly
 * Action cannot drift apart because they run the same file.
 *
 * A Cloudflare Worker cron was the other option and does not work: the free
 * plan allows 10ms CPU per invocation and the analysis pass on a 140k-scrobble
 * history takes about 16 seconds. GitHub Actions has no such limit and is free
 * for public repositories.
 *
 * Dependencies: none. Node 18+ has fetch built in.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyse, partitionEra, resolutionPlan, d0Resolve, d14eReleasedSince,
  eraVerificationPlan, verifyEraNames, hygieneScore, chartImpact,
} from "../docs/drift.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPORT = join(ROOT, "docs", "report.json");
const HISTORY = join(ROOT, "data", "history");
const MB_CACHE = join(ROOT, "data", "mb-cache.json");

const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const MB = "https://musicbrainz.org/ws/2";
const UA = "ScrobbleDrift/0.1 (+https://github.com/ArjanKnol/scrobble-drift)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};

/* ------------------------------------------------------------------- http */

/** Minimum-interval limiter. MusicBrainz blocks IPs that exceed 1 req/s. */
class Pacer {
  constructor(perSecond) { this.gap = 1000 / perSecond; this.last = 0; }
  async wait() {
    const since = Date.now() - this.last;
    if (since < this.gap) await sleep(this.gap - since);
    this.last = Date.now();
  }
}

async function getJson(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      // 4xx other than 429 will not fix themselves.
      if (!res.ok && res.status !== 429 && res.status < 500) {
        throw new Error(`http ${res.status}`);
      }
      if (res.ok) return await res.json();
      lastErr = new Error(`http ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(2 ** i * 1000);
  }
  throw new Error(`giving up on ${url}: ${lastErr?.message}`);
}

/* ---------------------------------------------------------------- last.fm */

class Lastfm {
  constructor(key, perSecond = 4) {
    if (!key) {
      log("LASTFM_API_KEY is not set. Locally: use a .env file or export it.");
      log("In CI: add it as a GitHub Actions secret.");
      process.exit(1);
    }
    this.key = key;
    this.pacer = new Pacer(perSecond);
  }

  async call(method, params = {}) {
    const qs = new URLSearchParams({
      method, api_key: this.key, format: "json",
      // Autocorrect stays OFF. We need what was actually stored, not Last.fm's
      // opinion of it: users who disabled autocorrection did so deliberately.
      autocorrect: "0",
      ...Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)),
    });
    const data = await getJson(`${LASTFM}?${qs}`);
    if (data.error) throw new Error(`last.fm ${data.error}: ${data.message}`);
    return data;
  }

  async userInfo(user) { return (await this.call("user.getInfo", { user })).user; }

  /** Every scrobble, newest first. Skips the now-playing track: not one yet. */
  async *recentTracks(user) {
    let page = 1, totalPages = 1, seen = 0;
    while (page <= totalPages) {
      await this.pacer.wait();
      const rt = (await this.call("user.getRecentTracks",
        { user, limit: 200, page })).recenttracks ?? {};
      totalPages = Number(rt["@attr"]?.totalPages ?? 1);
      let tracks = rt.track ?? [];
      if (!Array.isArray(tracks)) tracks = [tracks];
      for (const t of tracks) {
        if (t?.["@attr"]?.nowplaying === "true" || !t?.date?.uts) continue;
        yield t;
        seen++;
      }
      if (page % 25 === 0 || page === totalPages) {
        log(`    scrobbles: page ${page}/${totalPages} (${seen.toLocaleString()})`);
      }
      page++;
    }
  }
}

/* ------------------------------------------------------------ musicbrainz */

const escLucene = (s) =>
  s.replace(/[\\+\-!(){}\[\]^"~*?:/&|]/g, (c) => `\\${c}`);

/** Same normalisation the detectors use, so title comparisons agree. */
const normTitleLocal = (s) => (s ?? "")
  .normalize("NFC").toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}\s']/gu, " ")
  .replace(/\s+/g, " ").trim();

class MusicBrainz {
  constructor(cachePath, budget) {
    this.pacer = new Pacer(1);            // hard limit, not politeness
    this.cachePath = cachePath;
    this.cache = {};
    this.spent = 0;
    this.budget = budget;
  }

  async load() {
    if (!existsSync(this.cachePath)) return;
    try {
      this.cache = JSON.parse(await readFile(this.cachePath, "utf8"));
    } catch {
      log("  warning: MB cache unreadable, starting fresh");
    }
  }

  async save() {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(this.cache, null, 0));
  }

  get exhausted() { return this.budget != null && this.spent >= this.budget; }

  /** Recording lookup, summarised to release groups. */
  async recording(artist, track) {
    const key = `rec::${artist}::${track}`.toLowerCase();
    if (key in this.cache) return this.cache[key];
    if (this.exhausted) return null;

    const q = `artist:"${escLucene(artist)}" AND recording:"${escLucene(track)}"`;
    await this.pacer.wait();
    this.spent++;
    let data;
    try {
      data = await getJson(
        `${MB}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
    } catch (err) {
      log(`  MB lookup failed for ${artist} - ${track}: ${err.message}`);
      return null;
    }

    const best = new Map();
    for (const rec of data.recordings ?? []) {
      for (const rel of rec.releases ?? []) {
        const rg = rel["release-group"];
        if (!rg?.id) continue;
        const g = {
          rg_id: rg.id, title: rg.title,
          primary: rg["primary-type"],
          secondary: rg["secondary-types"] ?? [],
          first_release: rg["first-release-date"] ?? null,
          status: rel.status ?? null, recording_id: rec.id,
        };
        const cur = best.get(g.rg_id);
        if (!cur || (g.first_release ?? "9999") < (cur.first_release ?? "9999")) {
          best.set(g.rg_id, g);
        }
      }
    }
    const out = {
      groups: [...best.values()].sort((a, b) =>
        (a.first_release ?? "9999").localeCompare(b.first_release ?? "9999")),
    };
    this.cache[key] = out;
    return out;
  }

  /**
   * Does a release group with this EXACT title exist for this artist?
   *
   * MusicBrainz search is fuzzy and returns "Drip Season 3" when asked for
   * "Drip Season", so a non-empty result set is not evidence of existence.
   * Only a normalised exact title match counts.
   */
  async releaseGroupExists(artist, title) {
    const key = `rg::${artist}::${title}`.toLowerCase();
    if (key in this.cache) return this.cache[key];
    if (this.exhausted) return null;

    const q = `artist:"${escLucene(artist)}" AND releasegroup:"${escLucene(title)}"`;
    await this.pacer.wait();
    this.spent++;
    let data;
    try {
      data = await getJson(
        `${MB}/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
    } catch (err) {
      log(`  MB release-group lookup failed for ${artist} - ${title}: ${err.message}`);
      return null;
    }
    const want = normTitleLocal(title);
    const found = (data["release-groups"] ?? [])
      .some((g) => normTitleLocal(g.title) === want);
    this.cache[key] = found;
    return found;
  }
}

/* ------------------------------------------------------------------- main */

function flatten(t) {
  return {
    uts: Number(t.date.uts),
    artist: (t.artist?.["#text"] ?? t.artist?.name ?? "").trim(),
    artist_mbid: t.artist?.mbid ?? "",
    album: (t.album?.["#text"] ?? "").trim(),
    album_mbid: t.album?.mbid ?? "",
    track: (t.name ?? "").trim(),
    track_mbid: t.mbid ?? "",
  };
}

async function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of (await readFile(p, "utf8")).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const [k, ...rest] = s.split("=");
    if (!process.env[k.trim()]) {
      process.env[k.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

async function main() {
  await loadEnv();
  const user = process.env.LASTFM_USER;
  if (!user) { log("LASTFM_USER is not set."); process.exit(1); }

  const started = Date.now();
  const fm = new Lastfm(process.env.LASTFM_API_KEY ?? "");
  const limit = opt("limit", 0);
  const budget = opt("budget", 300);

  log(`* profile: ${user}`);
  const info = await fm.userInfo(user);
  log(`  ${Number(info.playcount ?? 0).toLocaleString()} scrobbles reported`);

  log("* ingesting");
  const scrobbles = [];
  for await (const t of fm.recentTracks(user)) {
    try { scrobbles.push(flatten(t)); } catch { continue; }
    if (limit && scrobbles.length >= limit) break;
  }
  log(`  ${scrobbles.length.toLocaleString()} scrobbles ingested`);
  if (!scrobbles.length) { log("no scrobbles; check the username"); process.exit(1); }

  // The era guard runs first, inside analyse(). Same code the browser runs.
  log("* detecting");
  const report = analyse(scrobbles);
  report.user = user;
  report.profile.scrobbles_reported = Number(info.playcount ?? 0);
  report.profile.registered = info.registered?.unixtime ?? null;
  log(`  era-tagged (protected): ${report.era.plays.toLocaleString()} plays ` +
      `(${report.era.share_of_all_plays}%)`);

  let mbUsed = 0;
  if (flag("resolve")) {
    const mb = new MusicBrainz(MB_CACHE, budget);
    await mb.load();
    log(`* resolving via MusicBrainz (budget ${budget}, 1 req/s)`);

    // Era names first: cheap, and can only remove or sharpen findings.
    const pending = eraVerificationPlan(report.issues);
    if (pending.length) {
      log(`  checking ${pending.length} era name(s)`);
      const truth = new Map();
      for (const j of pending) {
        truth.set(`${j.artist}␟${j.title}`.toLowerCase(),
                  await mb.releaseGroupExists(j.artist, j.title));
      }
      report.issues = verifyEraNames(report.issues, (a, t) =>
        truth.get(`${a}␟${t}`.toLowerCase()));
    }

    const { era, rest } = partitionEra(scrobbles);
    const splits = report.issues.filter((i) => i.detector === "D4");
    const plan = resolutionPlan(scrobbles, { budget });
    log(`  resolving ${plan.length} recording(s)`);
    const cache = new Map();
    for (const job of plan) {
      const r = await mb.recording(job.artist, job.track);
      if (r) cache.set(`${job.artist}␟${job.track}`.toLowerCase(), r);
    }
    const lookup = (a, t) => cache.get(`${a}␟${t}`.toLowerCase());

    const resolved = d0Resolve(splits, lookup);
    const released = d14eReleasedSince(era, lookup);
    const resolvedTitles = new Set(resolved.map((i) => i.title));
    report.issues = [
      ...report.issues.filter(
        (i) => !(i.detector === "D4" && resolvedTitles.has(i.title))),
      ...resolved, ...released,
    ].sort((a, b) => (b.plays_affected ?? 0) - (a.plays_affected ?? 0));

    report.impact = chartImpact(rest, resolved.length ? resolved : splits);
    report.hygiene = hygieneScore(scrobbles.length, report.issues);
    report.resolved = true;

    await mb.save();
    mbUsed = mb.spent;
    log(`  ${mbUsed} lookups used, cache now ${Object.keys(mb.cache).length} entries`);
  }

  // Recount after any resolution changed the issue set.
  report.summary_by_detector = {};
  for (const i of report.issues) {
    report.summary_by_detector[i.detector] ??= { count: 0, plays_affected: 0 };
    report.summary_by_detector[i.detector].count++;
    report.summary_by_detector[i.detector].plays_affected += i.plays_affected ?? 0;
  }
  report.issues_total = report.issues.length;
  report.musicbrainz_lookups = mbUsed;
  report.took_seconds = Math.round((Date.now() - started) / 100) / 10;
  // Cap what ships to the browser; the full set stays in history.
  const full = report.issues;
  report.issues = full.slice(0, 600);

  await mkdir(dirname(REPORT), { recursive: true });
  await writeFile(REPORT, JSON.stringify(report, null, 1));

  await mkdir(HISTORY, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 7);
  await writeFile(join(HISTORY, `${stamp}.json`), JSON.stringify({
    generated: report.generated, profile: report.profile,
    hygiene: report.hygiene, era: report.era,
    summary_by_detector: report.summary_by_detector,
    issues_total: report.issues_total,
  }, null, 1));

  log(`\n  hygiene score : ${report.hygiene.score}/100`);
  for (const [k, v] of Object.entries(report.hygiene.subscores ?? {})) {
    log(`    ${k.padEnd(18)}: ${v}`);
  }
  log(`  issues        : ${full.length.toLocaleString()}`);
  log(`  era share     : ${report.era.share_of_all_plays}% of plays, ` +
      `${report.era.album_strings.toLocaleString()} album strings, ` +
      `${report.era.distinct_eras.toLocaleString()} distinct eras`);
  if (report.impact?.number_one_changes) {
    log("  NOTE: your true #1 album differs from what last.fm shows");
  }
  log(`\n  wrote docs/report.json`);
}

main().catch((err) => { log(err?.stack ?? String(err)); process.exit(1); });
