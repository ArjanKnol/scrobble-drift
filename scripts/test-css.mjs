/**
 * A hover state must never change an element's size.
 *
 * Twice now a `:hover` rule has caused a visible layout jump: once the info icon,
 * and once the library-link pills, where `.issue .links a` removed the bottom
 * border and its `:hover` put a 1px border back, so hovering a pill made it 1px
 * taller and shoved the rest of the page down. Both were reported by the user as
 * "the page moves a bit", which is a hard symptom to trace back to a stylesheet.
 *
 * So this asserts the rule directly. Colour, background, border-COLOUR, outline,
 * box-shadow, opacity, filter and transform are all free: none of them affect
 * layout. Anything that changes box metrics is banned inside a hover rule.
 *
 * This is a deliberately dumb regex-level parser. It does not understand CSS, it
 * understands "declaration inside a selector containing :hover", which is exactly
 * the granularity the bug lives at. Zero dependencies, runs in milliseconds.
 *
 *     node scripts/test-css.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const fails = [];
const ok = (name, cond, detail = "") =>
  cond ? pass++ : fails.push(name + (detail ? `\n      ${detail}` : ""));

/** Strip comments so a commented-out rule is never flagged. */
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Properties that change box metrics, so are banned in a hover rule. */
const LAYOUT = [
  "padding", "margin", "width", "height", "top", "right", "bottom", "left",
  "inset", "gap", "font-size", "font-weight", "font", "letter-spacing",
  "line-height", "display", "position", "flex", "grid", "border-radius",
  "border-width", "text-transform", "white-space", "vertical-align",
];

/**
 * A `border*` declaration is fine if it only names a colour. It is a layout
 * change the moment it carries a length or the keyword `none`, because that sets
 * a width.
 */
const borderSetsWidth = (prop, value) =>
  /^border(-(top|right|bottom|left|block|inline|start|end))*$/.test(prop) &&
  (/\d\s*(px|em|rem|%|pt)/.test(value) ||
   /\b(none|thin|medium|thick)\b/.test(value) ||
   /^\s*0\s*$/.test(value));

