/**
 * Deep links into the user's own Last.fm library.
 *
 * These are how someone ACTS on a finding, so a wrong or missing link makes an
 * otherwise correct finding useless. That is not hypothetical: D15 reports one
 * album title existing twice under two different album artists, and because every
 * album link was built from the finding's artist rather than each member's, both
 * URLs came out identical, the de-duplicator dropped one, and the report offered a
 * single link to a split whose whole point is that there are two of them. The
 * reaction was "I don't see this in my scrobbles", which was the correct
 * conclusion from what was on screen.
 *
 * `esc`, `lfmSeg`, `libUrl` and `issueLinks` live in the inline module in
 * index.html rather than in a file that can be imported, so they are extracted
 * from the source and evaluated. That is uglier than an import and worth it: the
 * alternative is asserting on source text, which cannot tell whether the URLs are
 * actually right.
 *
 *     node scripts/test-links.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "docs/index.html"), "utf8");

let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") =>
  cond ? pass++ : fails.push(name + (detail ? `\n      ${detail}` : ""));

/** Pull one top-level declaration out of the inline module by name. */
function extract(name, kind) {
  const re = kind === "function"
    ? new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`)
    : new RegExp(`\\nconst ${name} = [\\s\\S]*?;\\n(?=\\n|/|c|f|l)`);
  const m = html.match(re);
  if (!m) throw new Error(`could not extract ${name} from index.html`);
  return m[0];
}

const src = [
  extract("esc", "const"),
  extract("lfmSeg", "const"),
  extract("libUrl", "function"),
  extract("issueLinks", "function"),
  "export { esc, lfmSeg, libUrl, issueLinks };",
].join("\n");

const mod = await import(
  "data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const { libUrl, issueLinks } = mod;

/** The href values a finding produces, in order. */
const hrefs = (issue, user = "arjan") =>
  issueLinks(issue, user).map((a) => a.match(/href="([^"]+)"/)[1]);
/** The visible labels, so a list of links is distinguishable to a reader. */
const labels = (issue, user = "arjan") =>
  issueLinks(issue, user).map((a) => a.replace(/<[^>]+>/g, ""));

/* ---- the D15 regression ------------------------------------------------- */
{
  // Real shape, from the reported finding: one title, two album artists.
  const d15 = {
    detector: "D15",
    artist: "Years & Years",
    album: "Desire (Gryffin Remix)",
    members: [
      { album: "Desire (Gryffin Remix)", artist: "Years & Years",
        plays: 17, looks_like: "artist credit" },
      { album: "Desire (Gryffin Remix)", artist: "Olly Alexander (Years & Years)",
        plays: 2, looks_like: "artist credit" },
    ],
  };

  const h = hrefs(d15);
  ok("D15 produces TWO album links, one per album artist",
     h.length === 2,
     `got ${h.length}: ${h.join(" | ")}`);
  ok("they are different URLs",
     new Set(h).size === 2,
     "Identical URLs are why the de-duplicator dropped one.");
  ok("the first points at the higher-play album artist",
     h[0]?.includes("Years+%26+Years/Desire"),
     h[0] || "(none)");
  ok("the second points at the OTHER album artist",
     h[1]?.includes("Olly+Alexander"),
     h[1] || "(none)");
  ok("both are library URLs for the scanned user",
     h.every((u) => u.startsWith("https://www.last.fm/user/arjan/library/music/")),
     h.join(" | "));

  // A reader must be able to tell the two links apart. Both carry the same album
  // title, so labelling by title makes them look like a duplicate.
  const L = labels(d15);
  ok("the two links are labelled distinguishably",
     L.length === 2 && L[0] !== L[1],
     `got ${JSON.stringify(L)}`);
  ok("and are labelled by album artist, since the title is identical",
     L.some((x) => /Olly Alexander/.test(x)),
     `got ${JSON.stringify(L)}`);
}

/* ---- the ordinary case must not regress -------------------------------- */
{
  // D4: two different album titles under ONE artist. Here the TITLE is what
  // distinguishes, and labelling by artist would make both read the same.
  const d4 = {
    detector: "D4",
    artist: "Travis Scott",
    members: [
      { album: "Rodeo", plays: 120 },
      { album: "Rodeo (Deluxe)", plays: 40 },
    ],
  };
  const h = hrefs(d4);
  ok("D4 still links both album titles", h.length === 2, h.join(" | "));
  ok("under the finding's artist, since members name none",
     h.every((u) => u.includes("/music/Travis+Scott/")), h.join(" | "));

  const L = labels(d4);
  ok("and is labelled by title, which is what differs here",
     L.some((x) => /Rodeo \(Deluxe\)/.test(x)), JSON.stringify(L));
}

/* ---- members that name their own artist (D5 spans many) ---------------- */
{
  const d5 = {
    detector: "D5",
    artist: "Various",
    members: [
      { artist: "Playboi Carti", track: "Sky", plays: 9 },
      { artist: "Yeat", track: "Rich Minion", plays: 4 },
    ],
  };
  const h = hrefs(d5);
  ok("D5 links each track under its OWN artist", h.length === 2, h.join(" | "));
  ok("first under Playboi Carti",
     h[0]?.includes("/music/Playboi+Carti/_/Sky"), h[0] || "(none)");
  ok("second under Yeat",
     h[1]?.includes("/music/Yeat/_/Rich+Minion"), h[1] || "(none)");
}

/* ---- encoding, since these names are full of hostile characters -------- */
{
  ok("ampersands are escaped in the path",
     libUrl("arjan", "Years & Years", { album: "Desire (Gryffin Remix)" })
       === "https://www.last.fm/user/arjan/library/music/Years+%26+Years/" +
          "Desire+%28Gryffin+Remix%29",
     libUrl("arjan", "Years & Years", { album: "Desire (Gryffin Remix)" }));
  ok("spaces become + rather than %20",
     !libUrl("arjan", "A B", { album: "C D" }).includes("%20"));
  ok("a track uses the _ album placeholder",
     libUrl("arjan", "X", { track: "Y" }).endsWith("/X/_/Y"));
  ok("no user means no link, rather than a broken one",
     libUrl("", "X", { album: "Y" }) === null);
  ok("no artist means no link",
     libUrl("arjan", "", { album: "Y" }) === null);
}

/* ---- "(no album)" is a label, not an album ----------------------------- */
{
  const blank = {
    detector: "D5", artist: "Yeat",
    members: [{ album: "(no album)", plays: 3 }],
  };
  ok("'(no album)' never becomes an album URL",
     !hrefs(blank).some((u) => u.includes("no+album")),
     hrefs(blank).join(" | "));
}

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\n  FAILED");
  for (const f of fails) console.log("   x " + f);
  process.exit(1);
}
console.log("  Every finding links to the thing it is about.\n");
