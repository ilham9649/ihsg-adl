// Helpers every section shares: reading the API, the header's freshness
// pill, and the small number formatters.

export const API_BASE = window.location.origin;

// The API answers in either the HTTP API v2 shape or the REST v1 shape, which
// double-wraps the body (see backend/index.js).
export async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const json = await res.json();
  return json.body && json.statusCode ? JSON.parse(json.body) : json;
}

// Calendar days between a YYYY-MM-DD date and today, in Jakarta time — the
// clock every job files its dates in.
export function ageInDays(date) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  return Math.round((Date.parse(today) - Date.parse(date)) / 864e5);
}

export const longDate = (ds, opts = {}) => new Date(ds + 'T00:00:00Z').toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts });

// The header pill: green when the data is current, red once it is older than
// `staleAfter` days (long enough to cover a weekend or a holiday).
export function setFreshness(date, { staleAfter = 4, label = 'Data' } = {}) {
  const el = document.getElementById('freshness');
  if (!el) return;
  if (!date) { el.textContent = 'No data'; el.dataset.state = ''; return; }
  const age = ageInDays(date);
  const stale = age > staleAfter;
  el.dataset.state = stale ? 'stale' : 'fresh';
  el.textContent = stale ? `${label} ${longDate(date)} · ${age}d old` : `${label} ${longDate(date)}`;
  el.title = stale ? `The latest reading is ${age} days old — it has stopped updating.` : 'Up to date';
}

export function setFreshnessError(message) {
  const el = document.getElementById('freshness');
  if (!el) return;
  el.dataset.state = 'stale';
  el.textContent = 'Offline';
  el.title = message;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// A tiny inline-SVG sparkline: one path, coloured by whether the last value
// sits above or below `ref`. Built with DOM calls, no markup strings.
const SVG = 'http://www.w3.org/2000/svg';
export function sparkline(svg, values, { ref = null } = {}) {
  const vals = values.filter(v => v != null);
  svg.replaceChildren();
  if (vals.length < 2) return;
  const w = 84, h = 30, pad = 2;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (ref != null) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = i => pad + i * (w - 2 * pad) / (vals.length - 1);
  const y = v => pad + (h - 2 * pad) * (hi - v) / (hi - lo);
  if (ref != null) {
    const base = document.createElementNS(SVG, 'line');
    base.setAttribute('x1', 0); base.setAttribute('x2', w);
    base.setAttribute('y1', y(ref)); base.setAttribute('y2', y(ref));
    base.setAttribute('stroke', 'rgba(26,23,20,.22)');
    base.setAttribute('stroke-dasharray', '2 2');
    base.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(base);
  }
  const last = vals[vals.length - 1];
  const up = ref != null ? last >= ref : last >= vals[0];
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', up ? '#2f6b4f' : '#b0392c');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(path);
  const dot = document.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', x(vals.length - 1)); dot.setAttribute('cy', y(last));
  dot.setAttribute('r', 2); dot.setAttribute('fill', up ? '#2f6b4f' : '#b0392c');
  svg.appendChild(dot);
}
