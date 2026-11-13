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
  assert.deepEqual(r[0], { id: "condition-58", name: "Off-Guard", category: "condition", level: undefined, url: "https://2e.aonprd.com/Conditions.aspx?ID=58", source: "Player Core", summary: undefined, oldName: "Flat-Footed", legacy: undefined });
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
