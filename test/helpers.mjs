/* Shared test helpers: real Opus packets (made with the same encoder library), stand-ins for streams and fetch. */
import { EventEmitter } from "node:events";
import OpusScript from "opusscript";

/* Opus packets of a stereo sine tone (or silence when amp is 0), 20 ms each, as Discord would send them.
   Each tone is made once and copied after that, and its encoder deleted: opusscript's wrapper breaks once three of
   its encoders or decoders are alive at once (docs/features/voice.md). */
const toneCache = new Map();
export function tonePackets(seconds, { freq = 440, amp = 0.5 } = {}) {
  const key = `${seconds}|${freq}|${amp}`;
  if (!toneCache.has(key)) toneCache.set(key, makeTone(seconds, freq, amp));
  return toneCache.get(key).map(b => Buffer.from(b));
}

function makeTone(seconds, freq, amp) {
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
      /* `events` makes it a streamed reply (server-sent events), cut into pieces of `pieceSize` characters */
      body: r.events ? sseBody(r.events, r) : undefined,
      ok: status >= 200 && status < 300, status,
      headers: { get: k => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => text, json: async () => JSON.parse(text),
      arrayBuffer: async () => (r.bytes ? r.bytes : Buffer.from(text)),
    };
  };
  fn.calls = calls;
  return fn;
}

/* A streamed reply's body: the events as server-sent events, arriving in pieces cut anywhere (bytes, as fetch gives
   them). `breakAfter` ends the body with an error after that many pieces; `gapMs` waits between pieces. */
export function sseBody(events, { pieceSize = 37, breakAfter = Infinity, gapMs = 0, crlf = false, breakWith = null, given = null } = {}) {
  const nl = crlf ? "\r\n" : "\n";
  const text = events.map(e => `event: ${e.type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`).join("");
  const bytes = Buffer.from(text);
  return (async function* () {
    let n = 0;
    for (let i = 0; i < bytes.length; i += pieceSize) {
      if (n++ >= breakAfter) throw breakWith ?? new Error("socket hang up");
      if (gapMs) await sleep(gapMs);
      if (given) given.left = bytes.length - i - pieceSize; /* how much of the reply is still to come after this piece */
      yield bytes.subarray(i, i + pieceSize);
    }
  })();
}

/* The events of one streamed reply holding these content blocks (text, or tool_use with its input written in pieces
   of `jsonPiece` characters, or as the exact string `rawInput`). */
export function streamEvents(blocks, { usage = { input_tokens: 10 }, outputTokens = 5, jsonPiece = 9, stop = "tool_use" } = {}) {
  /* the real start event already has output_tokens, a placeholder of 1; the true count comes with message_delta */
  const ev = [{ type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { ...usage, output_tokens: 1 } } }, { type: "ping" }];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (let i = 0; i < b.thinking.length; i += 11) ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking.slice(i, i + 11) } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "redacted_thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "redacted_thinking", data: b.data } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = b.rawInput ?? JSON.stringify(b.input);
      for (let i = 0; i < json.length; i += jsonPiece) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + jsonPiece) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outputTokens } }, { type: "message_stop" });
  return ev;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
