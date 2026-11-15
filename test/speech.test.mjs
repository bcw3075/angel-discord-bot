import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { speakable, SentenceCutter } from "../src/speech.mjs";
import { chunkText, oggPackets, TTS_MAX_CHARS, synthesize } from "../src/tts.mjs";
import { transcribe } from "../src/stt.mjs";
import { scriptedFetch } from "./helpers.mjs";

test("the spoken copy drops links and markdown and says dice and modifiers aloud", () => {
  assert.equal(speakable("**Grapple** is an [Athletics](https://2e.aonprd.com/Skills.aspx?ID=36) check. See <https://2e.aonprd.com/x>"), "Grapple is an Athletics check. See");
  assert.equal(speakable("Roll 2d6 and add +2; take a -1 penalty, e.g. when prone."), "Roll 2 d 6 and add plus 2; take a minus 1 penalty, for example when prone.");
  assert.equal(speakable("- one\n- two"), "one two");
  assert.equal(speakable("levels 5-10, once/day"), "levels 5-10, once/day", "ranges and slashes are left alone");
});

test("long answers are split for the voice at sentence ends, never over the limit", () => {
  const s = "This is a sentence about grappling rules. ".repeat(80);
  const pieces = chunkText(s, 300);
  assert.ok(pieces.length > 5);
  assert.ok(pieces.every(p => p.length <= 300), "all pieces within the limit");
  assert.ok(pieces.every(p => /\.$/.test(p)), "each ends at a sentence end");
  assert.equal(pieces.join(" ").replace(/\s+/g, " "), s.trim().replace(/\s+/g, " "), "nothing lost");
  const giant = "word ".repeat(1000);
  assert.ok(chunkText(giant, 200).every(p => p.length <= 200), "a sentence with no full stop is cut at spaces");
  assert.deepEqual(chunkText("   "), []);
  assert.deepEqual(chunkText("Short."), ["Short."]);
  assert.equal(TTS_MAX_CHARS < 2000, true, "under Deepgram's 2,000-character limit");
});

test("an Ogg Opus clip is read into its header and audio packets", () => {
  const p = oggPackets(fs.readFileSync(new URL("./fixtures/tone.ogg", import.meta.url)));
  assert.equal(p[0].toString("latin1", 0, 8), "OpusHead");
  assert.equal(p[1].toString("latin1", 0, 8), "OpusTags");
  assert.ok(p.length > 90, `about 100 audio packets in 2 s (${p.length - 2})`);
  assert.throws(() => oggPackets(Buffer.from("not ogg at all, definitely not an ogg page")), /not an Ogg page/);
});

test("the voice request asks Deepgram for Ogg Opus with the chosen voice", async () => {
  const f = scriptedFetch([{ bytes: Buffer.from("OggS...") }, { status: 401, body: "Invalid credentials" }]);
  const out = await synthesize("Hello there.", { apiKey: "dg", voice: "aura-2-luna-en", fetchImpl: f });
  assert.equal(out.toString(), "OggS...");
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/v1/speak");
  assert.equal(u.searchParams.get("model"), "aura-2-luna-en");
  assert.equal(u.searchParams.get("encoding"), "opus");
  assert.equal(u.searchParams.get("container"), "ogg");
  assert.equal(f.calls[0].init.headers.Authorization, "Token dg");
  assert.deepEqual(JSON.parse(f.calls[0].body), { text: "Hello there." });
  await assert.rejects(synthesize("x", { apiKey: "dg", voice: "v", fetchImpl: f }), /401/);
});

test("listening sends the WAV with the key terms and reads the transcript", async () => {
  const f = scriptedFetch([{ body: { metadata: { duration: 2.5 }, results: { channels: [{ alternatives: [{ transcript: " Angel, can I grapple? ", confidence: 0.93 }] }] } } }]);
  const r = await transcribe(Buffer.from("RIFF"), { apiKey: "dg", keyterms: ["Angel", "Brightwater"], fetchImpl: f });
  assert.deepEqual(r, { text: "Angel, can I grapple?", confidence: 0.93, seconds: 2.5 });
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, "/v1/listen");
  assert.equal(u.searchParams.get("model"), "nova-3");
  assert.deepEqual(u.searchParams.getAll("keyterm"), ["Angel", "Brightwater"]);
  assert.equal(f.calls[0].init.headers["Content-Type"], "audio/wav");
});

test("sentences are cut off as they are written, whatever the size of the pieces", () => {
  const text = "Yes. Grabbed makes you off-guard and immobilized, e.g. you can't Stride. A DC 5 flat check, or 2.5 times that? No! \"Ask the GM.\" Then the last bit";
  const want = ["Yes. Grabbed makes you off-guard and immobilized, e.g. you can't Stride.", "A DC 5 flat check, or 2.5 times that?", "No! \"Ask the GM.\"", "Then the last bit"];
  for (const size of [1, 3, 8, 50, 1000]) {
    const c = new SentenceCutter();
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(...c.push(text.slice(i, i + size)));
    const rest = c.flush();
    assert.deepEqual([...out, rest], want, `pieces of ${size}`);
    assert.equal(c.flush(), "", "nothing is given twice");
  }
  const c = new SentenceCutter();
  assert.deepEqual(c.push("It's a plus 2 circumstance bonus."), [], "a sentence isn't given until what follows it has begun (it could be 2.5)");
  assert.deepEqual(c.push(" And"), ["It's a plus 2 circumstance bonus."]);
  assert.equal(c.flush(), "And");
  const t0 = performance.now();
  const big = new SentenceCutter();
  for (let i = 0; i < 3000; i++) big.push("no end here... 2.5.5!?x ");
  big.push("?".repeat(50000));
  for (let i = 0; i < 30000; i++) big.push("?");
  assert.ok(performance.now() - t0 < 1000, "plain steps: long odd text is still quick, also a long run of end marks coming one at a time");
  const marks = new SentenceCutter();
  const got = [];
  for (const ch of "Is that really so?!?!\" Yes it is.") got.push(...marks.push(ch));
  assert.deepEqual([...got, marks.flush()], ["Is that really so?!?!\"", "Yes it is."], "a run of end marks coming one at a time is still one end");
});
