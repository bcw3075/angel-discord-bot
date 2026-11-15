import { test } from "node:test";
import assert from "node:assert/strict";
import { Aon, AON_SEARCH } from "../src/aon.mjs";
import { scriptedFetch } from "./helpers.mjs";

const hits = docs => ({ body: { hits: { hits: docs.map(({ _id, ...s }) => ({ _id, _source: s })) } } });
const legacy = { _id: "condition-16", name: "Flat-Footed", category: "condition", url: "/Conditions.aspx?ID=16", primary_source: "Core Rulebook", remaster_id: ["condition-58"] };
const remaster = { _id: "condition-58", name: "Off-Guard", category: "condition", url: "/Conditions.aspx?ID=58", primary_source: "Player Core", legacy_id: ["condition-16"], text: "Condition Off-Guard Source Player Core pg. 445 You take a –2 circumstance penalty to AC." };

test("an old entry is swapped for its Remaster version, noting the old name", async () => {
  const f = scriptedFetch([hits([legacy, remaster]), hits([remaster])]);
  const aon = new Aon({ userAgent: "test-agent", fetchImpl: f });
  const r = await aon.search("flat-footed");
  assert.equal(r.length, 1, "the two become one");
  assert.deepEqual(r[0], { id: "condition-58", name: "Off-Guard", category: "condition", level: undefined, url: "https://2e.aonprd.com/Conditions.aspx?ID=58", source: "Player Core", summary: undefined, oldName: "Flat-Footed", legacy: undefined, older: undefined, preRemaster: undefined, released: undefined });
  assert.equal(f.calls[0].url, AON_SEARCH);
  assert.equal(f.calls[0].init.headers["User-Agent"], "test-agent");
  const body = JSON.parse(f.calls[0].body);
  assert.deepEqual(body.query.bool.must_not, [{ term: { exclude_from_search: true } }], "reprints hidden");
  assert.deepEqual(JSON.parse(f.calls[1].body).query, { ids: { values: ["condition-58"] } });
});

test("the same search twice asks AoN once (cache), and a category filters", async () => {
  const f = scriptedFetch([hits([remaster]), hits([remaster])]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f });
  await aon.search("off-guard");
  await aon.search("off-guard");
  assert.equal(aon.requests, 1);
  await aon.search("off-guard", { category: "Condition" });
  assert.deepEqual(JSON.parse(f.calls[1].body).query.bool.filter, [{ term: { category: "condition" } }]);
});

test("a renamed class feature inside a class page isn't called an old name", async () => {
  const oldFeat = { _id: "classfeature-1", name: "Shield Block", category: "class-feature", url: "/x", remaster_id: ["class-58"] };
  const cls = { _id: "class-58", name: "Champion", category: "class", url: "/Classes.aspx?ID=58" };
  const aon = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([oldFeat]), hits([cls])]) });
  const [r] = await aon.search("shield block");
  assert.equal(r.name, "Champion");
  assert.equal(r.oldName, undefined);
});

test("one entry's text by its link or its id, Remaster preferred and long text cut", async () => {
  const f = scriptedFetch([hits([legacy]), hits([remaster])]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f, maxTextChars: 40 });
  const a = await aon.get("https://2e.aonprd.com/Conditions.aspx?ID=16");
  assert.deepEqual(JSON.parse(f.calls[0].body).query, { term: { url: "/Conditions.aspx?ID=16" } });
  assert.deepEqual(JSON.parse(f.calls[1].body).query, { ids: { values: ["condition-58"] } });
  assert.equal(a.name, "Off-Guard");
  assert.equal(a.truncated, true);
  assert.ok(a.text.endsWith("…") && a.text.length <= 42);
  /* by id: the very request the swap above made, so it comes from the cache */
  const b = await aon.get("condition-58");
  assert.equal(f.calls.length, 2);
  assert.equal(b.name, "Off-Guard");
});

test("AoN errors are reported, and an empty query asks nothing", async () => {
  const aon = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([{ status: 503, body: "busy" }]) });
  assert.deepEqual(await aon.search("  "), []);
  await assert.rejects(aon.search("grapple"), /503/);
  assert.equal(await new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([])]) }).get("nothing-1"), null);
});

