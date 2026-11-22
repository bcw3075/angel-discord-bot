/* Audio helpers: Discord's Opus packets (48 kHz stereo, 20 ms each) → mono 16 kHz WAV for the transcriber.
   The decoder is opusscript's WebAssembly build of libopus, so nothing needs compiling on Windows. */
import { createRequire } from "node:module";

export const RATE_IN = 48000;
export const RATE_OUT = 16000;
export const FRAME = 960; /* samples per channel in one 20 ms packet at 48 kHz */

const MAX_PACKET = 3828;   /* bytes: the longest Opus packet (three frames of 1276) */
const MAX_SAMPLES = 5760;  /* per channel: 120 ms, the longest an Opus packet can hold */
/* the build writes each byte of the 16-bit samples into a 16-bit slot of its own, so the room is twice the sound's */
const OUT_BYTES = MAX_SAMPLES * 2 * 2 * 2;
const OPUS_AUDIO = 2049;

const require = createRequire(import.meta.url);
let opusBuild = null;
/* opusscript's own WebAssembly build, without its wrapper (see createDecoder) */
function loadOpusBuild() {
  opusBuild ??= require("opusscript/build/opusscript_native_wasm.js");
  return opusBuild;
}

/* One speaker's decoder, in a WebAssembly memory of its own.

   opusscript 0.1.1's wrapper is not used: it keeps every decoder in one shared memory and tells the decoder to write
   its sound at twice the address of the room it set aside, so the sound lands in whatever is there. With one or two
   decoders that is empty space; the third speaker's decoder sits exactly there, and from then on every decode of
   every speaker fails with "memory access out of bounds" until the program is restarted (the talk of 2026-11-22:
   8 lines in 85 minutes; and the "deaf" 13 minutes of 2026-11-21, a third speaker as well). Here each decoder gets
   its own copy of the build (a few milliseconds and little memory), the room is asked for at its real size and the decoder
   is given its real address, so one speaker's decoder can't touch another's and a fresh one really is fresh.
   `decode` returns the packet's sound as interleaved stereo Int16 samples, or throws. */
export function createDecoder({ build = loadOpusBuild() } = {}) {
  let m = build();
  let handler = new m.OpusScriptHandler(RATE_IN, 2, OPUS_AUDIO);
  const inPtr = m._malloc(MAX_PACKET), outPtr = m._malloc(OUT_BYTES);
  if (!inPtr || !outPtr || outPtr % 2) throw new Error("the sound decoder couldn't get its memory");
  return {
    decode(packet) {
      if (!m) throw new Error("the decoder was closed");
      if (!packet || !packet.length || packet.length > MAX_PACKET) throw new Error("not an Opus packet");
      m.HEAPU8.set(packet, inPtr);
      const frames = handler._decode(inPtr, packet.length, outPtr);
      if (frames < 0) throw new Error(`Opus decode error ${frames}`);
      if (frames > MAX_SAMPLES) throw new Error("the decoder gave more sound than a packet can hold");
      const n = frames * 2, out = new Int16Array(n), slots = m.HEAPU16;
      for (let i = 0, at = outPtr >> 1; i < n; i++, at += 2) out[i] = (slots[at] & 255) | ((slots[at + 1] & 255) << 8);
      return out;
    },
    /* its whole memory goes with it: nothing is freed piece by piece, so a decoder that broke can't break the freeing */
    delete() { m = null; handler = null; },
  };
}

/* Decode packets into one interleaved stereo Int16 buffer. A packet the decoder rejects becomes 20 ms of silence, so
   timing holds. Discord sends 20 ms frames, but longer frames (up to the 120 ms a packet can hold) come out whole. */
export function decodePackets(decoder, packets) {
  const parts = [];
  let total = 0, bad = 0;
  for (const p of packets) {
    let pcm = null;
    try { pcm = decoder.decode(p); } catch { pcm = null; }
    /* samples as they are, or a Buffer of them (the shape of before 0.2.0, which a stand-in may still give) */
    const s = !pcm || !pcm.length ? null
      : pcm instanceof Int16Array ? pcm
      : new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
    if (!s) bad++;
    const part = s ?? new Int16Array(FRAME * 2);
    parts.push(part);
    total += part.length;
  }
  const out = new Int16Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return { pcm: out, bad };
}

export function stereoToMono(int16) {
  const n = int16.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (int16[2 * i] + int16[2 * i + 1]) / 65536;
  return out;
}

/* Windowed-sinc low-pass (cut-off 7 kHz) then keep every third sample: 48 kHz → 16 kHz without aliasing. */
const TAPS = (() => {
  const n = 63, fc = 7000 / RATE_IN, mid = (n - 1) / 2, h = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    h[i] = sinc * hamming; sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
})();

export function resample48to16(mono) {
  const n = Math.floor(mono.length / 3), out = new Float32Array(n), mid = (TAPS.length - 1) >> 1;
  for (let o = 0; o < n; o++) {
    const c = o * 3;
    let acc = 0;
    for (let k = 0; k < TAPS.length; k++) {
      const j = c + k - mid;
      if (j >= 0 && j < mono.length) acc += TAPS[k] * mono[j];
    }
    out[o] = acc;
  }
  return out;
}

/* Loudness in dB below full scale (RMS). Silence is -Infinity. */
export function levelDb(samples) {
  if (!samples.length) return -Infinity;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
  return 10 * Math.log10(sq / samples.length || 0);
}

export function encodeWav(samples, rate = RATE_OUT) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/* One piece of speech → WAV, or null with the reason when it's too short or too quiet to be worth transcribing. */
export function packetsToWav(decoder, packets, { minUtteranceMs = 400, minLevelDb = -50 } = {}) {
  const durationMs = packets.length * 20;
  if (durationMs < minUtteranceMs) return { wav: null, durationMs, reason: "short" };
  const { pcm, bad } = decodePackets(decoder, packets);
  const mono = resample48to16(stereoToMono(pcm));
  const db = levelDb(mono);
  if (db < minLevelDb) return { wav: null, durationMs, levelDb: db, reason: "quiet", badPackets: bad };
  return { wav: encodeWav(mono), durationMs, levelDb: db, badPackets: bad };
}
