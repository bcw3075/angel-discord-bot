import { test } from "node:test";
import assert from "node:assert/strict";
import { gather } from "../src/capture.mjs";
import { FakeStream } from "./helpers.mjs";

const pk = n => Array.from({ length: n }, (_, i) => Buffer.from([i]));

test("a piece of speech is handed on when the speaker pauses", () => {
  const s = new FakeStream(), segs = [];
  let closed = 0;
  gather(s, { maxPackets: 100, onSegment: x => segs.push(x), onClosed: () => closed++ });
  s.feed(pk(10)); s.end();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].packets.length, 10);
  assert.equal(segs[0].final, true);
  assert.equal(closed, 1, "closed reported once though end and close both fired");
});

test("a monologue is cut every maxPackets so the transcript keeps up", () => {
  const s = new FakeStream(), segs = [];
  gather(s, { maxPackets: 4, onSegment: x => segs.push(x) });
  s.feed(pk(10)); s.end();
  assert.deepEqual(segs.map(x => [x.packets.length, x.final]), [[4, false], [4, false], [2, true]]);
});

test("a broken stream keeps what was heard and reports the break once", () => {
  const s = new FakeStream(), segs = [], broken = [];
  gather(s, { maxPackets: 100, onSegment: x => segs.push(x), onBroken: e => broken.push(e.message) });
  s.feed(pk(3));
  s.fail(new Error("Failed to parse packet"));
  s.emit("error", new Error("second error must not crash"));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].packets.length, 3);
  assert.deepEqual(broken, ["Failed to parse packet"]);
});

test("stop drops what's gathered and destroys the stream", () => {
  const s = new FakeStream(), segs = [];
  const g = gather(s, { maxPackets: 100, onSegment: x => segs.push(x) });
  s.feed(pk(3));
  g.stop();
  s.feed(pk(3)); s.end();
  assert.equal(segs.length, 0);
  assert.equal(s.destroyed, true);
});

test("nothing heard, nothing handed on", () => {
  const s = new FakeStream(), segs = [];
  gather(s, { maxPackets: 100, onSegment: x => segs.push(x) });
  s.end();
  assert.equal(segs.length, 0);
});
