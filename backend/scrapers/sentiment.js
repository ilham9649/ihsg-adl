// ──────────────────────────────────────────────
// Market Sentiment (LLM-scored, from the day's news headlines)
// ──────────────────────────────────────────────
// Market-wide only — one reading per day, not per ticker (that's what the
// Valuation page is for). The news feed mixes real market items with unrelated
// stories (earthquakes, banking how-tos), so the prompt itself does the
// filtering: score what's relevant, ignore what isn't.
//
// Needs LLM_API_KEY in the Lambda environment — not provisioned by this
// repo. Until it's set, refreshSentiment() in index.js fails cleanly (no key,
// no write) rather than storing a bad reading.

const LLM_URL = 'https://api.deepseek.com/chat/completions'; // OpenAI-compatible
const LLM_MODEL = process.env.SENTIMENT_LLM_MODEL || 'deepseek-chat';

// Bounds the prompt's token cost. news.js now merges 3 sources sorted newest
// first, so this caps to the most recent items across all of them rather than
// one source's whole day.
const MAX_HEADLINES = 60;

export function buildPrompt(headlines) {
  const list = headlines
    .slice(0, MAX_HEADLINES)
    .map((h, i) => `${i + 1}. ${h.title}`)
    .join('\n');

  return `You are a financial market analyst. Below are today's Indonesian news headlines, each with a short summary, from general market/finance news feeds — some are about the stock market (IHSG / Jakarta Composite Index) and the economy, others are unrelated (natural disasters, consumer banking tips, retail promotions, etc).

${list}

Ignore the unrelated headlines. Rate overall MARKET-WIDE sentiment for the Indonesian stock market (IHSG) today, from -100 (extremely bearish/panic) to +100 (extremely bullish/euphoria), 0 = neutral.

Weigh the relevant headlines — do not treat them as equally important and average them:
- Market-wide news (IHSG index level or percentage moves, Bank Indonesia rate decisions, the rupiah, foreign fund inflows/outflows, major macro or political events) matters most.
- Sector-wide news matters more than a single company's news.
- A single stock's earnings, dividend, or corporate action matters least, unless it's large enough to move the whole index.
- Where a headline or summary states a specific magnitude (a percentage move, a Rupiah figure, a fund-flow amount), let that magnitude set how strongly it should pull the score — a small reported move should not swing the score as hard as a large one.

If none of the headlines are market-relevant, return a score of 0 and say so in the summary.

Respond with ONLY one JSON object, no markdown fences, no other text:
{"score": <integer -100 to 100>, "label": "<very bearish|bearish|neutral|bullish|very bullish>", "summary": "<one sentence, max 200 characters, explaining the reading>"}`;
}

async function callLLM(prompt) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('Sentiment scoring is not configured');

  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
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
  return json.choices?.[0]?.message?.content || '';
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
