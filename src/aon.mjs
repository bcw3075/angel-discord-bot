/* Archives of Nethys, through the public search index its own site uses (POST /aon/_search, anonymous, read-only).
   Every entry carries its full text and page address. Old (pre-Remaster) entries point to their replacement with
   `remaster_id`, so a search for "flat-footed" gives Off-Guard, noting the old name. Reprints are hidden with
   `exclude_from_search`. Results are cached, a named User-Agent is sent, and a question makes only a few requests. */
import fs from "node:fs";

export const AON_SEARCH = "https://elasticsearch.aonprd.com/aon/_search";
export const AON_SITE = "https://2e.aonprd.com";
const SOURCE_FIELDS = ["name", "category", "level", "url", "summary", "primary_source", "remaster_id", "legacy_id", "type", "rarity", "trait", "release_date"];

export class Aon {
  constructor({ userAgent, fetchImpl = fetch, cacheFile = null, ttlMs = 7 * 86400000, emptyTtlMs = 10 * 60000, maxEntries = 200, now = Date.now, maxTextChars = 8000, saveDelayMs = 3000, timeoutMs = 6000 } = {}) {
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.cacheFile = cacheFile;
    this.ttlMs = ttlMs;
    this.emptyTtlMs = emptyTtlMs;
    this.timeoutMs = timeoutMs;
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
    /* "nothing found" is believed for ten minutes only: an entry added since, or a bad moment at the index, must not
       hide a rule for a week */
    if (hit && Array.isArray(hit.data) && this.now() - hit.at < (hit.data.length ? this.ttlMs : this.emptyTtlMs)) return hit.data;
    this.requests++;
    const res = await this.fetch(AON_SEARCH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": this.userAgent },
      body: key,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Archives of Nethys answered ${res.status}`);
    const json = await res.json();
    /* an answer the index itself calls partial (it ran out of time, or part of it failed) is not an answer: it would
       read as "no such rule", and cached it would stay that way */
    if (json?.timed_out === true || json?._shards?.failed > 0 || !Array.isArray(json?.hits?.hits)) throw new Error("Archives of Nethys gave an incomplete answer");
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
    if (!this.cacheFile) return;
    clearTimeout(this.saveTimer);
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

  /* `withText` entries from the top come with their full text (one more small request, about 50 ms): rules entries
     are short, and with the text already there Angel can usually answer without a second round of looking up, which
     costs seconds. An entry whose name is exactly what was searched for goes first: the index ranks "3D Flanking"
     above "Flanking" for "flanking". Text over `searchTextChars` is cut and marked, and aon_get gives the rest. */
  async search(query, { category = null, limit = 6, withText = 0, searchTextChars = 3000 } = {}) {
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
    const want = plainName(q);
    /* an old entry is never moved up for its name: "attack of opportunity" must still give Reactive Strike first */
    const exact = d => !preRemaster(d) && (plainName(d.name) === want || (d.oldName && plainName(d.oldName) === want));
    const top = newestPrintingFirst([...docs.filter(exact), ...docs.filter(d => !exact(d))]).slice(0, limit);
    const out = top.map(brief);
    /* the text goes to the first `withText` different entries: a variant of one already chosen (the same name and
       kind again) would only repeat it */
    const chosen = new Set(), ids = [];
    for (const d of top) {
      const key = `${plainName(d.name)}|${d.category ?? ""}|${d.primary_source ?? ""}`;
      if (ids.length >= Math.max(0, withText) || chosen.has(key)) continue;
      chosen.add(key);
      ids.push(d._id);
    }
    if (ids.length) {
      /* a failure here only costs the shortcut: the entries are still listed and aon_get still works */
      let full = [];
      try { full = await this.byIds(ids, [...SOURCE_FIELDS, "text"]); } catch { /* listed without text */ }
      const byId = new Map(full.map(d => [d._id, d]));
      for (const entry of out) {
        const d = byId.get(entry.id);
        if (typeof d?.text !== "string") continue;
        const text = d.text.replace(/\s+/g, " ").trim();
        entry.text = text.length > searchTextChars ? text.slice(0, searchTextChars) + " …" : text;
        if (text.length > searchTextChars || d._cut === true) entry.truncated = true;
      }
    }
    return out;
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

/* Player Core and GM Core came out in November 2023: an entry dated before that is from before the Remaster. Many
   such entries are still the rule (nothing replaced them), so they are only marked, never hidden. */
const REMASTER_FROM = "2023-11-01";
const preRemaster = d => typeof d.release_date === "string" && d.release_date < REMASTER_FROM;

/* Some old entries have no link to their Remaster version (Retributive Strike: the Core Rulebook's is listed beside
   Player Core 2's, and the index ranks the old one first; they differ). Among entries of the same name and kind, the
   ones from before the Remaster go after the ones since and are marked `older`, so the old text is never read as
   the rule by accident. Entries since the Remaster keep the index's order among themselves: the same name can be
   different things there (a general feat and a class's own version). */
function newestPrintingFirst(docs) {
  const groups = new Map();
  const keyOf = d => `${plainName(d.name)}|${d.category ?? ""}`;
  for (const d of docs) {
    if (!groups.has(keyOf(d))) groups.set(keyOf(d), []);
    groups.get(keyOf(d)).push(d);
  }
  const out = [];
  const done = new Set();
  for (const d of docs) {
    const key = keyOf(d);
    if (done.has(key)) continue;
    done.add(key);
    const group = groups.get(key);
    const since = group.filter(g => g.release_date && !preRemaster(g));
    if (!since.length) { out.push(...group); continue; }
    out.push(...group.filter(g => !preRemaster(g)), ...group.filter(preRemaster).map(g => ({ ...g, older: true })));
  }
  return out;
}

/* a name as people and the model write it: lower case, letters and digits only ("Off-Guard" = "off guard") */
function plainName(s) {
  let out = "";
  for (const c of String(s ?? "").toLowerCase()) if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) out += c;
  return out;
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
    older: d.older === true ? true : undefined,
    preRemaster: preRemaster(d) ? true : undefined,
    released: d.release_date ? String(d.release_date).slice(0, 4) : undefined,
  };
}
