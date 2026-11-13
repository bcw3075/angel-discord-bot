/* Shared test helpers: real Opus packets (made with the same encoder library), stand-ins for streams and fetch. */
import { EventEmitter } from "node:events";
import OpusScript from "opusscript";

/* Opus packets of a stereo sine tone (or silence when amp is 0), 20 ms each, as Discord would send them. */
export function tonePackets(seconds, { freq = 440, amp = 0.5 } = {}) {
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const frames = Math.round(seconds * 50), out = [];
  let t = 0;
  for (let f = 0; f < frames; f++) {
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++, t++) {
      const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * t) / 48000));
      pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2);
    }
    out.push(Buffer.from(enc.encode(pcm, 960)));
  }
  enc.delete();
  return out;
}

/* A stand-in for @discordjs/voice's AudioReceiveStream: emits data, end, error, close. */
export class FakeStream extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  feed(packets) { for (const p of packets) this.emit("data", p); }
  end() { this.emit("end"); this.emit("close"); }
  fail(err) { this.emit("error", err); this.emit("close"); }
  destroy() { this.destroyed = true; }
}

/* fetch that answers from a list of handlers in order, recording each request */
export function scriptedFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === "string" ? init.body : init.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    const r = typeof next === "function" ? await next(url, init) : next;
    const status = r.status ?? 200;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: k => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => text, json: async () => JSON.parse(text),
      arrayBuffer: async () => (r.bytes ? r.bytes : Buffer.from(text)),
    };
  };
  fn.calls = calls;
  return fn;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