/** [{ selector, decls: [[prop, value]] }] for every rule in the sheet. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim();
    if (selector.startsWith("@")) continue;            // at-rule prelude
    const decls = m[2]
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
      })
      .filter(Boolean);
    out.push({ selector, decls });
  }
  return out;
}

const css = decomment(readFileSync(join(root, "docs/style.css"), "utf8"));
const all = rules(css);
const hovers = all.filter((r) => /:hover/.test(r.selector));

ok("the sheet parses into rules", all.length > 40, `got ${all.length}`);
ok("hover rules are found", hovers.length > 5, `got ${hovers.length}`);

// ---- the invariant ------------------------------------------------------- //
for (const { selector, decls } of hovers) {
  for (const [prop, value] of decls) {
    const banned =
      LAYOUT.some((p) => prop === p || prop.startsWith(p + "-")) ||
      borderSetsWidth(prop, value);
    ok(
      `hover rule changes no box metrics: ${selector}`,
      !banned,
      `\`${prop}: ${value}\` resizes the element, so hovering it moves the page.\n` +
      `      Change colour instead, or set the same value on the non-hover rule.`,
    );
  }
}

// ---- the specific regression -------------------------------------------- //
ok(
  "the pill hover no longer adds a bottom border",
  !/\.issue\s+\.links\s+a:hover\s*\{[^}]*border-bottom\s*:\s*\d/.test(css),
  "`.issue .links a:hover{border-bottom:1px...}` is exactly the 1px page jump.",
);
ok(
  "no `.issue .links a` override strips the pill border",
  !/\.issue\s+\.links\s+a\s*\{[^}]*border-bottom\s*:\s*0/.test(css),
  "That override beat `.links a` at (0,2,1) and caused the asymmetry.",
);

// A hover rule that only recolours is the correct shape; prove the good ones
// really are shaped that way rather than the test just being permissive.
const recolour = hovers.filter((r) =>
  r.decls.length && r.decls.every(([p]) => /colou?r|background|opacity|outline|box-shadow|filter|transform/.test(p)));
ok(
  "most hover rules only recolour",
  recolour.length >= Math.ceil(hovers.length * 0.6),
  `${recolour.length} of ${hovers.length} are colour-only`,
);

/* ---- motion must be switchable off -------------------------------------- */
{
  /*
   * The opt-out is a blanket universal selector on purpose.
   *
   * Listing animations individually means every new @keyframes needs a matching
   * line in the media query, and the one that gets forgotten is the one that
   * makes somebody ill. A `*, *::before, *::after` rule cannot be forgotten.
   *
   * Asserted rather than trusted because this is invisible to anyone not using
   * the setting, so it can rot for months without a single report.
   */
  const css = decomment(readFileSync(join(root, "docs/style.css"), "utf8"));
  const mq = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
  ok("a reduced-motion media query exists", Boolean(mq));

  const body = mq ? mq[1] : "";
  ok("it disables animation universally",
     /\*\s*,\s*\*::before\s*,\s*\*::after/.test(body),
     "Per-animation opt-outs rot: the next @keyframes will not be listed here.");
  ok("animation-duration is neutralised",
     /animation-duration:\s*\.?0*1?ms\s*!important/.test(body));
  ok("and so are looping animations",
     /animation-iteration-count:\s*1\s*!important/.test(body));
  ok("and transitions", /transition-duration:\s*\.?0*1?ms\s*!important/.test(body));

  /*
   * The two JS-driven animations are unreachable from CSS, so they check the
   * preference themselves. A requestAnimationFrame loop does not care what the
   * media query says.
   */
  const html = readFileSync(join(root, "docs/index.html"), "utf8");
  const guards = html.match(
    /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches/g) || [];
  ok("the JS count-up and bar growth each check the preference too",
     guards.length >= 2,
     `found ${guards.length}; CSS cannot stop a requestAnimationFrame loop.`);

  /*
   * Both JS animations render the TRUE value first and animate away from it, so
   * a thrown exception leaves the correct number on screen rather than a zero.
   */
  ok("the score renders its real value in the markup",
     /id="score-n"[\s\S]{0,60}\$\{h\.score\}/.test(html),
     "Rendering 0 and counting up means one bug shows every library a 0 score.");
  ok("and the bars render their real width",
     /data-w="\$\{Math\.max\(v, 2\)\}"[\s\S]{0,40}width:\$\{Math\.max\(v, 2\)\}%/.test(html),
     "Same reasoning: a failed animation must degrade to correct, not to empty.");
}

/* ---- the count-up can never render a number outside 0..score ------------ */
{
  /*
   * A real scan showed "-54/100" for a library whose score was 77.
   *
   * The easing is cubic, so it amplifies an out-of-range input rather than
   * absorbing it: 1-(1-t)^3 at t=-0.7 is -3.9. The progress was clamped at the
   * top only, and the first requestAnimationFrame callback can carry a timestamp
   * from a frame that started BEFORE the performance.now() that scheduled it,
   * which makes the elapsed time negative.
   *
   * Lasts one frame. Long enough to be seen, too short to reproduce on demand,
   * which is why it is pinned here rather than left to manual testing.
   */
  const html = readFileSync(join(root, "docs/index.html"), "utf8");
  ok("the count-up clamps progress at both ends",
     /Math\.min\(Math\.max\(\(now - start\) \/ DUR, 0\), 1\)/.test(html),
     "Clamping only the top lets a negative elapsed time through, and a cubic " +
     "ease turns that into a large negative score.");

  // The curve itself, so the reasoning above is checked rather than asserted.
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  ok("an unclamped negative t really does blow up",
     Math.round(77 * ease(-0.7)) < -100,
     `cubic ease at t=-0.7 gives ${ease(-0.7).toFixed(2)}`);
  const clamp = (t) => Math.min(Math.max(t, 0), 1);
  ok("and the clamp contains it",
     [-5, -0.7, 0, 0.5, 1, 9].every((t) => {
       const v = Math.round(77 * ease(clamp(t)));
       return v >= 0 && v <= 77;
     }),
     "Every input must land inside 0..score.");
}

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\n  FAILED");
  for (const f of fails) console.log("   x " + f);
  process.exit(1);
}
console.log("  No hover rule changes layout.\n");
