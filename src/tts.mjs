/* Angel's voice: Deepgram text to speech. Asked for Opus in an Ogg file, which @discordjs/voice plays as it is
   (StreamType.OggOpus: no FFmpeg and no re-encoding). Deepgram takes at most 2,000 characters a request, so a long
   answer is sent in sentence-sized pieces that play one after another. */
import { DEEPGRAM, deepgramError } from "./stt.mjs";

export const TTS_MAX_CHARS = 1800;

export async function synthesize(text, { apiKey, voice, format = "ogg", fetchImpl = fetch, timeoutMs = 30000 }) {
  const params = new URLSearchParams({ model: voice });
  if (format === "ogg") { params.set("encoding", "opus"); params.set("container", "ogg"); }
  else if (format === "mp3") params.set("encoding", "mp3");
  else if (format === "wav") { params.set("encoding", "linear16"); params.set("container", "wav"); params.set("sample_rate", "16000"); }
  else throw new Error(`unknown voice format ${format}`);
  const res = await fetchImpl(`${DEEPGRAM}/v1/speak?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await deepgramError("speak", res);
  return Buffer.from(await res.arrayBuffer());
}

/* The Opus packets inside an Ogg file (header packets first: OpusHead, OpusTags). Used by `npm run check` and
   the tests to prove a voice clip is in the form @discordjs/voice plays; playback itself uses the library's reader. */
export function oggPackets(buf) {
  const packets = [];
  let at = 0, partial = [];
  while (at + 27 <= buf.length) {
    if (buf.toString("latin1", at, at + 4) !== "OggS") throw new Error(`not an Ogg page at byte ${at}`);
    const segments = buf[at + 26];
    const table = buf.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    for (const len of table) {
      partial.push(buf.subarray(body, body + len));
      body += len;
      if (len < 255) { packets.push(Buffer.concat(partial)); partial = []; }
    }
    at = body;
  }
  return packets;
}

/* Split text into pieces of at most max characters, at sentence ends where possible, then at commas, then at spaces. */
export function chunkText(text, max = TTS_MAX_CHARS) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [clean];
  const pieces = [];
  let cur = "";
  const push = s => { if (s.trim()) pieces.push(s.trim()); };
  for (let s of sentences) {
    while (s.length > max) {
      const cut = Math.max(s.lastIndexOf(", ", max), s.lastIndexOf(" ", max));
      const at = cut > max / 3 ? cut + 1 : max;
      if (cur) { push(cur); cur = ""; }
      push(s.slice(0, at)); s = s.slice(at);
    }
    if ((cur + s).length > max) { push(cur); cur = s; } else cur += s;
  }
  push(cur);
  return pieces;
}

/* every feminine Aura-2 English voice (Rhea asked for all of them, 2026-11-14; list from a third-party copy of
   Deepgram's catalogue, so `npm run voices` shows any that fail). One feminine voice is left out: its name is on the
   private word list (a campaign name), which no public file may hold. */
export const VOICES = ["amalthea", "andromeda", "asteria", "athena", "callista", "cora", "cordelia", "delia", "electra",
  "harmonia", "helena", "hera", "iris", "janus", "juno", "luna", "minerva", "ophelia", "pandora", "phoebe", "selene", "thalia",
  "theia", "vesta"].map(n => `aura-2-${n}-en`);

/* "luna", "Luna" or "aura-2-luna-en" → the model id; "" when it isn't one of VOICES */
export function voiceFromName(name) {
  const n = String(name ?? "").trim().toLowerCase().replace(/\.mp3$/, "");
  return VOICES.find(v => v === n || v === `aura-2-${n}-en`) ?? "";
}
