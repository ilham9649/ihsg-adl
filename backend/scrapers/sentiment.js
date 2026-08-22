// ──────────────────────────────────────────────
// Market Sentiment (LLM-scored, from the day's news headlines)
// ──────────────────────────────────────────────
// Market-wide only — one reading per day, not per ticker (that's what the
// Valuation page is for). The news feed mixes real market items with unrelated
// stories (earthquakes, banking how-tos), so the prompt itself does the
// filtering: score what's relevant, ignore what isn't.
//
// Needs ANTHROPIC_API_KEY in the Lambda environment — not provisioned by this
// repo. Until it's set, refreshSentiment() in index.js fails cleanly (no key,
// no write) rather than storing a bad reading.

const LLM_URL = 'https://api.anthropic.com/v1/messages';
const LLM_MODEL = process.env.SENTIMENT_LLM_MODEL || 'claude-haiku-4-5-20251001';

// Bounds the prompt's token cost; a single day's feed rarely runs this high anyway.
const MAX_HEADLINES = 40;

export function buildPrompt(headlines) {
  const list = headlines
    .slice(0, MAX_HEADLINES)
    .map((h, i) => `${i + 1}. ${h.title}`)
    .join('\n');

  return `You are a financial market analyst. Below are today's Indonesian news headlines from a general market news feed — some are about the stock market (IHSG / Jakarta Composite Index), others are unrelated (natural disasters, consumer banking tips, etc).

${list}

Ignoring the unrelated headlines, rate overall MARKET-WIDE sentiment for the Indonesian stock market today, from -100 (extremely bearish/panic) to +100 (extremely bullish/euphoria), 0 = neutral. If none of the headlines are market-relevant, return a score of 0 and say so in the summary.

Respond with ONLY one JSON object, no markdown fences, no other text:
{"score": <integer -100 to 100>, "label": "<very bearish|bearish|neutral|bullish|very bullish>", "summary": "<one sentence, max 200 characters, explaining the reading>"}`;
}

async function callLLM(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Sentiment scoring is not configured');

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    // The upstream body (and the exact env var name above) stay in CloudWatch
    // only — index.js's catch-all returns err.message straight to the caller,
    // and /api/sentiment/refresh has no auth, so neither should describe the
    // failure in enough detail to be useful to a stranger probing the endpoint.
    console.error(`LLM HTTP ${res.status}:`, (await res.text()).slice(0, 500));
    throw new Error('Sentiment scoring request failed');
  }

  const json = await res.json();
  return json.content?.[0]?.text || '';
}

/** Pure parser (exported for tests) — tolerates prose/fences around the JSON. */
export function parseScoreResponse(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try { obj = JSON.parse(match[0]); } catch { return null; }

  const score = Number(obj.score);
  if (!Number.isFinite(score)) return null;

  return {
    score: Math.max(-100, Math.min(100, Math.round(score))), // clamp — don't trust the model's range
    label: typeof obj.label === 'string' ? obj.label.slice(0, 32) : null,
    summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 300) : '',
  };
}

/** headlines -> { score, label, summary } | null. Throws on a real fetch/auth
 * failure (missing key, network, non-2xx); returns null only when the call
 * succeeded but the model's reply couldn't be parsed — a phantom reading in
 * the time series is worse than a skipped day. */
export async function scoreSentiment(headlines) {
  if (headlines.length === 0) return null;
  const raw = await callLLM(buildPrompt(headlines));
  const parsed = parseScoreResponse(raw);
  if (!parsed) console.error('Sentiment: unparseable LLM response:', raw.slice(0, 300));
  return parsed;
}