test("cached entries keep a trimmed text, and the cache file is written once, a moment after the lookups", async () => {
  const fsMod = await import("node:fs"), os = await import("node:os"), pathMod = await import("node:path");
  const file = pathMod.join(fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "angel-a-")), "aon-cache.json");
  const long = { ...remaster, text: "x".repeat(50000) };
  const aon = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([long]), hits([remaster])]), cacheFile: file, maxTextChars: 100, saveDelayMs: 20 });
  await aon.get("condition-58");
  await aon.search("off-guard");
  assert.equal(fsMod.existsSync(file), false, "not written at each lookup");
  await new Promise(r => setTimeout(r, 60));
  const saved = JSON.parse(fsMod.readFileSync(file, "utf8"));
  assert.equal(Object.keys(saved).length, 2);
  assert.ok(Object.values(saved).every(v => v.data.every(d => !d.text || d.text.length <= 300)), "long texts are cut before caching");
  const again = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([]), cacheFile: file });
  assert.equal((await again.search("off-guard"))[0].name, "Off-Guard", "a restart reads the saved cache");
});

test("an entry cut before caching is still called cut, even when its spaces shrink it under the limit", async () => {
  /* raw AoN text is mostly runs of spaces and line breaks; cut first, collapsed after, it can look whole */
  const spacey = { ...remaster, text: "Off-Guard" + " \n".repeat(400) + "the end" };
  const aon = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([spacey])]), maxTextChars: 100 });
  const a = await aon.get("condition-58");
  assert.ok(a.text.length < 100);
  assert.equal(a.truncated, true);
});

test("a search can bring the top entries' text, and an entry named exactly what was asked goes first", async () => {
  const three = { _id: "rules-9", name: "3D Flanking", category: "rules", url: "/Rules.aspx?ID=9" };
  const flank = { _id: "rules-7", name: "Flanking", category: "rules", url: "/Rules.aspx?ID=7" };
  const avoid = { _id: "rules-8", name: "Avoiding Flanking", category: "rules", url: "/Rules.aspx?ID=8" };
  const long = "word ".repeat(100).trim();
  const f = scriptedFetch([hits([three, flank, avoid]), hits([{ ...three, text: "In the air." }, { ...flank, text: `Flank  them\n${long}` }])]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f });
  const r = await aon.search("Flanking", { withText: 2, searchTextChars: 60 });
  assert.deepEqual(r.map(e => e.name), ["Flanking", "3D Flanking", "Avoiding Flanking"], "the exact name first, the rest in the index's order");
  assert.deepEqual(JSON.parse(f.calls[1].body).query, { ids: { values: ["rules-7", "rules-9"] } }, "one request for the top entries' text");
  assert.equal(r[1].text, "In the air.");
  assert.equal(r[1].truncated, undefined);
  assert.ok(r[0].text.startsWith("Flank them word") && r[0].text.endsWith(" …") && r[0].text.length === 62, "long text is cut and marked");
  assert.equal(r[0].truncated, true);
  assert.equal(r[2].text, undefined, "the others are listed without text");
  /* an old name that was searched for counts as exact too */
  const f2 = scriptedFetch([hits([{ _id: "x-1", name: "Tumble Behind", category: "feat", url: "/a" }, legacy]), hits([remaster]), hits([remaster])]);
  const r2 = await new Aon({ userAgent: "t", fetchImpl: f2 }).search("flat footed", { withText: 1 });
  assert.equal(r2[0].name, "Off-Guard");
  assert.match(r2[0].text, /circumstance penalty to AC/);
  /* the text request failing only costs the shortcut */
  const f3 = scriptedFetch([hits([flank]), { status: 503, body: "busy" }]);
  const r3 = await new Aon({ userAgent: "t", fetchImpl: f3 }).search("flanking", { withText: 3 });
  assert.equal(r3[0].name, "Flanking");
  assert.equal(r3[0].text, undefined);
  /* without withText nothing more is asked */
  const f4 = scriptedFetch([hits([flank])]);
  await new Aon({ userAgent: "t", fetchImpl: f4 }).search("flanking");
  assert.equal(f4.calls.length, 1);
});

