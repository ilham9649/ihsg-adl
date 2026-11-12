// Cross-chart hover sync: every chart on a page shares one date index, so
// hovering one marks the same session on all the others.
// ── Cross-chart hover sync ──
// Every panel shares the same filtered data array, so a hovered position maps to
// the same index everywhere. Subscribers re-register on each renderAll.
export const HoverSync = {
  subs: [],
  reset() { this.subs = []; },
  register(sub) { this.subs.push(sub); return sub; },
  emit(i, src) { for (const s of this.subs) if (s !== src) s.show(i); },
  clear(src) { for (const s of this.subs) if (s !== src) s.hide(); },
};
export function linkBreadth(bc) {
  const sub = { show: (i) => bc.setHover(i), hide: () => bc.clearHover() };
  HoverSync.register(sub);
  bc.onHover = (i) => HoverSync.emit(i, sub);
  bc.onLeave = () => HoverSync.clear(sub);
}

