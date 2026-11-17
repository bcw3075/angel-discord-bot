import { test } from "node:test";
import assert from "node:assert/strict";
import { withNames } from "../src/services.mjs";

/* live round 2026-11-16: a player's Discord name was heard as a campaign name, because the players' names weren't key terms */
test("(st-13) the transcriber's key terms: the file's first, then the names heard, no repeats, nothing odd, within the limit", () => {
  assert.deepEqual(withNames(["Angel", "Velmora"], ["Kestrel", "angel", "Rhea", "Kestrel", "", "  ", "123", "x".repeat(41)]), ["Angel", "Velmora", "Kestrel", "Rhea"]);
  const many = Array.from({ length: 120 }, (_, i) => `T${i}`);
  const r = withNames(many.slice(0, 99), ["Kestrel", "Rhea"]);
  assert.equal(r.length, 100);
  assert.equal(r[98], "T98", "the file's terms are never pushed out");
  assert.equal(r[99], "Kestrel");
  assert.deepEqual(withNames(["Angel"]), ["Angel"]);
});