test("of entries with the same name and kind, the newest printing goes first and the others are marked older", async () => {
  const old = { _id: "action-5", name: "Retributive Strike", category: "action", url: "/a5", primary_source: "Core Rulebook", release_date: "2019-08-01" };
  const now = { _id: "action-2807", name: "Retributive Strike", category: "action", url: "/a2807", primary_source: "Player Core 2", release_date: "2024-08-01" };
  const beast = { _id: "creature-ability-31", name: "Retributive Strike", category: "creature-ability", url: "/c31", primary_source: "Bestiary", release_date: "2019-08-01" };
  const other = { _id: "feat-1", name: "Retributive Focus", category: "feat", url: "/f1", release_date: "2024-01-01" };
  const f = scriptedFetch([hits([old, other, now, beast]), hits([{ ...now, text: "in your champion's aura" }])]);
  const r = await new Aon({ userAgent: "t", fetchImpl: f }).search("retributive strike", { withText: 1 });
  assert.deepEqual(r.map(e => [e.id, e.older, e.released]), [["action-2807", undefined, "2024"], ["action-5", true, "2019"], ["feat-1", undefined, "2024"], ["creature-ability-31", undefined, "2019"]], "the newest first, the old one marked, a different kind of entry left alone");
  assert.match(r[0].text, /champion's aura/, "and it is the newest printing whose text comes with the search");
  assert.deepEqual(r.map(e => e.preRemaster), [undefined, true, undefined, true], "entries from before the Remaster say so");
  /* two entries since the Remaster with one name can be different things: neither is marked, the index's order stays */
  const general = { _id: "feat-10", name: "Shield Block", category: "feat", url: "/s1", release_date: "2023-11-15" }, later = { _id: "feat-99", name: "Shield Block", category: "feat", url: "/s2", release_date: "2026-01-01" };
  const r3 = await new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([general, later])]) }).search("shield block");
  assert.deepEqual(r3.map(e => [e.id, e.older]), [["feat-10", undefined], ["feat-99", undefined]]);
  /* an old entry is never moved up for having the exact name */
  const aoo = { _id: "action-1", name: "Attack of Opportunity", category: "action", url: "/o", release_date: "2019-08-01" }, rs = { _id: "action-2", name: "Reactive Strike", category: "action", url: "/n", release_date: "2023-11-15" };
  const r4 = await new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([rs, aoo])]) }).search("attack of opportunity");
  assert.deepEqual(r4.map(e => e.name), ["Reactive Strike", "Attack of Opportunity"]);
  /* entries without dates keep the index's order */
  const a = { _id: "a-1", name: "Same", category: "rules", url: "/1" }, b = { _id: "a-2", name: "Same", category: "rules", url: "/2", release_date: "2024-01-01" };
  const r2 = await new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([a, b])]) }).search("same");
  assert.deepEqual(r2.map(e => [e.id, e.older]), [["a-1", undefined], ["a-2", undefined]]);
});

test("an incomplete answer from the index is an error, and 'nothing found' is believed for ten minutes only", async () => {
  let now = 1e9;
  const f = scriptedFetch([{ body: { timed_out: true, hits: { hits: [] } } }, { body: { _shards: { failed: 1 }, hits: { hits: [] } } }, { body: {} }, hits([]), hits([remaster])]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f, now: () => now });
  await assert.rejects(aon.search("off-guard"), /incomplete answer/);
  await assert.rejects(aon.search("off-guard"), /incomplete answer/);
  await assert.rejects(aon.search("off-guard"), /incomplete answer/);
  assert.deepEqual(await aon.search("off-guard"), [], "a true 'nothing found'");
  now += 9 * 60000;
  assert.deepEqual(await aon.search("off-guard"), []);
  assert.equal(f.calls.length, 4, "believed for now");
  now += 2 * 60000;
  assert.equal((await aon.search("off-guard"))[0].name, "Off-Guard", "asked again after ten minutes");
});

