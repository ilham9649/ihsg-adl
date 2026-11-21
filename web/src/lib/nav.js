// ──────────────────────────────────────────────
// Section nav on a phone: it scrolls sideways, so the current section can sit
// off-screen. Centre it on load, and mark which edges have more behind them
// (the CSS fades those edges). Does nothing when the nav fits.
// ──────────────────────────────────────────────
const nav = document.querySelector('.site-nav');
if (nav) {
  const edges = () => {
    const more = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('more-left', more > 2 && nav.scrollLeft > 2);
    nav.classList.toggle('more-right', more > 2 && nav.scrollLeft < more - 2);
  };
  const current = nav.querySelector('[aria-current="page"]');
  if (current && nav.scrollWidth > nav.clientWidth) {
    const a = current.getBoundingClientRect(), n = nav.getBoundingClientRect();
    nav.scrollLeft += (a.left + a.width / 2) - (n.left + n.width / 2);
  }
  edges();
  nav.addEventListener('scroll', edges, { passive: true });
  window.addEventListener('resize', edges);
}
