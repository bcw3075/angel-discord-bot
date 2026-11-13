import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transcript, clock } from "../src/transcript.mjs";

const T0 = new Date(2026, 10, 14, 19, 0, 0).getTime();

test("lines are kept in the order they were said, even when their text arrives out of order", () => {
  const t = new Transcript();
  t.add({ at: T0 + 5000, speaker: "Mira", text: "second" });
  t.add({ at: T0 + 1000, speaker: "Dana", role: "GM", text: "first" });
  t.add({ at: T0 + 9000, speaker: "Angel", kind: "angel", text: "third" });
  assert.deepEqual(t.lines.map(l => l.text), ["first", "second", "third"]);
  assert.equal(Transcript.format(t.lines), "[19:00:01] Dana (GM): first\n[19:00:05] Mira: second\n[19:00:09] Angel: third");
  assert.equal(t.add({ at: T0, speaker: "x", text: "   " }), null, "empty lines are dropped");
});

test("recent() is the remembered window and before() the lines leading up to one", () => {
  const t = new Transcript();
  for (let i = 0; i < 30; i++) t.add({ at: T0 + i * 60000, speaker: "P", text: `line ${i}` });
  assert.equal(t.recent(15, T0 + 29 * 60000).length, 16);
  const line = t.lines[10];
  assert.deepEqual(t.before(line, 3).map(l => l.text), ["line 8", "line 9", "line 10"]);
  assert.equal(clock(T0), "19:00:00");
});

test("the transcript is written to its folder as it goes, typed lines marked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-t-"));
  const t = new Transcript({ dir, startedAt: T0, title: "Test table" });
  t.add({ at: T0 + 1000, speaker: "Tobin", text: "Angel, what's flanking?" });
  t.add({ at: T0 + 2000, speaker: "Tobin", text: "typed thing", kind: "text" });
  const md = fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  assert.match(md, /^# Test table transcript/);
  assert.match(md, /\[19:00:01\] Tobin: Angel, what's flanking\?/);
  const jl = fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(jl.length, 2);
  assert.equal(jl[1].kind, "text");
  assert.match(Transcript.format([t.lines[1]]), /Tobin \(typed\): typed thing/);
});
