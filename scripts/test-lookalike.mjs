/**
 * D17: names that look identical but are different strings to Last.fm.
 *
 * Found by comparing against another tool on a real 144k export: two plays under
 * 'Pi'erre Bourne' (straight apostrophe) next to 165 under 'Pi’erre Bourne', and
 * a handful of titles with double spaces, none of which this tool reported.
 *
 * Run: node scripts/test-lookalike.mjs
 */
import { analyse, d17Lookalikes, lookalikeKey, hiddenCharacters, visibleName,
         affectsChart, isResolvable } from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

let uts = 1600000000;
const P = (artist, album, track, n) =>
  Array.from({ length: n }, () => ({ artist, album, track, uts: (uts += 100) }));

console.log("\nhelpers");
eq(lookalikeKey("Pi’erre  Bourne​ "), "Pi'erre Bourne", "key folds apostrophes, spaces and zero-width");
eq(hiddenCharacters("In O4'  (feat. Gucci Mane)").join(), "double space", "double space named");
eq(hiddenCharacters("Roaches (​$up)").join(), "zero-width character", "zero-width named");
eq(hiddenCharacters("A B").join(), "non-breaking space", "nbsp named");
eq(hiddenCharacters("Normal title").length, 0, "a normal title has none");
eq(visibleName("a  b"), "a␣␣b", "a double space is drawn");
eq(visibleName("x​y"), "x[zero-width]y", "a zero-width character is drawn");

console.log("\nartist twins");
{
  const s = [...P("Pi’erre Bourne", "Unreleased (TLOP5 Era)", "Sossboy", 20),
             ...P("Pi'erre Bourne", "Unreleased (TLOP5 Era)", "Other", 2)];
  const r = analyse(s, { official: new Set(), topAlbums: [] });
  const f = r.issues.filter((i) => i.detector === "D17");
  eq(f.length, 1, "an apostrophe twin is reported even when it lives only under era tags");
  eq(f[0]?.class, "split", "  as a split");
  ok(/straight apostrophe ' \(U\+0027\)/.test(f[0]?.suggest || ""), "  naming the character and code point");
  eq(f[0]?.plays_affected, 22, "  counting both spellings");
  ok(affectsChart(f[0]), "  and it affects the chart");
  ok(!isResolvable(f[0]), "  with no lookup button: there is nothing to look up");
  ok(!r.issues.some((i) => i.detector === "D6" && /look identical/.test(i.suggest)),
     "  and no unrelated finding is annotated with it");
}

console.log("\ncasing alone stays silent");
{
  const f = d17Lookalikes([...P("Drake", "Views", "Hype", 5), ...P("drake", "Views", "Hype", 2)]);
  eq(f.length, 0, "Drake vs drake is not a look-alike finding");
}

console.log("\ntrack twins fold into the credit finding that already lists them");
{
  const s = [...P("Lil Uzi Vert", "Luv Is Rage", "In O4' (feat. Gucci Mane)", 10),
             ...P("Lil Uzi Vert", "Luv Is Rage", "In O4'  (feat. Gucci Mane)", 3)];
  const r = analyse(s, { official: new Set(), topAlbums: [] });
  const d8 = r.issues.filter((i) => i.detector === "D8");
  eq(d8.length, 1, "D8 still reports the split");
  ok(/double space/.test(d8[0]?.suggest || ""), "  and now says the difference is a double space");
  ok(d8[0]?.members.some((m) => m.shown === "In O4'␣␣(feat. Gucci Mane)"), "  with the space drawn in");
  eq(r.issues.filter((i) => i.detector === "D17").length, 0, "  and no duplicate D17 card");
}

console.log("\nhidden characters with no twin");
{
  const s = [...P("Dean Blunt", "Roaches (​$​up)", "T", 12),
             ...P("Kent", "A", "Kent Nugent  (feat. Quavo)", 1),
             ...P("Kent", "A", "Clean", 5)];
  const f = d17Lookalikes(s);
  eq(f.length, 1, "collected into one finding");
  eq(f[0]?.class, "review", "  worth a look, not a split");
  eq(f[0]?.reason, "hidden-only", "  marked hidden-only");
  ok(!affectsChart(f[0]), "  which does not affect the chart");
  eq(f[0]?.members.length, 2, "  listing both names");
  ok(/'\+\+'/.test(f[0]?.suggest || ""), "  and explains the ++ in the Last.fm address");
  ok(f[0]?.members.every((m) => m.artist), "  each member carries its artist for the links");
}

console.log("\ntwo artists sharing an album title are not look-alikes");
{
  const f = d17Lookalikes([...P("A", "Greatest Hits", "x", 3), ...P("B", "Greatest  Hits", "y", 3)]);
  ok(!f.some((i) => i.class === "split"), "album twins are only compared within one artist");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
