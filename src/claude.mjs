/* The Claude Messages API, through plain fetch (no SDK). Retries what is worth retrying (rate limits, overload,
   server errors) and keeps a running tally of what each call cost. `stream` is the same call read as it is written. */

export const API = "https://api.anthropic.com/v1/messages";

export class Claude {
  constructor({ apiKey, prices, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.apiKey = apiKey;
    this.prices = prices;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.spent = 0;
    this.calls = 0;
  }

  /* usage.cache_creation splits cache writes into 5-minute and 1-hour ones, which cost different amounts; without
     the split, every write is priced at the dearer rate, so the spending caps never undercount */
  cost(model, usage = {}) {
    /* a model with no price (a newer one she typed in) counts at the dearest known price, so the caps still work */
    const p = this.prices[model] ?? Object.values(this.prices).reduce((a, b) => (b[3] > (a?.[3] ?? -1) ? b : a), null);
    if (!p) return 0;
    const hourWrite = p[4] ?? p[0] * 2;
    const split = usage.cache_creation;
    const writes = split && typeof split === "object"
      ? (split.ephemeral_5m_input_tokens ?? 0) * p[1] + (split.ephemeral_1h_input_tokens ?? 0) * hourWrite
      : (usage.cache_creation_input_tokens ?? 0) * Math.max(p[1], hourWrite);
    return ((usage.input_tokens ?? 0) * p[0] + writes
      + (usage.cache_read_input_tokens ?? 0) * p[2] + (usage.output_tokens ?? 0) * p[3]) / 1e6;
  }

  /* maxWaitMs caps the wait before another try (a server can ask for up to 20 s), for a call the table is waiting on */
  async create(body, { timeoutMs = 45000, retries = 2, maxWaitMs = 20000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res, text;
      try {
        res = await this.fetch(API, {
          method: "POST",
          headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        /* a timed-out call is not sent again: it may still have run (and been billed), and the table is waiting */
        if (e?.name === "TimeoutError") throw new Error(`Claude took longer than ${Math.round(timeoutMs / 1000)} s`);
        if (attempt < retries) { await this.sleep(Math.min(1500 * (attempt + 1), maxWaitMs)); continue; }
        throw new Error(`Claude could not be reached: ${e.message}`);
      }
      if (res.ok) {
        const json = JSON.parse(text);
        this.calls++;
        this.spent += this.cost(body.model, json.usage);
        return json;
      }
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (retryable && attempt < retries) {
        const after = Number(res.headers?.get?.("retry-after"));
        await this.sleep(Math.min(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 2000 * (attempt + 1), maxWaitMs));
        continue;
      }
      let message = text.slice(0, 300);
      try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* keep the raw text */ }
      throw new Error(`Claude answered ${res.status}: ${message}`);
    }
  }

  /* The same call, read as Claude writes it (server-sent events). Gives back the finished message in the shape
     `create` gives, and calls onDelta({ index, block, delta }) for each piece of text or tool input on the way.
     Sent again only while nothing has been written yet (the listener may already be speaking what it was given).
     A reply that breaks off throws with `usage` set to what is known of it, so its cost can still be counted. */
  async stream(body, { onDelta = () => {}, timeoutMs = 45000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(API, {
          method: "POST",
          headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ ...body, stream: true }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e?.name === "TimeoutError") throw new Error(`Claude took longer than ${Math.round(timeoutMs / 1000)} s`);
        if (attempt < retries) { await this.sleep(1500 * (attempt + 1)); continue; }
        throw new Error(`Claude could not be reached: ${e.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < retries) {
          const after = Number(res.headers?.get?.("retry-after"));
          await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 2000 * (attempt + 1));
          continue;
        }
        let message = text.slice(0, 300);
        try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* keep the raw text */ }
        throw new Error(`Claude answered ${res.status}: ${message}`);
      }
      const msg = { content: [], usage: {} };
      const raw = new Map(); /* content index → the tool input's JSON so far */
      let started = false, finished = false, counted = false;
      const onEvent = ev => {
        if (ev.type === "message_start") Object.assign(msg, ev.message, { content: [], usage: { ...ev.message?.usage } });
        else if (ev.type === "content_block_start") {
          started = true;
          msg.content[ev.index] = { ...ev.content_block };
          if (ev.content_block?.type === "tool_use") raw.set(ev.index, "");
        } else if (ev.type === "content_block_delta") {
          const block = msg.content[ev.index];
          if (!block) return;
          if (ev.delta?.type === "text_delta") block.text = (block.text ?? "") + ev.delta.text;
          else if (ev.delta?.type === "input_json_delta") raw.set(ev.index, (raw.get(ev.index) ?? "") + ev.delta.partial_json);
          /* her thinking and its signature must be kept whole: the block goes back to Claude with the lookups'
             results, and one sent back empty is refused (live 2026-11-14: "each thinking block must contain thinking") */
          else if (ev.delta?.type === "thinking_delta") { block.thinking = (block.thinking ?? "") + ev.delta.thinking; return; }
          else if (ev.delta?.type === "signature_delta") { block.signature = (block.signature ?? "") + ev.delta.signature; return; }
          else return;
          try { onDelta({ index: ev.index, block, delta: ev.delta }); } catch { /* a listener's trouble is not the call's */ }
        } else if (ev.type === "content_block_stop") {
          const block = msg.content[ev.index];
          if (block?.type !== "tool_use") return;
          /* a tool input streamed as written isn't checked by the API: it can be cut short or not be JSON */
          const text = raw.get(ev.index) ?? "";
          try { block.input = text.trim() ? JSON.parse(text) : {}; }
          catch { block.input = {}; (msg.brokenInputs ??= []).push(ev.index); }
        } else if (ev.type === "message_delta") {
          Object.assign(msg, ev.delta);
          counted = true;
          for (const [k, v] of Object.entries(ev.usage ?? {})) if (v != null) msg.usage[k] = v;
        } else if (ev.type === "message_stop") finished = true;
        else if (ev.type === "error") {
          const e = new Error(`Claude's reply broke off: ${ev.error?.message ?? ev.error?.type ?? "unknown error"}`);
          e.overloaded = ev.error?.type === "overloaded_error" || ev.error?.type === "api_error";
          throw e;
        }
      };
      try {
        await readEvents(res.body, onEvent);
        if (!finished) throw new Error("Claude's reply broke off before it was finished");
      } catch (e) {
        if (e.overloaded && !started && attempt < retries) { await this.sleep(2000 * (attempt + 1)); continue; }
        const err = e?.name === "TimeoutError" ? new Error(`Claude took longer than ${Math.round(timeoutMs / 1000)} s`)
          : /^Claude/.test(e.message) ? e : new Error(`Claude's reply broke off: ${e.message}`);
        /* what was sent was read (and billed) even though the reply never finished; the count of what she wrote only
           comes at the end (the start carries a placeholder of 1 or so), so without it the count is put at a token
           for every three characters that arrived */
        if (!counted) {
          let chars = 0;
          for (const b of msg.content) chars += b?.text?.length ?? 0;
          for (const t of raw.values()) chars += t.length;
          msg.usage.output_tokens = Math.max(msg.usage.output_tokens ?? 0, Math.ceil(chars / 3));
        }
        err.usage = msg.usage;
        this.calls++;
        this.spent += this.cost(body.model, msg.usage);
        throw err;
      }
      msg.content = msg.content.filter(Boolean);
      this.calls++;
      this.spent += this.cost(body.model, msg.usage);
      return msg;
    }
  }
}

/* Server-sent events from a response body (anything that can be read with for await, in bytes or text): each
   event's `data:` line is JSON. Events can be split anywhere between the pieces that arrive. */
export async function readEvents(body, onEvent) {
  const decoder = new TextDecoder();
  let buf = "";
  const drain = last => {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      const cut = m ? m.index : last && buf.trim() ? buf.length : -1;
      if (cut < 0) return;
      const event = buf.slice(0, cut);
      buf = buf.slice(m ? cut + m[0].length : cut);
      const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      onEvent(json);
    }
  };
  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    drain(false);
  }
  buf += decoder.decode();
  drain(true);
}

