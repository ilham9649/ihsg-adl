// One data table, used by every ranking and record on the site.
//
// A column spec drives the heading, its tooltip and the cell, so the three can
// never drift apart, and a cell takes its alignment from the same `num` flag
// as its heading. Cells are set as text, never markup: tickers and company
// names come straight from Yahoo.
//
//   const t = dataTable({ table, cols, sort: { key, dir }, pageSize, count, more, noun });
//   t.render(rows)            // re-render, keeping the page the reader expanded to
//   t.render(rows, { reset }) // back to the first page (a filter changed)
//
// Column: { key?, head, desc, get(row) → text, cls?(row) → class, num?: false,
//           wide?: true, title?(row) → cell tooltip, sortValue?(row) }. A column with a key is sortable.

export function dataTable({ table, cols, sort = null, pageSize = 50, count = null, more = null, noun = ['row', 'rows'] }) {
  let rows = [];
  let limit = pageSize;
  let sortKey = sort?.key ?? null;
  let sortDir = sort?.dir ?? -1;

  const valueOf = (c, r) => c.sortValue ? c.sortValue(r) : r[c.key];

  const head = () => {
    const thead = table.tHead || table.createTHead();
    if (thead.rows.length) return;
    const tr = thead.insertRow();
    for (const c of cols) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = c.head;
      if (c.num !== false) th.classList.add('num');
      if (!c.key || !sort) { th.title = c.desc; th.style.cursor = 'help'; tr.appendChild(th); continue; }
      th.title = `${c.desc} — click to sort`;
      th.dataset.key = c.key;
      th.tabIndex = 0;
      const go = () => {
        // A new column starts largest-first; clicking again flips it.
        sortDir = sortKey === c.key ? -sortDir : -1;
        sortKey = c.key;
        draw();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      tr.appendChild(th);
    }
  };

  const sorted = () => {
    const c = cols.find(col => col.key === sortKey);
    if (!c) return rows;
    return rows.slice().sort((a, b) => {
      const x = valueOf(c, a), y = valueOf(c, b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // blanks last
      return x > y ? sortDir : x < y ? -sortDir : 0;
    });
  };

  const plural = n => `${n.toLocaleString('en-US')} ${n === 1 ? noun[0] : noun[1]}`;

  function draw() {
    head();
    const all = sorted();
    const shown = all.slice(0, limit);
    const frag = document.createDocumentFragment();
    for (const r of shown) {
      const tr = document.createElement('tr');
      for (const c of cols) {
        const td = document.createElement('td');
        const cls = c.cls ? c.cls(r) : null;
        if (cls) td.className = cls;
        if (c.num !== false) td.classList.add('num');
        if (c.wide) td.classList.add('td-wide');
        td.textContent = c.get(r);
        if (c.title) td.title = c.title(r);
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    (table.tBodies[0] || table.createTBody()).replaceChildren(frag);
    table.querySelectorAll('thead th[data-key]').forEach(th => {
      const on = th.dataset.key === sortKey;
      th.dataset.sorted = on ? (sortDir === 1 ? 'asc' : 'desc') : '';
      th.setAttribute('aria-sort', on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    });
    if (more) {
      more.hidden = shown.length >= all.length;
      more.textContent = `Show all ${plural(all.length)}`;
    }
    if (count) {
      count.textContent = shown.length < all.length
        ? `${shown.length.toLocaleString('en-US')} of ${plural(all.length)}`
        : plural(all.length);
    }
  }

  more?.addEventListener('click', () => { limit = Infinity; draw(); });

  return {
    render(next, { reset = false } = {}) {
      rows = next;
      if (reset) limit = pageSize;
      draw();
    },
  };
}
