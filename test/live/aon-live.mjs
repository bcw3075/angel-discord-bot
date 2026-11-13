/* Live check against the real Archives of Nethys index (`npm run test:aon`; needs the internet, costs nothing).
   Proves the request shape still works and that Remaster entries win. Run it when AoN or this code changes. */
import assert from "node:assert/strict";
import { Aon } from "../../src/aon.mjs";
import { DEFAULTS } from "../../src/config.mjs";

const aon = new Aon({ userAgent: DEFAULTS.aonUserAgent });
const cases = [
  ["flat-footed", null, "Off-Guard", "Flat-Footed"],
  ["attack of opportunity", null, "Reactive Strike", null],
  ["grabbed", "condition", "Grabbed", null],
  ["grapple", "action", "Grapple", null],
  ["fireball", "spell", "Fireball", null],
];
let failed = 0;
for (const [q, category, want, old] of cases) {
  try {
    const [first] = await aon.search(q, { category });
    assert.equal(first?.name, want);
    assert.equal(first.source && /Core/.test(first.source), true, `a Remaster core book (${first.source})`);
    if (old) assert.equal(first.oldName, old);
    assert.match(first.url, /^https:\/\/2e\.aonprd\.com\//);
    console.log(`  pass  ${q}${category ? ` [${category}]` : ""} → ${first.name} (${first.source})${first.oldName ? `, old name ${first.oldName}` : ""}`);
  } catch (e) { failed++; console.log(`  FAIL  ${q}: ${e.message}`); }
}
try {
  const doc = await aon.get("https://2e.aonprd.com/Conditions.aspx?ID=16");
  assert.equal(doc.name, "Off-Guard");
  assert.match(doc.text, /circumstance penalty to AC/);
  console.log(`  pass  get by an old link → ${doc.name}, ${doc.text.length} characters of text`);
} catch (e) { failed++; console.log(`  FAIL  get: ${e.message}`); }
console.log(failed ? `${failed} failed (${aon.requests} requests)` : `all passed (${aon.requests} requests)`);
process.exit(failed ? 1 : 0);