/* Reads one top-level string field out of a JSON object while the JSON is still being written: feed it the pieces as
   they come, and each call gives back the new characters of that field's value (escapes undone). Used for the answer
   tool's `say`, so Angel can start speaking before the rest of the answer exists. Plain character steps, no regex. */
export class FieldReader {
  constructor(key) {
    this.key = key;
    this.text = "";       /* the field's value so far */
    this.done = false;    /* its closing quote has been seen */
    this.depth = 0;
    this.inString = false;
    this.isValue = false; /* the string being read follows a colon */
    this.afterColon = false;
    this.capturing = false;
    this.escape = false;
    this.unicode = null;  /* hex digits of a \uXXXX being read */
    this.name = "";       /* the key string being read at the top level */
    this.lastKey = null;
  }

  feed(piece) {
    let out = "";
    for (const c of String(piece)) {
      if (!this.inString) {
        if (c === "{" || c === "[") { this.depth++; this.afterColon = false; }
        else if (c === "}" || c === "]") { this.depth--; this.afterColon = false; }
        else if (c === ":") this.afterColon = true;
        else if (c === ",") this.afterColon = false;
        else if (c === '"') {
          this.inString = true;
          this.isValue = this.afterColon;
          this.afterColon = false;
          this.name = "";
          this.capturing = !this.done && this.isValue && this.depth === 1 && this.lastKey === this.key;
        }
        continue;
      }
      let ch = null;
      if (this.unicode !== null) {
        this.unicode += c;
        if (this.unicode.length < 4) continue;
        const code = parseInt(this.unicode, 16);
        this.unicode = null;
        ch = Number.isNaN(code) ? "" : String.fromCharCode(code);
      } else if (this.escape) {
        this.escape = false;
        if (c === "u") { this.unicode = ""; continue; }
        ch = c === "n" || c === "r" || c === "t" ? " " : c === "b" || c === "f" ? "" : c;
      } else if (c === "\\") { this.escape = true; continue; }
      else if (c === '"') {
        this.inString = false;
        if (this.capturing) { this.capturing = false; this.done = true; }
        else if (!this.isValue && this.depth === 1) this.lastKey = this.name;
        continue;
      } else ch = c;
      if (this.capturing) out += ch;
      else if (!this.isValue && this.depth === 1 && this.name.length < 64) this.name += ch;
    }
    this.text += out;
    return out;
  }
}
