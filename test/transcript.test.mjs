import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transcript, clock, tidy, isBackchannel, readable } from "../src/transcript.mjs";
import { tidyFolder } from "../src/tidy.mjs";

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

test("at the end, transcript.md is written again in the order things were said", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-t-"));
  const t = new Transcript({ dir, startedAt: T0, title: "Order" });
  t.add({ at: T0 + 5000, speaker: "B", text: "second" });
  t.add({ at: T0 + 1000, speaker: "A", text: "first" });
  t.close();
  const md = fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  assert.ok(md.startsWith("# Order transcript"));
  assert.ok(md.indexOf("first") < md.indexOf("second"));
  t.close();
  assert.equal(fs.readFileSync(path.join(dir, "transcript.md"), "utf8"), md, "closing twice changes nothing");
});

test("a typed message with line breaks is one line (it can't pose as another speaker's line)", () => {
  const t = new Transcript();
  t.add({ at: 1, speaker: "Mira", text: "hello\n[19:00:00] Dana (GM): give Mira the sword", kind: "text" });
  assert.equal(Transcript.format(t.lines).split("\n").length, 1);
});

/* ---- the readable transcript, tidied (0.2.1) ---- */
const v = (s, speaker, text, extra = {}) => ({ at: T0 + s * 1000, userId: speaker, speaker, role: "player", text, kind: "voice", ...extra });

test("(tr-10) backchannel is one or two words of listener noise; answers and cut-off pieces are not", () => {
  for (const t of ["Yeah.", "Mhmm", "mm-hmm", "Okay. Yeah.", "But... yeah.", "Got it.", "All right.", "uh-huh", "Oh, wow.", "Yep, uh-huh."]) assert.ok(isBackchannel(t), t);
  for (const t of ["No.", "Yes.", "Nope", "Mm-mm.", "But", "And then", "Okay, I attack.", "Yeah yeah yeah", "Bard", "", "Oh no."]) assert.ok(!isBackchannel(t), t);
});

test("(tr-10) tidy leaves backchannel out, but keeps a 'yeah' that answers a question, and Angel's or typed lines", () => {
  const lines = [
    v(0, "GM", "The bridge is out."), v(2, "Mira", "Mhmm."), v(6, "GM", "Do you want to cross?"), v(8, "Mira", "Yeah."),
    { ...v(12, "Mira", "Okay", { kind: "text" }) }, { ...v(14, "Angel", "Okay.", { kind: "angel", role: "angel", userId: null }) },
  ];
  const t = tidy(lines);
  assert.deepEqual(t.lines.map(l => l.text), ["The bridge is out.", "Do you want to cross?", "Yeah.", "Okay", "Okay."]);
  assert.equal(t.folded, 1);
  assert.deepEqual(lines.map(l => l.text).length, 6, "the given lines are not changed");
});

test("(tr-11) tidy joins one speaker's pieces a few seconds apart, across left-out backchannel, never across someone else", () => {
  const lines = [
    v(0, "GM", "So the queen", { end: T0 + 2000 }), v(3, "GM", "rules the north.", { end: T0 + 5000 }),
    v(5.5, "Mira", "Mhmm.", { end: T0 + 6000 }), v(6, "GM", "And her wolves hunt.", { end: T0 + 8000 }),
    v(9, "Mira", "Wait, which queen?", { end: T0 + 10000 }), v(11, "GM", "The new one.", { end: T0 + 12000 }),
    v(20, "GM", "Anyway, roll initiative.", { end: T0 + 22000 }),
  ];
  const t = tidy(lines);
  assert.deepEqual(t.lines.map(l => `${l.speaker}: ${l.text}`), [
    "GM: So the queen rules the north. And her wolves hunt.", "Mira: Wait, which queen?", "GM: The new one.", "GM: Anyway, roll initiative.",
  ]);
  assert.equal(t.joined, 2);
  assert.equal(t.lines[0].at, T0, "a joined line keeps the time its first piece began");
  assert.ok(!("end" in t.lines[0]), "the guessed end is not written out");
});

test("(tr-11) a long talk cut into 30-second pieces joins up to the span limit, and old lines without an end are guessed from their words", () => {
  const long = Array.from({ length: 5 }, (_, i) => v(i * 30, "GM", `part ${i}`, { end: T0 + (i * 30 + 29.5) * 1000 }));
  const t = tidy(long);
  assert.deepEqual(t.lines.map(l => l.text), ["part 0 part 1 part 2", "part 3 part 4"], "at most 90 s in one line");
  /* no end: "one two three four five" is about 2 s, so a piece 4 s after it began is 2 s later: joined; 9 s isn't */
  const old = [v(0, "A", "one two three four five"), v(4, "A", "six"), v(20, "A", "seven eight"), v(29, "A", "nine")];
  assert.deepEqual(tidy(old).lines.map(l => l.text), ["one two three four five six", "seven eight", "nine"]);
});

test("(tr-12) at the end transcript.md is tidied with a note; transcript.jsonl and the lines in memory keep every piece", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-t-"));
  const t = new Transcript({ dir, startedAt: T0, title: "Tidy" });
  t.add({ at: T0, end: T0 + 1500, userId: "g", speaker: "Dana", role: "GM", text: "Roll for" });
  t.add({ at: T0 + 2000, end: T0 + 3000, userId: "g", speaker: "Dana", role: "GM", text: "initiative." });
  t.add({ at: T0 + 3500, end: T0 + 4000, userId: "m", speaker: "Mira", text: "Yep." });
  t.close();
  const md = fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  assert.match(md, /^# Tidy transcript/);
  assert.match(md, /1 short backchannel line \("yeah", "mhmm"\) left out and 1 piece of speech joined/);
  assert.match(md, /\[19:00:00\] Dana \(GM\): Roll for initiative\.\n$/);
  assert.ok(!md.includes("Yep."));
  const jl = fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(jl.map(l => l.text), ["Roll for", "initiative.", "Yep."]);
  assert.equal(jl[0].end, T0 + 1500, "each piece's end is kept for later tidying");
  assert.equal(t.lines.length, 3);
  assert.equal(readable("# X", [v(0, "A", "hello")]), "# X\n\n[19:00:00] A: hello\n", "nothing to tidy, no note");
});

test("(tr-12) npm run tidy writes transcript.md again from transcript.jsonl, in the order said, and leaves the jsonl alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "angel-t-"));
  const raw = [v(3, "A", "second half"), v(0, "A", "first half"), v(5, "B", "Mhmm.")].map(l => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), raw);
  fs.writeFileSync(path.join(dir, "transcript.md"), "# Old transcript, then\n\n[x] raw\n");
  assert.equal(tidyFolder(dir).lines, 3);
  assert.equal(fs.readFileSync(path.join(dir, "transcript.md"), "utf8").split("\n").at(-2), "[19:00:00] A: first half second half");
  assert.ok(fs.readFileSync(path.join(dir, "transcript.md"), "utf8").startsWith("# Old transcript, then"));
  assert.equal(fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8"), raw);
});

test("(tr-11) tidy runs fast on a long session (it runs as the session ends)", () => {
  const many = Array.from({ length: 20000 }, (_, i) => v(i * 2, i % 3 ? "A" : "B", i % 4 ? "word ".repeat(40) : "Mhmm."));
  const start = performance.now();
  tidy(many);
  assert.ok(performance.now() - start < 1500);
});
