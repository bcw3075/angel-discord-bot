/* Audio helpers: Discord's Opus packets (48 kHz stereo, 20 ms each) → mono 16 kHz WAV for the transcriber.
   opusscript is WebAssembly, so nothing needs compiling on Windows. */
import OpusScript from "opusscript";

export const RATE_IN = 48000;
export const RATE_OUT = 16000;
export const FRAME = 960; /* samples per channel in one 20 ms packet at 48 kHz */

export function createDecoder() {
  return new OpusScript(RATE_IN, 2, OpusScript.Application.AUDIO);
}

/* Decode packets into one interleaved stereo Int16 buffer. A packet the decoder rejects becomes 20 ms of silence, so timing holds. */
export function decodePackets(decoder, packets) {
  const out = new Int16Array(packets.length * FRAME * 2);
  let at = 0, bad = 0;
  for (const p of packets) {
    let pcm = null;
    try { pcm = decoder.decode(p); } catch { pcm = null; }
    if (!pcm || pcm.length === 0) { bad++; at += FRAME * 2; continue; }
    const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
    out.set(s.subarray(0, Math.min(s.length, out.length - at)), at);
    at += s.length;
  }
  return { pcm: out.subarray(0, Math.min(at, out.length)), bad };
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
  if (db < minLevelDb) return { wav: null, durationMs, levelDb: db, reason: "quiet" };
  return { wav: encodeWav(mono), durationMs, levelDb: db, badPackets: bad };
}
