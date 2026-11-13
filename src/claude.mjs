/* The Claude Messages API, through plain fetch (no SDK). Retries what is worth retrying (rate limits, overload,
   server errors) and keeps a running tally of what each call cost. */

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

  cost(model, usage = {}) {
    const p = this.prices[model];
    if (!p) return 0;
    return ((usage.input_tokens ?? 0) * p[0] + (usage.cache_creation_input_tokens ?? 0) * p[1]
      + (usage.cache_read_input_tokens ?? 0) * p[2] + (usage.output_tokens ?? 0) * p[3]) / 1e6;
  }

  async create(body, { timeoutMs = 90000, retries = 2 } = {}) {
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
        if (attempt < retries) { await this.sleep(1500 * (attempt + 1)); continue; }
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
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 2000 * (attempt + 1));
        continue;
      }
      let message = text.slice(0, 300);
      try { message = JSON.parse(text)?.error?.message ?? message; } catch { /* keep the raw text */ }
      throw new Error(`Claude answered ${res.status}: ${message}`);
    }
  }
}
