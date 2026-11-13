/* Speech to text: Deepgram Nova-3, pre-recorded (one request per piece of speech, billed per second).
   Key terms (the table's names, from keyterms.txt) help it spell them right. */

export const DEEPGRAM = "https://api.deepgram.com";

/* Deepgram explains a refusal in JSON ({"err_msg": ...}): keep the words, not the braces */
export async function deepgramError(what, res) {
  const body = await res.text();
  let why = body;
  try { const j = JSON.parse(body); why = j.err_msg || j.message || j.reason || body; } catch { /* plain text */ }
  return new Error(`Deepgram ${what} answered ${res.status}: ${String(why).slice(0, 300)}`);
}

export async function transcribe(wav, { apiKey, model = "nova-3", keyterms = [], fetchImpl = fetch, timeoutMs = 20000 }) {
  const params = new URLSearchParams({ model, language: "en", smart_format: "true", punctuate: "true" });
  for (const term of keyterms) params.append("keyterm", term);
  const res = await fetchImpl(`${DEEPGRAM}/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
    body: wav,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await deepgramError("listen", res);
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  return {
    text: (alt?.transcript ?? "").trim(),
    confidence: alt?.confidence ?? 0,
    seconds: Number(json?.metadata?.duration ?? 0),
  };
}
