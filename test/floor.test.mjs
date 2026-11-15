/* The floor: who is talking, from the speaking signal, with a hand-moved clock. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Floor } from "../src/floor.mjs";
import { sleep } from "./helpers.mjs";

function clocked(opts = {}) {
  let t = 1_000_000;
  const own = [];
  const f = new Floor({ now: () => t, blipMs: 500, mergeMs: 400, echoTailMs: 500, ownSpeech: () => own, pollMs: 5, ...opts });
  return { f, own, at: () => t, step: ms => { t += ms; } };
}

test("someone talking past a blip makes the table busy; a cough doesn't", () => {
  const { f, step } = clocked();
  assert.equal(f.busy(), false);
  f.talk("a", true); step(300);
  assert.equal(f.busy(), false, "300 ms so far: could be a cough");
  step(300);
  assert.equal(f.busy(), true, "600 ms: talking");
  f.talk("a", false); step(100);
  assert.equal(f.busy(), true, "a short pause between words is still talking");
  step(400);
  assert.equal(f.busy(), false, "a real pause: not busy");
  f.talk("b", true); step(200); f.talk("b", false); step(500);
  assert.equal(f.busy(), false, "a cough after it doesn't count");
  assert.ok(f.quietFor() >= 900, "and the quiet runs on through the cough");
});

test("a pause between one speaker's words joins the same stretch; quiet is measured from the last real talk", () => {
  const { f, step } = clocked();
  f.talk("a", true); step(400); f.talk("a", false); step(200); f.talk("a", true); step(300);
  assert.equal(f.busy(), true, "two parts joined make 900 ms of talk");
  assert.equal(f.quietFor(), 0, "talking now: no quiet");
  f.talk("a", false); step(1000);
  assert.equal(f.quietFor(), 1000);
  assert.equal(f.quietFor(undefined, f.now() - 300), 300, "counted from `since` when that is later");
  f.talk("b", true); step(10);
  assert.equal(f.quietFor(), 0, "anyone starting to talk ends the quiet, even before it is a blip");
});

test("talk that began while Angel spoke counts only from the end of her speech plus the tail (her voice in a mic)", () => {
  const { f, own, at, step } = clocked();
  own.push([at(), null]);              // she is speaking
  f.talk("a", true); step(1500);       // a mic picks her up the whole time
  assert.equal(f.busy(), false, "her own voice coming back is not the table talking");
  own[0] = [own[0][0], at()];          // she stops
  step(300); f.talk("a", false); step(200);
  assert.equal(f.busy(), false, "the echo's tail, gone within the tail time");
  assert.ok(f.quietFor() > 0, "and it doesn't end the quiet");
  // someone who started over her and keeps going past the tail is talking
  own.push([at(), null]); f.talk("b", true); step(1000); own[1] = [own[1][0], at()];
  step(1100);
  assert.equal(f.busy(), true, "still talking 600 ms past the tail: counts");
});

test("waiting for quiet: resolves on a pause, times out, or is woken", async () => {
  let t = 0;
  const f = new Floor({ now: () => t, blipMs: 50, mergeMs: 20, pollMs: 2 });
  f.talk("a", true); t = 100;
  const w = f.waitForQuiet(40, { maxMs: 10_000 });
  await sleep(10);
  f.talk("a", false); t = 120;
  await sleep(10); t = 165;
  assert.equal(await w.promise, "quiet");
  f.talk("a", true); t = 300;
  const w2 = f.waitForQuiet(40, { maxMs: 50 });
  await sleep(10); t = 400;
  assert.equal(await w2.promise, "timeout", "still talking at the limit");
  const w3 = f.waitForQuiet(Infinity, { maxMs: 10_000 });
  await sleep(10); f.talk("a", false); t = 2000;
  await sleep(10);
  w3.wake("go");
  assert.equal(await w3.promise, "go", "Infinity waits for a wake only");
  w3.wake("again");
  assert.equal(await w3.promise, "go", "the first wake stands");
});

test("a stretch that never got its end stops counting after maxSpellMs, and the next start counts (review of 0.1.3)", () => {
  const { f, step } = clocked({ maxSpellMs: 10_000 });
  f.talk("a", true); step(5000);
  assert.equal(f.busy(), true);
  step(6000);
  assert.equal(f.busy(), false, "its end was lost: not busy for good");
  assert.ok(f.quietFor() >= 900);
  f.talk("a", true); step(600);
  assert.equal(f.busy(), true, "talking again counts");
});
