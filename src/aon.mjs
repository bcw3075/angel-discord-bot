/* Archives of Nethys, through the public search index its own site uses (POST /aon/_search, anonymous, read-only).
   Every entry carries its full text and page address. Old (pre-Remaster) entries point to their replacement with
   `remaster_id`, so a search for "flat-footed" gives Off-Guard, noting the old name. Reprints are hidden with
   `exclude_from_search`. Results are cached, a named User-Agent is sent, and a question makes only a few requests. */
import fs from "node:fs";

export const AON_SEARCH = "https://elasticsearch.aonprd.com/aon/_search";
export const AON_SITE = "https://2e.aonprd.com";
const SOURCE_FIELDS = ["name", "category", "level", "url", "summary", "primary_source", "remaster_id", "legacy_id", "type", "rarity", "trait"];

export class Aon {
  constructor({ userAgent, fetchImpl = fetch, cacheFile = null, ttlMs = 7 * 86400000, maxEntries = 200, now = Date.now, maxTextChars = 8000, saveDelayMs = 3000 } = {}) {
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.cacheFile = cacheFile;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.maxTextChars = maxTextChars;
    this.saveDelayMs = saveDelayMs;
    this.saveTimer = null;
    this.cache = new Map();
    this.requests = 0;
    if (cacheFile && fs.existsSync(cacheFile)) {
      try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8")))) this.cache.set(k, v); }
      catch { /* a broken cache is just empty */ }
    }
  }

  async query(body) {
    const key = JSON.stringify(body);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.data;
    this.requests++;
    const res = await this.fetch(AON_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": this.userAgent },
      body: key,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Archives of Nethys answered ${res.status}`);
    const json = await res.json();
    /* full texts are cut before caching: some rules pages are long, and the cache file is rewritten as it grows */
    const data = (json?.hits?.hits ?? []).map(h => {
      const d = { _id: h._id, ...h._source };
      if (typeof d.text === "string" && d.text.length > this.maxTextChars + 200) { d.text = d.text.slice(0, this.maxTextChars + 200); d._cut = true; }
      return d;
    });
    this.cache.set(key, { at: this.now(), data });
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    this.save();
    return data;
  }

  /* written a few seconds after the last lookup, not at each one: a big write mid-answer could stutter her voice */
  save() {
    if (!this.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.cacheFile) return;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache))); } catch { /* cache only */ }
  }

  byIds(ids, fields = SOURCE_FIELDS) {
    return this.query({ size: ids.length, query: { ids: { values: ids } }, _source: fields });
  }

  /* Old entries swapped for their Remaster replacements, duplicates dropped, order kept. */
  async preferRemaster(docs, fields = SOURCE_FIELDS) {
    const want = [...new Set(docs.flatMap(d => (Array.isArray(d.remaster_id) && d.remaster_id.length ? [d.remaster_id[0]] : [])))];
    const repl = new Map((want.length ? await this.byIds(want, fields) : []).map(d => [d._id, d]));
    const out = [], seen = new Set();
    for (const d of docs) {
      const r = Array.isArray(d.remaster_id) && repl.get(d.remaster_id[0]);
      /* an old name is worth saying only when it's the same kind of entry renamed (Flat-Footed → Off-Guard),
         not when a class feature now lives inside a class page */
      const doc = r ? { ...r, oldName: r.name !== d.name && r.category === d.category ? d.name : undefined } : d;
      if (seen.has(doc._id)) continue;
      seen.add(doc._id);
      out.push(doc);
    }
    return out;
  }

  async search(query, { category = null, limit = 6 } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    const body = {
      size: limit + 4,
      query: {
        bool: {
          should: [
            { match_phrase: { name: { query: q, boost: 12 } } },
            { match: { name: { query: q, fuzziness: "AUTO", boost: 4 } } },
            { match: { text: { query: q } } },
          ],
          minimum_should_match: 1,
          must_not: [{ term: { exclude_from_search: true } }],
          ...(category ? { filter: [{ term: { category: String(category).toLowerCase() } }] } : {}),
        },
      },
      _source: SOURCE_FIELDS,
    };
    const docs = await this.preferRemaster(await this.query(body));
    return docs.slice(0, limit).map(brief);
  }

  /* One entry's full text, by its id ("condition-58") or its address ("/Conditions.aspx?ID=58" or the full link). */
  async get(ref) {
    const r = String(ref).trim();
    const fields = [...SOURCE_FIELDS, "text"];
    let docs;
    const path = r.startsWith(AON_SITE) ? r.slice(AON_SITE.length) : r;
    if (path.startsWith("/")) docs = await this.query({ size: 1, query: { term: { url: path } }, _source: fields });
    else docs = await this.byIds([r], fields);
    if (!docs.length) return null;
    const [doc] = await this.preferRemaster(docs, fields);
    let text = String(doc.text ?? "").replace(/\s+/g, " ").trim();
    const truncated = text.length > this.maxTextChars || doc._cut === true;
    if (truncated) text = text.slice(0, this.maxTextChars) + " …";
    return { ...brief(doc), text, truncated };
  }
}

function brief(d) {
  return {
    id: d._id,
    name: d.name,
    category: d.category,
    level: d.level ?? undefined,
    url: d.url ? AON_SITE + d.url : undefined,
    source: d.primary_source ?? undefined,
    summary: d.summary ? String(d.summary).replace(/\s+/g, " ").trim() : undefined,
    oldName: d.oldName,
    legacy: Array.isArray(d.remaster_id) && d.remaster_id.length > 0 ? true : undefined,
  };
}
