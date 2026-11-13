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
