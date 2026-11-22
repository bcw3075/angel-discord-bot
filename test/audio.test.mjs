import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecoder, decodePackets, stereoToMono, resample48to16, levelDb, encodeWav, packetsToWav } from "../src/audio.mjs";
import { tonePackets } from "./helpers.mjs";

const crossings = s => { let n = 0; for (let i = 1; i < s.length; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++; return n; };

test("a second of speech-loud tone becomes a mono 16 kHz WAV of the right length and level", () => {
  const d = createDecoder();
  const r = packetsToWav(d, tonePackets(1), { minUtteranceMs: 400, minLevelDb: -50 });
  d.delete();
  assert.ok(r.wav, "a WAV is made");
  assert.equal(r.wav.toString("latin1", 0, 4), "RIFF");
  assert.equal(r.wav.toString("latin1", 8, 12), "WAVE");
  assert.equal(r.wav.readUInt16LE(22), 1, "mono");
  assert.equal(r.wav.readUInt32LE(24), 16000, "16 kHz");
  const samples = (r.wav.length - 44) / 2;
  assert.ok(Math.abs(samples - 16000) < 400, `about one second of samples (${samples})`);
  assert.ok(r.levelDb > -15 && r.levelDb < -5, `a half-scale sine is about -9 dB (${r.levelDb.toFixed(1)})`);
  assert.equal(r.durationMs, 1000);
});

test("too short and too quiet pieces are skipped, with the reason", () => {
  const d = createDecoder();
  assert.equal(packetsToWav(d, tonePackets(0.2), {}).reason, "short");
  assert.equal(packetsToWav(d, tonePackets(1, { amp: 0 }), {}).reason, "quiet");
  d.delete();
});

test("the resampler keeps speech frequencies and removes what would alias", () => {
  const d = createDecoder();
  const mono = stereoToMono(decodePackets(d, tonePackets(1, { freq: 440 })).pcm);
  const out = resample48to16(mono);
  /* 440 Hz → about 880 zero crossings a second at any sample rate */
  assert.ok(Math.abs(crossings(out.subarray(1600)) - 880 * 0.9) < 60, `440 Hz kept (${crossings(out.subarray(1600))})`);
  const hi = new Float32Array(48000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 10000 * i) / 48000));
  assert.ok(levelDb(resample48to16(hi)) < levelDb(hi) - 30, "a 10 kHz tone (above the 8 kHz limit) is cut by more than 30 dB");
  d.delete();
});

test("a packet the decoder rejects becomes silence and is counted, so timing holds", () => {
  const d = createDecoder();
  const good = tonePackets(0.1);
  const { pcm, bad } = decodePackets(d, [good[0], Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]), good[1]]);
  d.delete();
  assert.equal(bad, 1);
  assert.equal(pcm.length, 3 * 960 * 2);
});

test("WAV encoding clips out-of-range samples and writes the header sizes", () => {
  const wav = encodeWav(new Float32Array([2, -2, 0]));
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(44), 32767);
  assert.equal(wav.readInt16LE(46), -32768);
  assert.equal(levelDb(new Float32Array(10)), -Infinity);
});

test("an Opus frame longer than 20 ms decodes whole instead of losing the piece", async () => {
  const fs = await import("node:fs");
  const { oggPackets } = await import("../src/tts.mjs");
  /* half a second at 40 ms a frame, made with ffmpeg's libopus (-frame_duration 40) */
  const forty = oggPackets(fs.readFileSync(new URL("./fixtures/tone-40ms.ogg", import.meta.url))).slice(2);
  const d = createDecoder();
  const { pcm, bad } = decodePackets(d, [...forty, ...tonePackets(0.04)]);
  d.delete();
  assert.equal(bad, 0);
  assert.equal(pcm.length, (forty.length * 1920 + 2 * 960) * 2, "each 40 ms frame and the two 20 ms frames, whole");
});

test("(vo-8) many speakers at once: each decoder has its own memory, so the third speaker doesn't break everyone (2026-11-22)", () => {
  /* opusscript's own wrapper, as used before: with three decoders alive every decode of every speaker failed with
     "memory access out of bounds" until a restart. Each speaker speaks in turn, three rounds, as speakers join. */
  const tone = tonePackets(1), decoders = [];
  for (let n = 1; n <= 8; n++) {
    decoders.push(createDecoder());
    for (let round = 0; round < 2; round++) {
      for (const [k, d] of decoders.entries()) {
        const r = packetsToWav(d, tone, {});
        assert.ok(r.wav, `speaker ${k + 1} of ${n} is heard`);
        assert.equal(r.badPackets, 0, `speaker ${k + 1} of ${n}: no packet rejected`);
        assert.ok(r.levelDb > -15 && r.levelDb < -5, `speaker ${k + 1} of ${n}: the tone at its level (${r.levelDb.toFixed(1)})`);
      }
    }
  }
  for (const d of decoders) d.delete();
});

test("(vo-8) thousands of garbage packets into one decoder: each is rejected or decoded as noise, and that decoder and its neighbour still decode real sound after", () => {
  const a = createDecoder(), b = createDecoder(), tone = tonePackets(1);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    const g = Buffer.alloc(1 + Math.floor(rnd() * (i % 40 === 0 ? 5000 : 300)));
    for (let j = 0; j < g.length; j++) g[j] = Math.floor(rnd() * 256);
    try { const out = a.decode(g); assert.ok(out instanceof Int16Array && out.length <= 5760 * 2); } catch (e) { assert.ok(e instanceof Error); }
  }
  assert.throws(() => a.decode(Buffer.alloc(0)), /not an Opus packet/);
  assert.throws(() => a.decode(Buffer.alloc(4000)), /not an Opus packet/, "a packet longer than Opus allows never reaches the decoder's memory");
  assert.equal(decodePackets(a, tone).bad, 0, "the decoder that got the garbage");
  assert.equal(decodePackets(b, tone).bad, 0, "its neighbour");
  a.delete(); b.delete();
  assert.throws(() => a.decode(tone[0]), /closed/);
});

test("(vo-8) the decoder's sound is the same as the library's own wrapper gives for the same packets", async () => {
  const { default: OpusScript } = await import("opusscript");
  const theirs = new OpusScript(48000, 2, OpusScript.Application.AUDIO), ours = createDecoder();
  for (const p of tonePackets(0.2, { freq: 330 })) {
    const a = theirs.decode(p), b = ours.decode(p);
    assert.equal(b.length, 1920);
    assert.deepEqual([...b], Array.from({ length: 1920 }, (_, i) => a.readInt16LE(i * 2)));
  }
  theirs.delete(); ours.delete();
});
