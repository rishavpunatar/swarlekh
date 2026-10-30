/* SwarLekh — label placement for the pitch contour. Pure and DOM-free, so
 * the drawing rules can be tested in Node (tests/contour-layout.test.js).
 *
 *   ContourLayout.placeLabels(items, opts) -> placements
 *     items: [{ text, cx, cy, big }] in priority order (most important first)
 *     opts:  { measure(text, size, big) -> px width, bounds: { x0, y0, x1, y1 },
 *              force: bool, minLane: px }
 *   Each placement: { item, x, y, size, box: [x0, y0, x1, y1], forced, skipped }
 *
 * A name sits beside its dot (above first when there is room, else below),
 * shrinking from its preferred size down to 7px to find a free lane. When no
 * lane is free: with `force` it is drawn anyway at 7px (every note named,
 * the normal view); without it, it is skipped and the dot alone marks the
 * note (zoomed far out, where overlapping 7px text is unreadable). Labels are
 * always kept inside `bounds`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ContourLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BIG_SIZES = [13, 11, 9.5, 8, 7];
  const SMALL_SIZES = [11, 9.5, 8, 7];

  function overlaps(a, b) {
    return a[0] < b[2] + 1 && a[2] > b[0] - 1 && a[1] < b[3] + 1 && a[3] > b[1] - 1;
  }

  function clampBox(cx, cy, w, h, bounds) {
    const x = Math.max(bounds.x0 + w / 2, Math.min(bounds.x1 - w / 2, cx));
    const y = Math.max(bounds.y0 + h / 2, Math.min(bounds.y1 - h / 2, cy));
    return { x, y, box: [x - w / 2, y - h / 2, x + w / 2, y + h / 2] };
  }

  function placeLabels(items, opts) {
    const bounds = opts.bounds;
    const placed = [];
    const out = [];
    const free = (box) => !placed.some((b) => overlaps(box, b));
    for (const item of items) {
      const sizes = item.big ? BIG_SIZES : SMALL_SIZES;
      const aboveFirst = item.cy > bounds.y0 + 46;
      let found = null;
      for (const size of sizes) {
        const w = opts.measure(item.text, size, item.big) + 3, h = size + 3, base = h / 2 + 3;
        const offsets = aboveFirst ? [-base, base, -(base + 13), base + 13] : [base, -base, base + 13, -(base + 13)];
        for (const dy of offsets) {
          const c = clampBox(item.cx, item.cy + dy, w, h, bounds);
          if (free(c.box)) { found = { x: c.x, y: c.y, size, box: c.box }; break; }
        }
        if (found) break;
      }
      if (!found) {
        if (!opts.force) { out.push({ item, skipped: true }); continue; }
        const size = 7, w = opts.measure(item.text, size, item.big) + 3, h = size + 3;
        const c = clampBox(item.cx, item.cy - (h / 2 + 3), w, h, bounds);
        found = { x: c.x, y: c.y, size, box: c.box, forced: true };
      }
      placed.push(found.box);
      out.push(Object.assign({ item, skipped: false, forced: false }, found));
    }
    return out;
  }

  return { placeLabels, overlaps };
}));
