/**
 * Discovery offers: the cards that replaced step 2 of the scan.
 *
 * The reasoning being tested. Enrichment adds detail to a finding that is already
 * on screen, so it can wait behind a button on that finding. Discovery CREATES
 * the finding, and the old conclusion was that it therefore had to run during the
 * scan, because you cannot click a button on something that is not there.
 *
 * That conclusion was wrong, and it cost a 2,000-scrobble library twenty minutes
 * of lookups nobody had asked for. You cannot click the FINDING, but you can
 * click the CATEGORY, and the category is knowable from local data alone. These
 * assertions pin that down: an offer must be derivable with no network, must
 * carry the exact jobs its detector needs, and must never be produced for a
 * category that is empty.
 *
 *     node scripts/test-discovery.mjs
 */
import { discoveryOffers, d14eReleasedSince, d16StrandedSingles, partitionEra }
  from "../docs/drift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); }
                       else { fail++; console.log(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(Object.is(a, b), `${m}  (got ${JSON.stringify(a)})`);

const uts = (d) => Math.floor(new Date(d).getTime() / 1000);
let n = 0;
const play = (artist, track, album, date) =>
  ({ artist, track, album, uts: uts(date) + n++ });

/* ---- an empty library offers nothing ------------------------------------ */
{
  eq(discoveryOffers([]).length, 0, "no scrobbles, no offers");

  /*
   * The important half of that. An offer for a category with no members is a
   * button that spends a minute to tell you what the tool already knew, and it
   * is exactly the sort of thing that survives a refactor unnoticed because it
   * looks harmless.
   */
  const plain = [
    play("Adele", "Hello", "25", "2015-11-01"),
    play("Adele", "Hello", "25", "2015-11-02"),
  ];
  const ids = discoveryOffers(plain).map((o) => o.id);
  ok(!ids.includes("era_released"),
     "a library with no unreleased material is not offered a leak check");
}

/* ---- era material produces an offer that feeds D14e --------------------- */
{
  const lib = [
    play("Kanye West", "Dark Fantasy", "Unreleased (Yandhi Era)", "2019-01-05"),
    play("Kanye West", "Dark Fantasy", "Unreleased (Yandhi Era)", "2019-02-05"),
    play("Kanye West", "Chakras", "Unreleased (Yandhi Era)", "2019-03-05"),
    play("Travis Scott", "Antidote", "Rodeo", "2015-10-01"),
  ];

  const offers = discoveryOffers(lib);
  const era = offers.find((o) => o.id === "era_released");
  ok(era, "unreleased material is offered as a category");
  eq(era.detector, "D14e", "and names the detector it will run");
  eq(era.jobs.length, 2, "one job per distinct track, not per scrobble");
  eq(era.jobs[0].plays, 2, "busiest first, with its play count");
  ok(/2 tracks are filed as unreleased/.test(era.title),
     "the card states the size of the category, which is what makes it clickable");
  ok(era.action && era.note, "and says what pressing it does");

  /*
   * The offer's jobs must actually be what the detector consumes. An offer that
   * plans one thing and runs another is worse than no offer: it reports a cost
   * for work it does not do.
   */
  const { era: eraPlays } = partitionEra(lib);
  const found = d14eReleasedSince(eraPlays, (artist, track) =>
    track === "Dark Fantasy"
      ? { groups: [{ title: "Donda", primary: "Album", status: "Official",
                     first_release: "2021-08-29", source: "spotify" }] }
      : null);
  eq(found.length, 1, "the jobs feed D14e and it finds the released one");
  eq(found[0].detector, "D14e", "as a D14e finding");

  // Every job the offer promised is a track D14e will ask about.
  const asked = new Set();
  d14eReleasedSince(eraPlays, (a, t) => { asked.add(t); return null; });
  ok(era.jobs.every((j) => asked.has(j.track)),
     "and every job the card charged for is a track the detector looks up");
}

/* ---- stranded singles are offered too, which is how D16 got wired ------- */
{
  /*
   * D16 was built, tested with 62 assertions, and had no caller for weeks. It is
   * discovery, so under the old model it could only have run in the scan, and the
   * scan was already the thing being cut back. The offer card is what let it in.
   */
  const lib = [
    play("Fetty Wap", "Trap Queen", "Trap Queen - Single", "2014-05-01"),
    play("Fetty Wap", "Trap Queen", "Trap Queen - Single", "2014-06-01"),
    play("Adele", "Hello", "25", "2015-11-01"),
  ];

  const offer = discoveryOffers(lib).find((o) => o.id === "stranded_singles");
  ok(offer, "a single-shaped album string is offered as a category");
  eq(offer.detector, "D16", "and names D16");
  ok(offer.jobs.length >= 1, "with at least the one candidate");
  ok(offer.owned instanceof Set,
     "and carries the owned album strings D16 needs to avoid re-suggesting one");

  const found = d16StrandedSingles(offer.jobs, () => ({
    groups: [{ title: "Fetty Wap", primary: "Album", first_release: "2015-09-25" }],
  }), { owned: offer.owned });
  ok(found.length >= 1, "the offer's own jobs and owned set drive D16 directly");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
