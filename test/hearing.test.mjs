import { test } from "node:test";
import assert from "node:assert/strict";
import { HearingWatch } from "../src/hearing.mjs";

function watch(opts = {}) {
  const clock = { t: 1_000_000 }, calls = [];
  const w = new HearingWatch({ now: () => clock.t, ...opts,
    onTrouble: t => calls.push(["trouble", t]), onStill: t => calls.push(["still", t]), onBack: t => calls.push(["back", t]) });
  return { w, clock, calls, kinds: () => calls.map(c => `${c[0]}:${c[1].kind}`) };
}

test("(hr-1) three lost pieces in a row are trouble, told once, from the first of them; one good piece between starts the count over", () => {
  const { w, clock, calls, kinds } = watch();
  w.bad("decode"); w.bad("decode"); w.ok(); /* two, then one that worked */
  clock.t += 5000; w.bad("decode", "x"); clock.t += 1000; w.bad("decode", "x");
  assert.deepEqual(calls, [], "two in a row is a hiccup");
  clock.t += 1000; w.bad("decode", "memory access out of bounds");
  assert.deepEqual(kinds(), ["trouble:decode"]);
  assert.equal(calls[0][1].since, 1_005_000, "since the first lost piece of the run");
  assert.equal(calls[0][1].detail, "memory access out of bounds");
  for (let i = 0; i < 50; i++) w.bad("decode");
  assert.equal(calls.length, 1, "said once, however many more are lost");
});

test("(hr-2) while it lasts she says so again after 2 minutes, then every 10, and no more than six times in all", () => {
  const { w, clock, calls, kinds } = watch();
  for (let i = 0; i < 3; i++) w.bad("transcriber", "timeout");
  clock.t += 119_000; w.tick();
  assert.equal(calls.length, 1, "not yet");
  clock.t += 2000; w.tick();
  assert.deepEqual(kinds(), ["trouble:transcriber", "still:transcriber"]);
  assert.equal(calls[1][1].minutes, 2);
  clock.t += 300_000; w.tick();
  assert.equal(calls.length, 2, "ten minutes between the later ones");
  for (let i = 0; i < 20; i++) { clock.t += 600_000; w.tick(); }
  assert.equal(calls.length, 6, "six messages for one trouble at most");
});

test("(hr-3) a piece that works ends decode and transcriber trouble, with from and until; the next trouble is told afresh", () => {
  const { w, clock, calls, kinds } = watch();
  for (let i = 0; i < 3; i++) w.bad("decode");
  clock.t += 40_000; w.ok();
  assert.deepEqual(kinds(), ["trouble:decode", "back:decode"]);
  assert.deepEqual([calls[1][1].since, calls[1][1].until], [1_000_000, 1_040_000]);
  clock.t += 600_000; w.tick();
  assert.equal(calls.length, 2, "nothing more once she is back");
  for (let i = 0; i < 3; i++) w.bad("decode");
  assert.equal(kinds().at(-1), "trouble:decode");
});

test("(hr-4) the net: a minute of talk and no word for three minutes is trouble, whatever the cause; only words end it", () => {
  const { w, clock, calls, kinds } = watch();
  w.talking("a", true, clock.t); clock.t += 30_000; w.talking("a", false, clock.t);
  w.talking("b", true, clock.t); clock.t += 29_000; w.talking("b", false, clock.t);
  clock.t += 200_000; w.tick();
  assert.deepEqual(calls, [], "59 s of talk is under the minute");
  w.talking("a", true, clock.t); clock.t += 2000; w.tick(); /* still talking: the talk under way counts */
  assert.deepEqual(kinds(), ["trouble:quiet"]);
  assert.equal(calls[0][1].since, 1_000_000, "since the last words (here: since she began)");
  w.ok(); /* a piece transcribed to nothing isn't words */
  assert.equal(calls.length, 1);
  clock.t += 5000; w.line();
  assert.deepEqual(kinds(), ["trouble:quiet", "back:quiet"]);
});

test("(hr-4) the net stays quiet at a quiet table, and when words keep coming", () => {
  const { w, clock, calls } = watch();
  clock.t += 3_600_000; w.tick();
  assert.deepEqual(calls, [], "an hour of nobody talking is not trouble");
  for (let i = 0; i < 30; i++) { w.talking("a", true, clock.t); clock.t += 50_000; w.talking("a", false, clock.t); w.line(); clock.t += 100_000; w.tick(); }
  assert.deepEqual(calls, [], "long talk with a line each time is fine");
  /* much talk right after words: under three minutes since them */
  w.line(); w.talking("a", true, clock.t); clock.t += 170_000; w.tick();
  assert.deepEqual(calls, []);
});

test("(hr-5) a rejoin starts the count of talk without words over, for talk under way too", () => {
  const { w, clock, calls } = watch();
  w.talking("a", true, clock.t); clock.t += 170_000;
  w.fresh();
  clock.t += 30_000; w.tick();
  assert.deepEqual(calls, [], "the talk before the rejoin isn't held against the new connection");
  clock.t += 150_000; w.tick();
  assert.equal(calls.length, 1, "three more minutes of it is");
});

test("(hr-1) each kind has its own run, and a piece that decodes (even too quiet to send) ends the decode run", () => {
  const { w, calls, kinds } = watch();
  w.bad("decode"); w.bad("decode"); w.bad("transcriber", "timeout");
  assert.deepEqual(calls, [], "two of one kind and one of the other are not three in a row");
  w.decoded(); w.bad("decode"); w.decoded(); w.bad("decode"); w.decoded(); w.bad("decode");
  assert.deepEqual(calls, [], "lost, decoded, lost, decoded: never three in a row");
  w.bad("transcriber", "timeout"); w.bad("transcriber", "timeout");
  assert.deepEqual(kinds(), ["trouble:transcriber"]);
  assert.equal(w.run("transcriber"), 3);
});

test("(hr-6) a callback that throws doesn't break the watch", () => {
  const w = new HearingWatch({ onTrouble: () => { throw new Error("boom"); } });
  for (let i = 0; i < 3; i++) w.bad("decode");
  assert.equal(w.trouble.kind, "decode");
});
