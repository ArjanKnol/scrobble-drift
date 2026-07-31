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

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("\n  FAILED");
  for (const f of fails) console.log("   x " + f);
  process.exit(1);
}
console.log("  No hover rule changes layout.\n");