test("the cache file is written a few seconds after the last lookup, not after the first", async () => {
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "angel-aon-"));
  const file = (await import("node:path")).join(dir, "aon-cache.json");
  const aon = new Aon({ userAgent: "t", fetchImpl: scriptedFetch([hits([remaster]), hits([legacy]), hits([remaster])]), cacheFile: file, saveDelayMs: 60 });
  await aon.search("off-guard");
  await new Promise(r => setTimeout(r, 40));
  await aon.search("grabbed");
  await new Promise(r => setTimeout(r, 40));
  assert.equal((await import("node:fs")).existsSync(file), false, "80 ms after the first lookup, 40 after the last: not yet");
  await new Promise(r => setTimeout(r, 60));
  assert.equal((await import("node:fs")).existsSync(file), true);
});

test("the texts go to different entries, and a broken cache entry is asked again", async () => {
  const a = { _id: "equipment-1", name: "Animal Blind", category: "equipment", primary_source: "Treasure Vault", url: "/e1" };
  const a2 = { _id: "equipment-1-2", name: "Animal Blind", category: "equipment", primary_source: "Treasure Vault", url: "/e1b" };
  const b = { _id: "feat-2", name: "Blind-Fight", category: "feat", primary_source: "Player Core", url: "/f2" };
  const f = scriptedFetch([hits([a, a2, b]), hits([{ ...a, text: "A hide." }, { ...b, text: "You fight blind." }])]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f });
  const r = await aon.search("blind", { withText: 2 });
  assert.deepEqual(JSON.parse(f.calls[1].body).query, { ids: { values: ["equipment-1", "feat-2"] } }, "the variant doesn't take a text slot");
  assert.deepEqual(r.map(e => e.text), ["A hide.", undefined, "You fight blind."]);
  const g0 = scriptedFetch([hits([b])]);
  const broken = new Aon({ userAgent: "t", fetchImpl: g0 });
  await broken.search("blind");
  for (const v of broken.cache.values()) delete v.data;
  const g = scriptedFetch([hits([b])]); broken.fetch = g;
  assert.equal((await broken.search("blind"))[0].name, "Blind-Fight");
  assert.equal(g.calls.length, 1);
});

test("for a wordy search, the entry whose name is among the words asked comes first, the one named earliest leading (live 2026-11-14)", async () => {
  const mk = (id, name, category = "rules", extra = {}) => ({ _id: id, name, category, url: `/${id}`, primary_source: "Player Core", release_date: "2023-11-15", ...extra });
  const index = [mk("r1", "Counting Damage Dice"), mk("r2", "Adding Damage Dice"), mk("r3", "Increasing Die Size"), mk("r4", "Multiple Types"), mk("r5", "Damage Types", "sidebar"), mk("r6", "Damage"), mk("r7", "Resistance"), mk("f1", "Resistance", "familiar-ability"), mk("o1", "Resistance", "rules", { release_date: "2019-08-01", primary_source: "Core Rulebook" })];
  const f = scriptedFetch([hits(index), hits([{ ...index[6], text: "the subject can choose which damage type" }, index[3], index[4]].map((d, i) => ({ ...d, text: d.text ?? `t${i}` })))]);
  const aon = new Aon({ userAgent: "t", fetchImpl: f });
  const r = await aon.search("resistance multiple damage types", { withText: 3 });
  assert.equal(JSON.parse(f.calls[0].body).size, 30, "enough are read to find it among them");
  assert.deepEqual(r.map(e => `${e.name}/${e.category}`), ["Resistance/rules", "Resistance/rules", "Resistance/familiar-ability", "Multiple Types/rules", "Damage Types/sidebar", "Damage/rules"], "named in the search first, the earliest named leading; the dice entries that only share a word are gone from the six");
  assert.equal(r[1].older, true, "the old printing follows the new one and is marked");
  assert.match(r[0].text, /choose which damage type/, "and its text comes with the search");
  assert.deepEqual(JSON.parse(f.calls[1].body).query.ids.values, ["r7", "f1", "r4"], "the texts go to different entries");
  const f2 = scriptedFetch([hits([mk("d1", "Counting Damage Dice"), mk("d2", "Damage"), mk("c1", "Persistent Damage", "condition"), mk("t1", "Fire", "trait")])]);
  const r2 = await new Aon({ userAgent: "t", fetchImpl: f2 }).search("persistent fire damage");
  assert.deepEqual(r2.map(e => e.name), ["Persistent Damage", "Fire", "Damage", "Counting Damage Dice"]);
});
